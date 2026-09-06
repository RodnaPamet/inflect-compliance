/**
 * Job Executor Registry — Typed Job Dispatch
 *
 * Provides a central, type-safe registry that maps job names to their
 * executor functions. This decouples job *dispatch* from job *scheduling*,
 * allowing any entrypoint (BullMQ worker, Vercel Cron route, node-cron,
 * CLI scripts) to execute jobs through one unified interface.
 *
 * Architecture:
 *   ┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
 *   │ BullMQ      │────▶│                  │────▶│ automation   │
 *   │ Worker      │     │  ExecutorRegistry │     │ runner       │
 *   ├─────────────┤     │                  │     ├──────────────┤
 *   │ Vercel Cron │────▶│  .execute(name,  │────▶│ evidence     │
 *   │ Route       │     │    payload)       │     │ expiry       │
 *   ├─────────────┤     │                  │     ├──────────────┤
 *   │ node-cron   │────▶│  .getExecutor()  │────▶│ retention    │
 *   │ Scheduler   │     │  .listRegistered()│    │ sweep        │
 *   └─────────────┘     └──────────────────┘     └──────────────┘
 *
 * Usage:
 *   import { executorRegistry } from '@/app-layer/jobs/executor-registry';
 *   const result = await executorRegistry.execute('vendor-renewal-check', {});
 *
 * Adding new jobs:
 *   1. Define payload in types.ts (JobPayloadMap)
 *   2. Create job module (e.g. vendor-renewal-check.ts)
 *   3. Register executor below
 *
 * @module app-layer/jobs/executor-registry
 */
import { logger } from '@/lib/observability/logger';
import { recordJobMetrics } from '@/lib/observability/metrics';
import { env } from '@/env';
import {
    shouldBypassQueueRetry,
    IntegrationRateLimitedError,
} from '@/app-layer/integrations/http-resilience';
import { recordQueueRetryBypass } from '@/lib/observability/integration-metrics';
import type { JobName, JobPayload, JobRunResult } from './types';

// ─── Executor Contract ──────────────────────────────────────────────

/**
 * Optional context the worker passes to executors that benefit from
 * mid-run observability hooks. Today only `updateProgress` is wired —
 * forwarded by the BullMQ worker as `(p) => job.updateProgress(p)`.
 * The Vercel Cron / node-cron / CLI entrypoints don't supply this
 * (they run outside a BullMQ Job), so executors must treat the
 * callbacks as optional and degrade gracefully when absent.
 *
 * Payload shape is intentionally `unknown` — each executor designs
 * its own progress JSON. The shape MUST NOT carry secrets, raw
 * keys, or anything sensitive: it's surfaced via the public job-
 * status endpoints.
 */
export interface JobExecutorContext {
    /**
     * Report mid-run progress. Called per meaningful boundary
     * (typically per batch / per phase). The callback awaits the
     * underlying transport (BullMQ -> Redis); executors should
     * `await` it so the GET status endpoint sees the latest value
     * immediately.
     */
    updateProgress?: (progress: unknown) => Promise<void>;
}

/**
 * A job executor function.
 *
 * Takes a typed payload and returns a `JobRunResult`.
 * Executors are responsible for:
 *   - Performing the job's business logic
 *   - Using `runJob()` for observability
 *   - Returning a consistent `JobRunResult`
 *   - NOT catching errors (let the registry handle fault isolation)
 *
 * The optional `ctx` argument carries worker-injected hooks (e.g.
 * BullMQ progress reporting). Executors that don't need it can
 * ignore it; entrypoints that don't supply it (cron, CLI) pass
 * nothing.
 */
export type JobExecutor<T extends JobName> = (
    payload: JobPayload<T>,
    ctx?: JobExecutorContext,
) => Promise<JobRunResult>;

// ─── Registry Implementation ────────────────────────────────────────

/**
 * Internal storage for registered executors.
 * Uses `Map` for O(1) lookup and safe iteration.
 */
/**
 * Storage type for the heterogeneous registry. A `Map` value cannot
 * preserve the per-job `JobExecutor<T>` relationship: function params
 * are contravariant, so a concrete `JobExecutor<'somejob'>` is NOT
 * assignable to `JobExecutor<JobName>` (it can't accept the full
 * payload union). We erase the payload to `never` on store — every
 * concrete `JobExecutor<T>` IS assignable to `JobExecutor<never>`
 * (a bottom param accepts any specific argument) — and re-narrow with
 * a cast on retrieval in `execute`, where the `name: T` argument makes
 * the `JobExecutor<T>` target sound.
 */
type StoredExecutor = JobExecutor<never>;
const executors = new Map<string, StoredExecutor>();

/**
 * The executor registry — singleton service.
 *
 * Thread-safe in Node.js (single-threaded). Registry mutations
 * (register) should only happen at module load time.
 */
export const executorRegistry = {
    /**
     * Register a job executor.
     *
     * @param name — job name (must match a key in JobPayloadMap)
     * @param executor — async function that processes the job
     * @throws if a duplicate registration is attempted
     */
    register<T extends JobName>(name: T, executor: JobExecutor<T>): void {
        if (executors.has(name)) {
            throw new Error(
                `Duplicate executor registration for job "${name}". ` +
                `Each job must have exactly one executor.`,
            );
        }
        executors.set(name, executor);
        logger.debug('executor registered', {
            component: 'executor-registry',
            jobName: name,
        });
    },

    /**
     * Execute a job by name with fault isolation.
     *
     * If the executor throws, the error is caught, logged, and
     * a failure `JobRunResult` is returned. One failing job
     * never crashes the scheduler or other jobs.
     *
     * @param name — job name
     * @param payload — typed payload
     * @param ctx — optional hooks (e.g. BullMQ progress callback)
     *   forwarded by the worker. Cron / CLI entrypoints leave this
     *   unset; executors that need progress must guard the calls.
     * @returns JobRunResult (always — never throws)
     */
    async execute<T extends JobName>(
        name: T,
        payload: JobPayload<T>,
        ctx?: JobExecutorContext,
    ): Promise<JobRunResult> {
        // Re-narrow the payload-erased StoredExecutor back to this job's
        // concrete executor — sound because `name: T` keys the lookup.
        const executor = executors.get(name) as JobExecutor<T> | undefined;
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const jobRunId = crypto.randomUUID();

        if (!executor) {
            logger.error('no executor registered for job', {
                component: 'executor-registry',
                jobName: name,
            });
            return {
                jobName: name,
                jobRunId,
                success: false,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs: 0,
                itemsScanned: 0,
                itemsActioned: 0,
                itemsSkipped: 0,
                errorMessage: `No executor registered for job "${name}"`,
            };
        }

        try {
            const result = await executor(payload, ctx);
            // ── Record job success metric ──
            recordJobMetrics({
                jobName: name,
                success: result.success,
                durationMs: result.durationMs ?? Math.round(performance.now() - startMs),
            });
            return result;
        } catch (error) {
            const durationMs = Math.round(performance.now() - startMs);
            const errorMessage = error instanceof Error
                ? error.message
                : String(error);

            logger.error('job executor threw', {
                component: 'executor-registry',
                jobName: name,
                jobRunId,
                durationMs,
                error: errorMessage,
            });

            // ── Record job failure metric ──
            recordJobMetrics({ jobName: name, success: false, durationMs });

            const bypass = shouldBypassQueueRetry(error);
            if (bypass) {
                // Counted separately from the failure itself: "a sync failed"
                // and "a sync failed AND we declined to retry it" are different
                // operational facts, and a classifier bug shows up here as a
                // suppression rate that does not match the failure mix.
                recordQueueRetryBypass({
                    jobName: name,
                    reason:
                        error instanceof IntegrationRateLimitedError
                            ? 'rate_limited'
                            : 'terminal',
                });
            }

            // Every executor throw funnels through here, so this is the one
            // place that has to decide whether BullMQ should immediately re-run
            // the job. A revoked credential or a long throttle must not be
            // answered with three more attempts in 35 seconds — see
            // `shouldBypassQueueRetry`. The job still FAILS; only the immediate
            // retry is suppressed.
            return {
                jobName: name,
                jobRunId,
                success: false,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs,
                itemsScanned: 0,
                itemsActioned: 0,
                itemsSkipped: 0,
                errorMessage,
                ...(bypass ? { noRetry: true } : {}),
            };
        }
    },

    /**
     * Get the executor for a job name (or undefined).
     * Useful for the BullMQ worker to check registration before dispatch.
     */
    getExecutor<T extends JobName>(name: T): JobExecutor<T> | undefined {
        return executors.get(name) as JobExecutor<T> | undefined;
    },

    /**
     * Check if an executor is registered for a job name.
     */
    has(name: string): boolean {
        return executors.has(name);
    },

    /**
     * List all registered job names.
     */
    listRegistered(): string[] {
        return Array.from(executors.keys());
    },

    /**
     * Total number of registered executors.
     */
    get size(): number {
        return executors.size;
    },

    /**
     * Clear all registrations. **Test-only.**
     * @internal
     */
    _reset(): void {
        executors.clear();
    },
};

// ─── Default Registrations ──────────────────────────────────────────
//
// Each registration uses dynamic import so that heavy modules
// (Prisma, integration SDK, etc.) are only loaded when the job
// actually executes — not at registry import time.
// ─────────────────────────────────────────────────────────────────────

/**
 * Helper: create a normalized JobRunResult from a legacy job's
 * ad-hoc return shape. Jobs that already return JobRunResult
 * should be registered directly.
 */
function makeResult(
    jobName: string,
    startedAt: string,
    startMs: number,
    scanned: number,
    actioned: number,
    skipped: number,
    details?: Record<string, unknown>,
    outcome?: JobOutcome,
): JobRunResult {
    return {
        jobName,
        jobRunId: crypto.randomUUID(),
        success: outcome ? outcome.status !== 'ERROR' : true,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - startMs),
        itemsScanned: scanned,
        itemsActioned: actioned,
        itemsSkipped: skipped,
        details,
        ...(outcome?.errorMessage && outcome.status === 'ERROR'
            ? { errorMessage: outcome.errorMessage }
            : {}),
        ...(outcome?.noRetry ? { noRetry: true } : {}),
    };
}

/**
 * The outcome an integration usecase reports back, for jobs that CATCH their
 * own failures instead of throwing.
 *
 * Those usecases return `status: 'ERROR'` in a result object, so before this
 * existed `makeResult` hardcoded `success: true` and a sync that failed
 * completely — revoked credential, dead network — was recorded by the queue as
 * a success. Job metrics, alerting and the BullMQ failed set all read clean.
 *
 * ## `status !== 'ERROR'`, never `status === 'PASSED'`
 *
 * The posture usecases report four statuses, and `FAILED` means *the compliance
 * check found a real gap* — a perfectly successful collection. Treating that as
 * a job failure would turn every tenant's genuine findings into retried job
 * failures, which is a worse bug than the one being fixed. Only `ERROR` means
 * the job itself broke.
 *
 * `PARTIAL` (H3-2) is likewise a success: a directory over MAX_USERS is synced
 * across several runs, and each run that stores a cursor and stops has done
 * exactly what it should. Reporting it as a failure would page someone nightly
 * for a large directory working as designed.
 */
interface JobOutcome {
    status: 'PASSED' | 'FAILED' | 'ERROR' | 'NOT_APPLICABLE' | 'SKIPPED' | 'PARTIAL';
    errorMessage?: string;
    noRetry?: boolean;
}

// ── health-check ─────────────────────────────────────────────────────

executorRegistry.register('health-check', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    return makeResult('health-check', startedAt, startMs, 0, 0, 0, {
        enqueuedAt: payload.enqueuedAt,
        message: payload.message ?? 'pong',
        processedAt: new Date().toISOString(),
    });
});

// ── nvd-cve-sync ─────────────────────────────────────────────────────

executorRegistry.register('nvd-cve-sync', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runNvdCveSync } = await import('./nvd-cve-sync');
    const r = await runNvdCveSync(payload);
    return makeResult('nvd-cve-sync', startedAt, startMs, r.fetched, r.upserted, 0, {
        skipped: r.skipped,
        fetched: r.fetched,
        upserted: r.upserted,
        matched: r.matched,
        windowStart: r.windowStart,
        windowEnd: r.windowEnd,
    });
});

// ── automation-runner ────────────────────────────────────────────────

executorRegistry.register('automation-runner', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runScheduledAutomations } = await import('./automation-runner');
    const r = await runScheduledAutomations({
        tenantId: payload.tenantId,
        dryRun: payload.dryRun,
    });
    return makeResult(
        'automation-runner', startedAt, startMs,
        r.totalDue, r.executed, r.skipped,
        { passed: r.passed, failed: r.failed, errors: r.errors, dryRun: r.dryRun },
    );
});

// ── daily-evidence-expiry ────────────────────────────────────────────

executorRegistry.register('daily-evidence-expiry', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runDailyEvidenceExpiryNotifications } = await import('./dailyEvidenceExpiry');
    const r = await runDailyEvidenceExpiryNotifications({
        tenantId: payload.tenantId,
        skipOutbox: payload.skipOutbox,
    });
    const totalCreated = r.sweeps.days30.tasksCreated
        + r.sweeps.days7.tasksCreated + r.sweeps.days1.tasksCreated;
    const totalSkipped = r.sweeps.days30.skippedDuplicate
        + r.sweeps.days7.skippedDuplicate + r.sweeps.days1.skippedDuplicate;
    const totalScanned = r.sweeps.days30.scanned
        + r.sweeps.days7.scanned + r.sweeps.days1.scanned;
    return makeResult(
        'daily-evidence-expiry', startedAt, startMs,
        totalScanned, totalCreated, totalSkipped,
        { sweeps: r.sweeps, outbox: r.outbox },
    );
});

// ── data-lifecycle ───────────────────────────────────────────────────

executorRegistry.register('data-lifecycle', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const {
        purgeSoftDeletedOlderThan,
        purgeExpiredEvidenceOlderThan,
        runRetentionSweep,
    } = await import('./data-lifecycle');

    const purgeResults = await purgeSoftDeletedOlderThan({
        tenantId: payload.tenantId,
        dryRun: payload.dryRun,
    });
    const evidencePurge = await purgeExpiredEvidenceOlderThan({
        tenantId: payload.tenantId,
        dryRun: payload.dryRun,
    });
    const retentionResults = await runRetentionSweep({
        tenantId: payload.tenantId,
        dryRun: payload.dryRun,
    });

    const totalScanned = purgeResults.reduce((s, r) => s + r.scanned, 0)
        + evidencePurge.scanned
        + retentionResults.reduce((s, r) => s + r.scanned, 0);
    const totalActioned = purgeResults.reduce((s, r) => s + r.purged, 0)
        + evidencePurge.purged
        + retentionResults.reduce((s, r) => s + r.expired, 0);

    return makeResult(
        'data-lifecycle', startedAt, startMs,
        totalScanned, totalActioned, 0,
        { purgeResults, evidencePurge, retentionResults },
    );
});

// ── policy-review-reminder ───────────────────────────────────────────

executorRegistry.register('policy-review-reminder', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { processOverdueReminders } = await import('./policyReviewReminder');
    const { prisma } = await import('@/lib/prisma');
    const r = await processOverdueReminders(prisma, { tenantId: payload.tenantId });
    return makeResult(
        'policy-review-reminder', startedAt, startMs,
        r.processed, r.processed, 0,
        { policies: r.policies },
    );
});

// ── access-review-reminder (Epic G-4) ───────────────────────────────

executorRegistry.register('access-review-reminder', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { processAccessReviewReminders } = await import(
        './access-review-reminder'
    );
    const { prisma } = await import('@/lib/prisma');
    const r = await processAccessReviewReminders(prisma, {
        tenantId: payload.tenantId,
    });
    return makeResult(
        'access-review-reminder',
        startedAt,
        startMs,
        r.scanned,
        r.enqueued,
        0,
        {
            skippedDuplicate: r.skippedDuplicate,
            skippedNoEmail: r.skippedNoEmail,
            skippedComplete: r.skippedComplete,
        },
    );
});

// ── access-review-overdue-escalation (Audit Coherence S7) ───────────

executorRegistry.register('access-review-overdue-escalation', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { processAccessReviewOverdueEscalation } = await import(
        './access-review-overdue-escalation'
    );
    const { prisma } = await import('@/lib/prisma');
    const r = await processAccessReviewOverdueEscalation(prisma, {
        tenantId: payload.tenantId,
    });
    return makeResult(
        'access-review-overdue-escalation',
        startedAt,
        startMs,
        r.scanned,
        r.enqueued,
        0,
        {
            skippedDuplicate: r.skippedDuplicate,
            skippedNoAdminEmail: r.skippedNoAdminEmail,
            skippedComplete: r.skippedComplete,
        },
    );
});

// ── exception-expiry-monitor (Epic G-5) ─────────────────────────────

executorRegistry.register('exception-expiry-monitor', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runExceptionExpiryMonitor } = await import(
        './exception-expiry-monitor'
    );
    const { prisma } = await import('@/lib/prisma');
    const r = await runExceptionExpiryMonitor(prisma, {
        tenantId: payload.tenantId,
    });
    return makeResult(
        'exception-expiry-monitor',
        startedAt,
        startMs,
        r.scanned,
        r.enqueued,
        0,
        {
            skippedDuplicate: r.skippedDuplicate,
            skippedNoEmail: r.skippedNoEmail,
            skippedNoRecipient: r.skippedNoRecipient,
        },
    );
});

// ── task-due-notification ───────────────────────────────────────────

executorRegistry.register('task-due-notification', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { processTaskDueNotifications } = await import(
        './task-due-notification'
    );
    const { prisma } = await import('@/lib/prisma');
    const r = await processTaskDueNotifications(prisma, {
        tenantId: payload.tenantId,
        tz: env.NOTIFICATIONS_TZ,
    });
    return makeResult(
        'task-due-notification',
        startedAt,
        startMs,
        r.scanned,
        r.created,
        r.skippedDuplicate,
        { byWindow: r.byWindow },
    );
});

// ── retention-sweep ──────────────────────────────────────────────────

executorRegistry.register('retention-sweep', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runEvidenceRetentionSweep } = await import('./retention');
    const r = await runEvidenceRetentionSweep({
        tenantId: payload.tenantId,
        dryRun: payload.dryRun,
    });
    return makeResult(
        'retention-sweep', startedAt, startMs,
        r.scanned, r.archived, 0,
        { expired: r.expired, dryRun: r.dryRun },
    );
});

// ── vendor-renewal-check ─────────────────────────────────────────────

executorRegistry.register('vendor-renewal-check', async (payload) => {
    const { runVendorRenewalCheck } = await import('./vendor-renewal-check');
    const { result } = await runVendorRenewalCheck({ tenantId: payload.tenantId });
    return result;
});

// ── vendor-monitoring ────────────────────────────────────────────────

executorRegistry.register('vendor-monitoring', async (payload) => {
    const { runVendorMonitoringJob } = await import('./vendor-monitoring');
    const { result } = await runVendorMonitoringJob({ tenantId: payload.tenantId, vendorId: payload.vendorId });
    return result;
});

// ── deadline-monitor ─────────────────────────────────────────────────

executorRegistry.register('deadline-monitor', async (payload) => {
    const { runDeadlineMonitor } = await import('./deadline-monitor');
    const { result } = await runDeadlineMonitor({
        tenantId: payload.tenantId,
        windows: payload.windows,
    });
    return result;
});

// ── evidence-expiry-monitor ──────────────────────────────────────────

executorRegistry.register('evidence-expiry-monitor', async (payload) => {
    const { runEvidenceExpiryMonitor } = await import('./evidence-expiry-monitor');
    const { result } = await runEvidenceExpiryMonitor({
        tenantId: payload.tenantId,
        windows: payload.windows,
    });
    return result;
});

// ── evidence-stale-review-sweep ──────────────────────────────────────
//
// Scheduled at 06:30 UTC, thirty minutes BEFORE `notification-dispatch`.
// That ordering is the point: the sweep flips past-due APPROVED evidence to
// NEEDS_REVIEW, and the 07:00 dispatch is what tells the owner. Run it after,
// and every owner learns a day late.

executorRegistry.register('evidence-stale-review-sweep', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runEvidenceStaleReviewSweep } = await import(
        '@/app-layer/usecases/evidence-stale-review-sweep'
    );
    const result = await runEvidenceStaleReviewSweep({ tenantId: payload.tenantId });
    return makeResult(
        'evidence-stale-review-sweep', startedAt, startMs,
        result.transitioned, result.transitioned, 0,
        { transitioned: result.transitioned },
    );
});

// ── notification-dispatch ────────────────────────────────────────────

executorRegistry.register('notification-dispatch', async (payload) => {
    const { runNotificationDispatch } = await import('./notification-dispatch');
    const { result } = await runNotificationDispatch({
        tenantId: payload.tenantId,
        categories: payload.categories,
        windows: payload.windows,
    });
    return result;
});

// ── sync-pull ────────────────────────────────────────────────────────

executorRegistry.register('sync-pull', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runSyncPull } = await import('./sync-pull');
    await runSyncPull(payload);
    return makeResult('sync-pull', startedAt, startMs, 1, 1, 0, {
        provider: payload.mappingKey.provider,
        remoteEntityType: payload.mappingKey.remoteEntityType,
    });
});

// ── compliance-snapshot ──────────────────────────────────────────────

executorRegistry.register('compliance-snapshot', async (payload) => {
    const { runSnapshotJob } = await import('./snapshot');
    const { result } = await runSnapshotJob({
        tenantId: payload.tenantId,
        date: payload.date ? new Date(payload.date) : undefined,
    });
    return result;
});

// ── sla-monitor (Automation Epic 5) ──────────────────────────────────

executorRegistry.register('sla-monitor', async (payload) => {
    const { runSlaMonitorJob } = await import('./sla-monitor');
    const { result } = await runSlaMonitorJob({ tenantId: payload.tenantId });
    return result;
});

// ── rule-chain-dispatch (Automation Epic 7) ──────────────────────────

executorRegistry.register('rule-chain-dispatch', async (payload) => {
    const { runRuleChainDispatch } = await import('./rule-chain-dispatch');
    // Tenant scope: payload.tenantId flows through to the chain dispatcher,
    // which scopes every query by it (and the chained execution rows).
    const { result } = await runRuleChainDispatch({ ...payload, tenantId: payload.tenantId });
    return result;
});

// ── subflow-dispatch (Visual Rule Editor VR-7) ───────────────────────
executorRegistry.register('subflow-dispatch', async (payload) => {
    const { runSubflowDispatch } = await import('./subflow-dispatcher');
    // Tenant scope: payload.tenantId scopes the entry-rule lookup + the child
    // execution rows.
    const { result } = await runSubflowDispatch({ ...payload, tenantId: payload.tenantId });
    return result;
});

// ── schedule-trigger-sweep (PR-E) ────────────────────────────────────
// Global sweep — scans every tenant's SCHEDULE rules and enqueues a
// per-(rule, entity) targeted dispatch (each scoped to the rule's tenantId
// inside runScheduleTriggerSweep + the dispatch it enqueues).
executorRegistry.register('schedule-trigger-sweep', async () => {
    const { runScheduleTriggerSweep } = await import('./schedule-trigger-sweep');
    const { result } = await runScheduleTriggerSweep(new Date());
    return result;
});

// ── compliance-digest ────────────────────────────────────────────────

executorRegistry.register('compliance-digest', async (payload) => {
    const { runComplianceDigest } = await import('./compliance-digest');
    const { result } = await runComplianceDigest({
        tenantId: payload.tenantId,
        recipientOverrides: payload.recipientOverrides,
        trendDays: payload.trendDays,
    });
    return result;
});

// ── key-rotation (Epic B.3) ──────────────────────────────────────────

executorRegistry.register('key-rotation', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runKeyRotation } = await import('./key-rotation');
    const r = await runKeyRotation({
        tenantId: payload.tenantId,
        initiatedByUserId: payload.initiatedByUserId,
        requestId: payload.requestId,
    });
    return makeResult(
        'key-rotation',
        startedAt,
        startMs,
        r.totalScanned,
        r.totalRewritten,
        0,
        {
            tenantId: r.tenantId,
            dekRewrapped: r.dekRewrapped,
            dekRewrapError: r.dekRewrapError,
            perField: r.perField,
            totalErrors: r.totalErrors,
            jobRunId: r.jobRunId,
        },
    );
});

// ── tenant-dek-rotation (Epic F.2 follow-up) ────────────────────────

executorRegistry.register('tenant-dek-rotation', async (payload, ctx) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runTenantDekRotation } = await import('./tenant-dek-rotation');
    const r = await runTenantDekRotation({
        tenantId: payload.tenantId,
        initiatedByUserId: payload.initiatedByUserId,
        requestId: payload.requestId,
        batchSize: payload.batchSize,
        // GAP-22: forward the worker's progress callback so the GET
        // /admin/tenant-dek-rotation status endpoint sees live
        // counters mid-rotation, not just empty progress until the
        // job completes.
        onProgress: ctx?.updateProgress,
    });
    return makeResult(
        'tenant-dek-rotation',
        startedAt,
        startMs,
        r.totalScanned,
        r.totalRewritten,
        r.totalSkipped,
        {
            tenantId: r.tenantId,
            previousEncryptedDekCleared: r.previousEncryptedDekCleared,
            perField: r.perField,
            totalErrors: r.totalErrors,
            jobRunId: r.jobRunId,
        },
    );
});

// ── automation-event-dispatch ────────────────────────────────────────
//
// One job invocation per domain event. Loads matching rules, evaluates
// filters, claims an AutomationExecution row per match, advances to
// SUCCEEDED/FAILED. See `automation-event-dispatch.ts` for the full
// flow + scope boundaries.

executorRegistry.register('automation-event-dispatch', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runAutomationEventDispatch } = await import(
        './automation-event-dispatch'
    );
    const r = await runAutomationEventDispatch(payload);
    return makeResult(
        'automation-event-dispatch',
        startedAt,
        startMs,
        r.rulesConsidered,
        r.executionsCreated,
        r.executionsSkippedDuplicate + r.executionsSkippedFilter,
        {
            tenantId: r.tenantId,
            event: r.event,
            rulesMatched: r.rulesMatched,
            executionsFailed: r.executionsFailed,
            jobRunId: r.jobRunId,
        }
    );
});

// ── control-test-scheduler + control-test-runner (Epic G-2) ──────────
//
// Scheduler claims due ControlTestPlan rows and enqueues per-plan
// runner jobs (deduplicated by `ctr:{planId}:{scheduledForIso}`).
// The runner materializes each into a ControlTestRun + auto-evidence
// + (on automated FAIL) a Finding linked to the control via the
// FindingEvidence → Evidence → controlId chain.

executorRegistry.register('control-test-scheduler', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runControlTestScheduler } = await import('./control-test-scheduler');
    const r = await runControlTestScheduler({
        tenantId: payload.tenantId,
        now: payload.nowIso ? new Date(payload.nowIso) : undefined,
        dryRun: payload.dryRun,
    });
    return makeResult(
        'control-test-scheduler',
        startedAt,
        startMs,
        r.totalDue,
        r.enqueued,
        r.skippedClaimRace +
            r.skippedInvalidSchedule +
            r.bootstrapped,
        {
            bootstrapped: r.bootstrapped,
            enqueued: r.enqueued,
            skippedClaimRace: r.skippedClaimRace,
            skippedInvalidSchedule: r.skippedInvalidSchedule,
            enqueueFailures: r.enqueueFailures,
            dryRun: r.dryRun,
            jobRunId: r.jobRunId,
        },
    );
});

executorRegistry.register('control-test-runner', async (payload) => {
    // tenantId scoping happens one frame down in `runControlTestRunner`:
    // it loads the plan via
    //   prisma.controlTestPlan.findFirst({ where: { id, tenantId: payload.tenantId } })
    // and every subsequent write goes through `runInTenantContext`
    // bound to that same tenantId. Referencing `payload.tenantId`
    // here documents the contract for the scope-audit ratchet.
    const { controlTestRunnerExecutor } = await import('./control-test-runner');
    return controlTestRunnerExecutor(payload);
});

// ── evidence-import (Epic 43.3) ──────────────────────────────────────
//
// One job invocation per uploaded ZIP. The HTTP layer stages the
// archive under `temp/<tenantId>/...` and enqueues this job; the
// worker streams the archive, runs the safety guards, and creates
// individual evidence rows via `uploadEvidenceFile`. See
// `evidence-import.ts` for the full safety bound + cleanup flow.

executorRegistry.register('evidence-import', async (payload, ctx) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runEvidenceImport } = await import('./evidence-import');
    const r = await runEvidenceImport(payload, async (progress) => {
        // Forward live counters to the BullMQ progress channel so the
        // GET /evidence/imports/:jobId status endpoint can show
        // mid-flight progress instead of waiting for completion.
        if (ctx?.updateProgress) {
            await ctx.updateProgress(progress);
        }
    });
    return makeResult(
        'evidence-import',
        startedAt,
        startMs,
        r.totalEntries,
        r.extracted,
        r.skipped + r.errored,
        {
            tenantId: r.tenantId,
            extracted: r.extracted,
            skipped: r.skipped,
            errored: r.errored,
            evidenceIds: r.evidenceIds,
            skipReasons: r.skipReasons,
            firstError: r.firstError,
            jobRunId: r.jobRunId,
        },
    );
});

// SP-3 — SharePoint delta sync (one connection).
executorRegistry.register('sharepoint-delta-sync', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runSharePointDeltaSyncJob } = await import('./sharepoint-delta-sync');
    const r = await runSharePointDeltaSyncJob(payload);
    return makeResult('sharepoint-delta-sync', startedAt, startMs, r.drivesSynced, r.reimported, r.staled, {
        tenantId: payload.tenantId,
        connectionId: payload.connectionId,
        reimported: r.reimported,
        staled: r.staled,
    });
});

// SP-3 — daily fan-out across all enabled SharePoint connections.
executorRegistry.register('sharepoint-delta-sync-dispatch', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runSharePointDeltaSyncDispatch } = await import('./sharepoint-delta-sync');
    const r = await runSharePointDeltaSyncDispatch(payload);
    return makeResult('sharepoint-delta-sync-dispatch', startedAt, startMs, r.connections, r.dispatched, 0, {
        connections: r.connections,
        dispatched: r.dispatched,
    });
});

// SP-4 — pull a changed policy from SharePoint (webhook-enqueued).
executorRegistry.register('sharepoint-policy-pull', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runSharePointPolicyPull } = await import('./sharepoint-policy-jobs');
    const r = await runSharePointPolicyPull(payload);
    return makeResult('sharepoint-policy-pull', startedAt, startMs, 1, r.pulled ? 1 : 0, r.pulled ? 0 : 1, {
        tenantId: payload.tenantId,
        policyId: payload.policyId,
        pulled: r.pulled,
    });
});

// SP-4 — daily renewal of all active policy Graph subscriptions.
executorRegistry.register('sharepoint-subscription-renew', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runSharePointSubscriptionRenew } = await import('./sharepoint-policy-jobs');
    const r = await runSharePointSubscriptionRenew(payload);
    return makeResult('sharepoint-subscription-renew', startedAt, startMs, r.subscriptions, r.renewed, 0, {
        subscriptions: r.subscriptions,
        renewed: r.renewed,
    });
});

// RQ-10 — daily cross-tenant scheduled-report delivery.
executorRegistry.register('report-delivery', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runReportDelivery } = await import('./report-delivery-jobs');
    const r = await runReportDelivery(payload);
    return makeResult('report-delivery', startedAt, startMs, r.due, r.generated, r.failed, {
        due: r.due, generated: r.generated, delivered: r.delivered, pushed: r.pushed, failed: r.failed,
    });
});

// RQ-2 — daily cross-tenant risk-appetite breach monitor.
executorRegistry.register('risk-appetite-monitor', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runRiskAppetiteMonitor } = await import('./risk-appetite-jobs');
    const r = await runRiskAppetiteMonitor(payload);
    return makeResult('risk-appetite-monitor', startedAt, startMs, r.scanned, r.newBreaches, 0, {
        tenants: r.tenants,
        scanned: r.scanned,
        newBreaches: r.newBreaches,
        resolved: r.resolved,
    });
});

// RQ-9 — daily cross-tenant risk + portfolio snapshot.
executorRegistry.register('risk-snapshot', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runRiskSnapshot } = await import('./risk-snapshot-jobs');
    const r = await runRiskSnapshot(payload);
    return makeResult('risk-snapshot', startedAt, startMs, r.scanned, r.riskSnapshots, 0, {
        tenants: r.tenants,
        scanned: r.scanned,
        riskSnapshots: r.riskSnapshots,
        pruned: r.pruned,
    });
});

// Business-KPI — 5-min cross-tenant DAU/MAU aggregation → gauge snapshot.
executorRegistry.register('dau-mau-aggregator', async () => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runDauMauAggregation } = await import('./dau-mau-aggregator');
    const r = await runDauMauAggregation();
    return makeResult('dau-mau-aggregator', startedAt, startMs, r.dailyTotal, r.monthlyTotal, 0, {
        daily: r.daily,
        monthly: r.monthly,
    });
});

// Business-KPI — daily cross-tenant onboarding-abandonment sweep.
executorRegistry.register('onboarding-abandonment-sweep', async () => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runOnboardingAbandonmentSweep } = await import('./onboarding-abandonment-sweep');
    const r = await runOnboardingAbandonmentSweep();
    return makeResult('onboarding-abandonment-sweep', startedAt, startMs, r.scanned, r.abandoned, 0, {
        byStep: r.byStep,
    });
});


// NIS2 Article 23 — hourly deadline clock: flip incident notification
// deadlines PENDING→DUE→OVERDUE and fire owner + admin alerts.
executorRegistry.register('incident-notification-deadlines', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { processIncidentNotificationDeadlines } = await import(
        './incident-notification-deadlines'
    );
    const { prisma } = await import('@/lib/prisma');
    const r = await processIncidentNotificationDeadlines(prisma, {
        tenantId: payload.tenantId,
    });
    return makeResult(
        'incident-notification-deadlines',
        startedAt,
        startMs,
        r.scanned,
        r.becameDue + r.becameOverdue,
        0,
        {
            becameDue: r.becameDue,
            becameOverdue: r.becameOverdue,
            notified: r.notified,
            capped: r.capped,
        },
    );
});

// ── compliance-posture-summary (+ dispatch) ──────────────────────────
//
// Dispatch is the daily cross-tenant fan-out; the per-tenant job scopes all
// reads + the cached-row upsert to payload.tenantId via runInTenantContext
// one frame down (buildPostureCronContext → runInTenantContext).

executorRegistry.register('compliance-posture-summary', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runCompliancePostureSummary } = await import('./compliance-posture-summary');
    const r = await runCompliancePostureSummary({ tenantId: payload.tenantId });
    return makeResult('compliance-posture-summary', startedAt, startMs, 1, r.generated ? 1 : 0, r.generated ? 0 : 1, {
        tenantId: r.tenantId,
        generated: r.generated,
        provider: r.provider,
        postureLabel: r.postureLabel,
        isFallback: r.isFallback,
    });
});

executorRegistry.register('compliance-posture-summary-dispatch', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runCompliancePostureDispatch } = await import('./compliance-posture-summary');
    const r = await runCompliancePostureDispatch(payload);
    return makeResult('compliance-posture-summary-dispatch', startedAt, startMs, r.tenants, r.dispatched, 0, {
        tenants: r.tenants,
        dispatched: r.dispatched,
    });
});

// ── aws-posture-collect ──────────────────────────────────────────────

executorRegistry.register('aws-posture-collect', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runAwsPostureCollectJob } = await import('./aws-posture-collect');
    // Forward the tenant-scoped fields explicitly (the job scopes its reads +
    // writes to payload.tenantId via runInTenantContext one frame down).
    const r = await runAwsPostureCollectJob({ tenantId: payload.tenantId, connectionId: payload.connectionId });
    return makeResult('aws-posture-collect', startedAt, startMs, 1, r.evidenceCreated, 0, {
        executionId: r.executionId,
        status: r.status,
    }, { status: r.status, errorMessage: r.errorMessage, noRetry: r.noRetry });
});

// PR-2 — identity-sync: sync one Okta / Google Workspace connection.
executorRegistry.register('identity-sync', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runIdentitySyncJob } = await import('./identity-sync');
    const r = await runIdentitySyncJob({ tenantId: payload.tenantId, connectionId: payload.connectionId });
    return makeResult('identity-sync', startedAt, startMs, r.upserted, r.upserted, r.deprovisioned, {
        executionId: r.executionId,
        status: r.status,
    }, { status: r.status, errorMessage: r.errorMessage, noRetry: r.noRetry });
});

// PR-2 — identity-sync-dispatch: fan out a sync per enabled identity connection.
executorRegistry.register('identity-sync-dispatch', async () => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runIdentitySyncDispatch } = await import('./identity-sync');
    const r = await runIdentitySyncDispatch();
    return makeResult('identity-sync-dispatch', startedAt, startMs, r.connections, r.dispatched, 0, {
        connections: r.connections,
    });
});

// identity-leaver-pass: one leaver pass for one (tenant, provider). The mode is
// the tenant's own identityLeaverMode, NOT a constant — at AUTOMATIC this writes
// to a real directory. It said "one DRY_RUN leaver pass" until #2187 raised the
// clamp and nothing came back here to correct it.
executorRegistry.register('identity-leaver-pass', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runIdentityLeaverPassJob } = await import('./identity-leaver');
    const r = await runIdentityLeaverPassJob({ tenantId: payload.tenantId, provider: payload.provider });
    return makeResult(
        'identity-leaver-pass',
        startedAt,
        startMs,
        r.candidates,
        // "Actioned" is deliberately the count of accounts a real run WOULD have
        // disabled, which under the DRY_RUN clamp is always zero writes.
        // Reporting candidates here would read as work performed.
        r.counts.DISABLED ?? 0,
        r.candidates - (r.counts.DISABLED ?? 0),
        { mode: r.mode, refusal: r.refusal, counts: r.counts, population: r.population },
        { status: r.status, errorMessage: r.errorMessage },
    );
});

// identity-leaver-dispatch: fan out a pass per (tenant, writable provider).
executorRegistry.register('identity-leaver-dispatch', async () => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runIdentityLeaverDispatch } = await import('./identity-leaver');
    const r = await runIdentityLeaverDispatch();
    return makeResult('identity-leaver-dispatch', startedAt, startMs, r.units, r.dispatched, 0, {
        units: r.units,
    });
});

// ── cloud-posture-collect-dispatch ───────────────────────────────────
// The fan-out the three *-posture-collect executors never had: they were
// registered here and enqueued by nothing, so the rolling-evidence collectors
// behind them were unreachable. See ./cloud-posture-collect-dispatch.
executorRegistry.register('cloud-posture-collect-dispatch', async () => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runCloudPostureCollectDispatch } = await import('./cloud-posture-collect-dispatch');
    const r = await runCloudPostureCollectDispatch();
    return makeResult('cloud-posture-collect-dispatch', startedAt, startMs, r.connections, r.dispatched, 0, {
        connections: r.connections,
        byProvider: r.byProvider,
    });
});

// PR-3 — azure-posture-collect: run one Azure connection's benchmark + collect evidence.
executorRegistry.register('azure-posture-collect', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runAzurePostureCollectJob } = await import('./cloud-posture-collect');
    const r = await runAzurePostureCollectJob({ tenantId: payload.tenantId, connectionId: payload.connectionId });
    return makeResult('azure-posture-collect', startedAt, startMs, 1, r.evidenceCreated, 0, { executionId: r.executionId, status: r.status }, { status: r.status, errorMessage: r.errorMessage, noRetry: r.noRetry });
});

// PR-3 — gcp-posture-collect: run one GCP connection's benchmark + collect evidence.
executorRegistry.register('gcp-posture-collect', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runGcpPostureCollectJob } = await import('./cloud-posture-collect');
    const r = await runGcpPostureCollectJob({ tenantId: payload.tenantId, connectionId: payload.connectionId });
    return makeResult('gcp-posture-collect', startedAt, startMs, 1, r.evidenceCreated, 0, { executionId: r.executionId, status: r.status }, { status: r.status, errorMessage: r.errorMessage, noRetry: r.noRetry });
});

// C-roadmap — calendar-push-dispatch: fan out a per-tenant push per tenant with
// a live user calendar connection.
//
// `async () =>` with NO parameter, deliberately: the tenant-isolation
// regression guard bans `async (_payload)` on a dispatcher outright, with no
// exemption list, because an unused payload parameter is how a cross-tenant job
// acquires a tenantId nobody notices.
executorRegistry.register('calendar-push-dispatch', async () => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runCalendarPushDispatch } = await import('./calendar-push');
    const r = await runCalendarPushDispatch({});
    return makeResult('calendar-push-dispatch', startedAt, startMs, r.tenants, r.dispatched, 0, { tenants: r.tenants, failed: r.failed });
});

// C-roadmap — calendar-push-tenant: one tenant's connected users. Arrives via
// enqueue(). Both enqueue() and the cron path now apply JOB_DEFAULTS.
executorRegistry.register('calendar-push-tenant', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runCalendarPushTenant } = await import('./calendar-push');
    const r = await runCalendarPushTenant({ tenantId: payload.tenantId });
    return makeResult('calendar-push-tenant', startedAt, startMs, r.connections, r.pushed, 0, { connections: r.connections });
});

// PR-4 — hris-sync: sync one BambooHR connection's roster.
executorRegistry.register('hris-sync', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runHrisSyncJob } = await import('./hris-sync');
    const r = await runHrisSyncJob({ tenantId: payload.tenantId, connectionId: payload.connectionId });
    return makeResult('hris-sync', startedAt, startMs, r.upserted, r.upserted, r.managersLinked, { executionId: r.executionId, status: r.status }, { status: r.status, errorMessage: r.errorMessage, noRetry: r.noRetry });
});

// ── av-rescan ────────────────────────────────────────────────────────
//
// Operator-triggered, single-tenant, bounded. NOT scheduled: it re-reads
// every candidate object from storage and pays a clamd round trip per row,
// so it runs when someone decides it should, not on a clock. See
// `av-rescan.ts` for why every guard in it is load-bearing.
executorRegistry.register('av-rescan', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runAvRescan } = await import('./av-rescan');
    const r = await runAvRescan({
        tenantId: payload.tenantId,
        initiatedByUserId: payload.initiatedByUserId,
        limit: payload.limit,
        requestId: payload.requestId,
    });
    // The details block is SPREAD from the result, not re-typed field by
    // field. The hand-written list it replaces was accurate the day it was
    // written and silently wrong afterwards: `scannerThrew`, `backedOff`,
    // `halted`, `haltReason` and `haltRemediation` were all added to
    // `AvRescanResult` later and none of them reached the job record, so a
    // run that STOPPED because the verdicts looked wrong and a run that
    // finished with nothing to do produced indistinguishable records. An
    // operator reading the run history could not tell those apart, and the
    // absence of a field carries no information about which absence it is.
    // Spreading makes the record follow the interface by construction --
    // the next counter added lands here without anyone remembering to.
    //
    // `durationMs` is the one field deliberately dropped: the result's is
    // the job body's own measure, the top-level one on `JobRunResult` is
    // the executor's wall clock including the dynamic import. Two different
    // numbers under one name in one record is a reader's trap. Dropping a
    // NAMED field cannot silently swallow a future one.
    const { durationMs: _jobBodyDurationMs, ...counters } = r;
    const details: Record<string, unknown> = { ...counters };

    // Deliberately NOT reported as `JobOutcome.status: 'PARTIAL'`.
    //
    // Two reasons, either sufficient. First, it would be invisible:
    // `makeResult` reads `JobOutcome.status` only to decide `success`
    // (`!== 'ERROR'`), and `errorMessage` / `noRetry` are gated on ERROR --
    // the status string itself is never written to `JobRunResult`, so
    // passing PARTIAL here produces a record identical to passing nothing.
    // Second, PARTIAL already means something in this file and it is the
    // opposite of a halt: a directory synced across several runs, each
    // storing a cursor and stopping, resuming unattended on the next tick
    // -- explicitly "working as designed, do not page anyone". A halted
    // rescan stopped BECAUSE its results looked wrong and must not be
    // re-run until a human has checked the signature database. The run's
    // status stays a success (it is not a job failure, and BullMQ must not
    // retry it); what says the true thing is `details.halted` +
    // `haltReason` + `haltRemediation`, which an operator and an alert can
    // both match on.
    return makeResult(
        'av-rescan',
        startedAt,
        startMs,
        r.scanned,
        r.clean + r.infected,
        r.leftPending + r.lostClaim,
        details,
    );
});

// PR-4 — hris-sync-dispatch: fan out a sync per enabled HRIS connection.
executorRegistry.register('hris-sync-dispatch', async () => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runHrisSyncDispatch } = await import('./hris-sync');
    const r = await runHrisSyncDispatch();
    return makeResult('hris-sync-dispatch', startedAt, startMs, r.connections, r.dispatched, 0, { connections: r.connections });
});

// ── agent-proposal-expiry ───────────────────────────────────────────
//
// OWASP ASI09. Bounds the propose-not-commit review queue: a proposal past its
// window moves to the terminal EXPIRED status. Nothing is deleted — the row is
// the record of something no human agreed to. The refusal to APPROVE past the
// deadline lives in the usecase and reads the clock, so this job's failure
// costs tidiness, not safety.
executorRegistry.register('agent-proposal-expiry', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runAgentProposalExpiry } = await import('./agent-proposal-expiry');
    const { prisma } = await import('@/lib/prisma');
    const r = await runAgentProposalExpiry(prisma, { tenantId: payload.tenantId });
    return makeResult('agent-proposal-expiry', startedAt, startMs, r.scanned, r.expired, r.raced, {
        backfilled: r.backfilled,
        raced: r.raced,
    });
});

// ── agent-proposal-sample-audit ─────────────────────────────────────
//
// OWASP ASI09. Draws a keyed random sample of already-APPROVED proposals and
// opens a retrospective review on each, so the disagreement rate — the only
// measure of whether the human gate is doing anything — is computable.
executorRegistry.register('agent-proposal-sample-audit', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runAgentProposalSampleAudit } = await import('./agent-proposal-sample-audit');
    const { prisma } = await import('@/lib/prisma');
    const r = await runAgentProposalSampleAudit(prisma, { tenantId: payload.tenantId });
    return makeResult(
        'agent-proposal-sample-audit',
        startedAt,
        startMs,
        r.candidates,
        r.opened,
        0,
        { tenants: r.tenants },
    );
});
