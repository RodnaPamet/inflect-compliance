/**
 * Epic G-2 — Control Test Runner
 *
 * Per-plan execution worker. The scheduler (`control-test-scheduler`)
 * claims due `ControlTestPlan` rows and enqueues one of these jobs
 * per claim, deduplicated by `ctr:{planId}:{scheduledForIso}`. The
 * runner turns the queued job into a durable `ControlTestRun` row
 * with auto-attached evidence and, on automated FAIL, a linked
 * `Finding`.
 *
 * ═══════════════════════════════════════════════════════════════════
 * AUTOMATION-TYPE BRANCHING
 * ═══════════════════════════════════════════════════════════════════
 *
 *   MANUAL
 *     • Create a `ControlTestRun` in `status=PLANNED, result=null`.
 *     • Stamp `notes` with "[Auto-scheduled by Epic G-2 at <iso>]
 *       Awaiting manual completion." so the UI surface that today
 *       lists PLANNED runs immediately shows the scheduler's hand.
 *     • Generate a `Evidence(type=TEXT)` row titled
 *       "Scheduled test run instantiated" carrying plan name +
 *       cron + scheduled-for. This satisfies the prompt's
 *       "evidence is attached automatically" contract for MANUAL
 *       plans without forging script output.
 *     • Link the evidence to the run via
 *       `ControlTestEvidenceLink(kind=EVIDENCE)`.
 *     • Done. The run lives until a human calls `completeTestRun`
 *       through the existing manual path.
 *
 *   SCRIPT / INTEGRATION  (handler seam)
 *     • Create the run as PLANNED, same as above.
 *     • Look up an executor in `runnerHandlerRegistry`. The registry
 *       is empty today (no real SCRIPT/INTEGRATION engine exists yet).
 *       When NO handler is registered, the branch delegates to the
 *       MANUAL path — the run stays PLANNED "awaiting manual
 *       completion" instead of completing as a misleading INCONCLUSIVE
 *       no-op. A no-engine run never reaches COMPLETED, so it never
 *       enters the effectiveness pass-rate denominator.
 *     • If a handler IS registered, await its result, COMPLETE the run
 *       with PASS/FAIL/INCONCLUSIVE, then — for parity with the manual
 *       completeTestRun path — stamp `Control.lastTested` and roll the
 *       plan cadence, attach handler-produced evidence, and on FAIL
 *       spawn a `Finding`.
 *
 * ═══════════════════════════════════════════════════════════════════
 * SYSTEM-ACTOR CONTEXT
 * ═══════════════════════════════════════════════════════════════════
 *
 * The runner has no HTTP request context — it's a queued job. To
 * reuse the existing repository + audit-event surface (which all
 * take a `RequestContext`) we synthesize one:
 *
 *   userId    ← plan.createdByUserId   (audit attribution to plan author)
 *   tenantId  ← plan.tenantId
 *   requestId ← schedulerJobRunId       (breadcrumb back to the tick)
 *   role      ← ADMIN                   (write + create finding/evidence)
 *
 * Audit log entries appear under the plan author's identity with the
 * scheduler's job-run id in `requestId` — auditors can grep one id
 * to reconstruct: tick → claim → enqueue → run-creation → evidence
 * → (optional) finding.
 *
 * ═══════════════════════════════════════════════════════════════════
 * LINKAGE TRACE
 * ═══════════════════════════════════════════════════════════════════
 *
 *   ControlTestPlan ─┐
 *                    │ (testPlanId)
 *                    ▼
 *   ControlTestRun ──┐
 *                    │ (testRunId)
 *                    ▼
 *   ControlTestEvidenceLink (kind=EVIDENCE)
 *                    │ (evidenceId)
 *                    ▼
 *   Evidence (controlId = plan.controlId)        ◄── concrete Control link
 *                    │ (evidenceId, on FAIL only)
 *                    ▼
 *   FindingEvidence
 *                    │ (findingId)
 *                    ▼
 *   Finding (type=NONCONFORMITY, status=OPEN)
 *
 * Finding has no direct `controlId` column in the schema — the link
 * goes through the run's auto-evidence row (which DOES carry
 * `controlId`). This matches the existing convention used by manual
 * `completeTestRun → createTask` flow.
 *
 * @module jobs/control-test-runner
 */
import type { ControlTestRunnerPayload, JobRunResult } from './types';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { runInTenantContext } from '@/lib/db-context';
import { prisma } from '@/lib/prisma';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '../types';
import { TestRunRepository } from '../repositories/TestRunRepository';
import { TestEvidenceRepository } from '../repositories/TestEvidenceRepository';
import { TestPlanRepository } from '../repositories/TestPlanRepository';
import { FindingRepository } from '../repositories/FindingRepository';
import { emitTestRunCreated, emitTestRunCompleted, emitTestRunFailed } from '../events/test.events';
import { logEvent } from '../events/audit';
import { attestControlTested, isAttestingVerdict } from '../usecases/control';
import { computeNextDueAt } from '../utils/cadence';

// ─── Public types ──────────────────────────────────────────────────

/**
 * Result returned by an automation handler when one is registered for
 * a SCRIPT or INTEGRATION plan. The runner uses this to drive the
 * COMPLETE → evidence → finding flow.
 *
 * `evidenceContent` is treated as plain-text and sanitised at the
 * Evidence persistence boundary (Epic D.2 manifest).
 */
export interface AutomationHandlerResult {
    result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    /** Plain-text content to store on the auto-evidence row. */
    evidenceContent: string;
    /** Plain-text title for the auto-evidence row. */
    evidenceTitle?: string;
    /** Free-text summary written to ControlTestRun.findingSummary on FAIL. */
    findingSummary?: string;
    /** Free-text run notes — surfaces in the run-detail UI. */
    notes?: string;
    /** Optional severity override for the auto-Finding on FAIL. */
    findingSeverity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

/**
 * Pluggable handler. The scheduler-runner contract is intentionally
 * narrow — handlers receive the plan + automationConfig + a
 * cancellation-friendly clock and return one shape. SCRIPT and
 * INTEGRATION handlers will be registered in the next G-2 prompt;
 * the registry being empty today is the defined seam.
 */
export interface AutomationHandlerInput {
    tenantId: string;
    planId: string;
    controlId: string;
    automationType: 'SCRIPT' | 'INTEGRATION';
    automationConfig: unknown;
    scheduledFor: Date;
}

export type AutomationHandler = (
    input: AutomationHandlerInput,
) => Promise<AutomationHandlerResult>;

const handlers = new Map<'SCRIPT' | 'INTEGRATION', AutomationHandler>();

/**
 * Register a handler for a SCRIPT or INTEGRATION plan. Idempotent
 * across HMR via a module-local guard — repeat registration of the
 * same key throws so accidental double-registrations surface
 * during dev start-up rather than silently shadowing.
 */
export const runnerHandlerRegistry = {
    register(
        type: 'SCRIPT' | 'INTEGRATION',
        handler: AutomationHandler,
    ): void {
        if (handlers.has(type)) {
            throw new Error(
                `Duplicate runner handler registration for "${type}".`,
            );
        }
        handlers.set(type, handler);
    },
    get(type: 'SCRIPT' | 'INTEGRATION'): AutomationHandler | undefined {
        return handlers.get(type);
    },
    /** Test-only — clears the map between tests. */
    _reset(): void {
        handlers.clear();
    },
};

// ─── Entry point ───────────────────────────────────────────────────

export interface ControlTestRunnerResult {
    /** Set when the runner found and processed a plan. */
    runId?: string;
    /** Run-level outcome. PLANNED for MANUAL; result for SCRIPT/INTEGRATION. */
    runStatus: 'PLANNED' | 'COMPLETED' | 'SKIPPED';
    runResult: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null;
    /** Whether an evidence row was attached. */
    evidenceAttached: boolean;
    /** The evidence id, if one was attached. */
    evidenceId?: string;
    /** Whether a Finding was auto-created. */
    findingCreated: boolean;
    /** The finding id, if one was created. */
    findingId?: string;
    /** Reason the runner short-circuited, if any. */
    skipReason?: string;
    /** Job-run id for log correlation. */
    jobRunId: string;
}

export async function runControlTestRunner(
    payload: ControlTestRunnerPayload,
): Promise<ControlTestRunnerResult> {
    return runJob(
        'control-test-runner',
        async () => {
            const jobRunId = payload.schedulerJobRunId ?? crypto.randomUUID();
            const scheduledFor = new Date(payload.scheduledForIso);

            // Defensive load — direct prisma read (worker bypasses RLS).
            // We refuse to act if the plan disappeared, was paused, or
            // changed automationType to MANUAL between the scheduler
            // tick and the runner pickup.
            const plan = await prisma.controlTestPlan.findFirst({
                where: { id: payload.testPlanId, tenantId: payload.tenantId },
                select: {
                    id: true,
                    tenantId: true,
                    controlId: true,
                    name: true,
                    schedule: true,
                    frequency: true,
                    automationType: true,
                    automationConfig: true,
                    status: true,
                    createdByUserId: true,
                    ownerUserId: true,
                },
            });

            if (!plan) {
                logger.warn('control-test-runner: plan not found', {
                    component: 'control-test-runner',
                    jobRunId,
                    tenantId: payload.tenantId,
                    testPlanId: payload.testPlanId,
                });
                return {
                    runStatus: 'SKIPPED' as const,
                    runResult: null,
                    evidenceAttached: false,
                    findingCreated: false,
                    skipReason: 'plan_not_found',
                    jobRunId,
                };
            }

            if (plan.status !== 'ACTIVE') {
                logger.info('control-test-runner: plan not active', {
                    component: 'control-test-runner',
                    jobRunId,
                    planId: plan.id,
                    status: plan.status,
                });
                return {
                    runStatus: 'SKIPPED' as const,
                    runResult: null,
                    evidenceAttached: false,
                    findingCreated: false,
                    skipReason: 'plan_inactive',
                    jobRunId,
                };
            }

            const ctx = buildSystemContext(plan, jobRunId);

            return runInTenantContext(ctx, async (db) => {
                // 1. Create the run (PLANNED for both branches; SCRIPT
                //    and INTEGRATION transition to COMPLETED below).
                const run = await TestRunRepository.create(db, ctx, {
                    testPlanId: plan.id,
                    controlId: plan.controlId,
                });
                await emitTestRunCreated(db, ctx, {
                    id: run.id,
                    testPlanId: plan.id,
                });

                // 2. Branch on automation type.
                if (plan.automationType === 'MANUAL') {
                    return await handleManualPlan(db, ctx, plan, run.id, scheduledFor, jobRunId);
                }
                return await handleAutomatedPlan(
                    db,
                    ctx,
                    plan,
                    run.id,
                    scheduledFor,
                    jobRunId,
                );
            });
        },
        { tenantId: payload.tenantId },
    );
}

// ─── MANUAL branch ─────────────────────────────────────────────────

interface PlanShape {
    id: string;
    tenantId: string;
    controlId: string;
    name: string;
    schedule: string | null;
    frequency: string;
    automationType: 'MANUAL' | 'SCRIPT' | 'INTEGRATION';
    automationConfig: unknown;
    status: string;
    createdByUserId: string;
    ownerUserId: string | null;
}

async function handleManualPlan(
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    ctx: RequestContext,
    plan: PlanShape,
    runId: string,
    scheduledFor: Date,
    jobRunId: string,
): Promise<ControlTestRunnerResult> {
    // Annotate the run so the existing manual UI surface shows
    // "auto-scheduled, awaiting completion" without requiring a UI
    // change today.
    const note =
        `[Auto-scheduled by Epic G-2 at ${scheduledFor.toISOString()}] ` +
        `Awaiting manual completion.`;
    await db.controlTestRun.update({
        where: { id: runId },
        data: { notes: note },
    });

    // Auto-evidence — TEXT marker, controlId-anchored so the
    // Finding-via-FindingEvidence trace is available later if a
    // human completes the run as FAIL.
    const evidenceContent =
        `Scheduled test run instantiated.\n` +
        `Plan: ${plan.name}\n` +
        (plan.schedule ? `Schedule: ${plan.schedule}\n` : '') +
        `Scheduled for: ${scheduledFor.toISOString()}\n` +
        `Awaiting manual completion.`;

    const evidenceId = await createScheduledRunEvidence(db, ctx, {
        controlId: plan.controlId,
        title: `Scheduled run — ${plan.name}`,
        content: evidenceContent,
    });
    await TestEvidenceRepository.link(db, ctx, {
        testRunId: runId,
        kind: 'EVIDENCE',
        evidenceId,
        note: 'Auto-attached on scheduled instantiation',
    });

    return {
        runId,
        runStatus: 'PLANNED' as const,
        runResult: null,
        evidenceAttached: true,
        evidenceId,
        findingCreated: false,
        jobRunId,
    };
}

// ─── SCRIPT / INTEGRATION branch ───────────────────────────────────

async function handleAutomatedPlan(
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    ctx: RequestContext,
    plan: PlanShape,
    runId: string,
    scheduledFor: Date,
    jobRunId: string,
): Promise<ControlTestRunnerResult> {
    if (plan.automationType !== 'SCRIPT' && plan.automationType !== 'INTEGRATION') {
        // Type guard — should never fire given handleManualPlan
        // covers MANUAL, but keeps the discriminated union honest.
        throw new Error(`Unexpected automationType: ${plan.automationType}`);
    }

    const handler = runnerHandlerRegistry.get(plan.automationType);

    if (!handler) {
        // No execution engine is registered for this automation type (the
        // SCRIPT/INTEGRATION registry is empty today — see the module doc).
        // Rather than completing the run as a jargon INCONCLUSIVE no-op —
        // which showed raw "no handler registered" text as evidence and (before
        // the pass-rate fix) silently dragged effectiveness down — instantiate a
        // PLANNED "awaiting manual completion" run, exactly as a MANUAL scheduled
        // plan does. A human finishes it via completeTestRun, which stamps
        // lastTested + rolls cadence. A no-engine run never reaches COMPLETED,
        // so it never enters the effectiveness denominator. New scheduled plans
        // are created as MANUAL until a real engine exists (TestPlanScheduleSection);
        // this branch keeps legacy SCRIPT/INTEGRATION plans honest too.
        return await handleManualPlan(db, ctx, plan, runId, scheduledFor, jobRunId);
    }

    let outcome: AutomationHandlerResult;
    try {
        outcome = await handler({
            tenantId: plan.tenantId,
            planId: plan.id,
            controlId: plan.controlId,
            automationType: plan.automationType,
            automationConfig: plan.automationConfig,
            scheduledFor,
        });
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('control-test-runner: handler threw', {
            component: 'control-test-runner',
            jobRunId,
            planId: plan.id,
            automationType: plan.automationType,
            err: err instanceof Error ? err : new Error(errMsg),
        });
        outcome = {
            result: 'INCONCLUSIVE',
            evidenceTitle: `Scheduled run — ${plan.name} (handler error)`,
            evidenceContent:
                `Handler raised: ${errMsg}\n` +
                `Plan: ${plan.name}. Scheduled for: ${scheduledFor.toISOString()}.`,
            notes: `[Auto-scheduled by Epic G-2] Handler error: ${errMsg}`,
        };
    }

    // Complete the run with the handler's outcome.
    await TestRunRepository.complete(db, ctx, runId, {
        result: outcome.result,
        notes: outcome.notes ?? null,
        findingSummary: outcome.findingSummary ?? null,
    });
    await emitTestRunCompleted(db, ctx, {
        id: runId,
        result: outcome.result,
        testPlanId: plan.id,
    });

    // Effectiveness parity with the manual completeTestRun path — a completed
    // automated run stamps Control.lastTested and rolls the plan cadence,
    // exactly as completeTestRun does. One completion path, one set of side
    // effects. (Dormant until a SCRIPT/INTEGRATION handler is registered, but
    // wired now so parity holds the moment one is.)
    //
    // CRITICAL: gated on a real verdict. The catch block above coerces a
    // handler CRASH into `result: 'INCONCLUSIVE'` — without this gate a flaky
    // engine would mark controls "tested & on-schedule" every time it threw,
    // which is the most dangerous shape of this bug (silent, recurring, and it
    // looks like healthy automation).
    await attestControlTested(db, ctx, plan.controlId, outcome.result);
    if (isAttestingVerdict(outcome.result)) {
        await TestPlanRepository.updateNextDueAt(
            db,
            ctx,
            plan.id,
            computeNextDueAt(plan.frequency, new Date()),
        );
    }

    // Auto-evidence with handler-supplied content.
    const evidenceId = await createScheduledRunEvidence(db, ctx, {
        controlId: plan.controlId,
        title: outcome.evidenceTitle ?? `Scheduled run — ${plan.name}`,
        content: outcome.evidenceContent,
    });
    await TestEvidenceRepository.link(db, ctx, {
        testRunId: runId,
        kind: 'EVIDENCE',
        evidenceId,
        note: 'Auto-attached by automation handler',
    });

    let findingId: string | undefined;
    if (outcome.result === 'FAIL') {
        await emitTestRunFailed(db, ctx, {
            id: runId,
            findingSummary: outcome.findingSummary ?? null,
        });
        findingId = await createFindingForFailedRun(db, ctx, {
            planName: plan.name,
            evidenceId,
            findingSummary: outcome.findingSummary ?? outcome.notes ?? null,
            severity: outcome.findingSeverity ?? 'HIGH',
        });
    }

    return {
        runId,
        runStatus: 'COMPLETED' as const,
        runResult: outcome.result,
        evidenceAttached: true,
        evidenceId,
        findingCreated: findingId !== undefined,
        findingId,
        jobRunId,
    };
}

// ─── Helpers ───────────────────────────────────────────────────────

function buildSystemContext(
    plan: { tenantId: string; createdByUserId: string },
    jobRunId: string,
): RequestContext {
    return {
        requestId: jobRunId,
        userId: plan.createdByUserId,
        tenantId: plan.tenantId,
        // ADMIN gives the synthetic actor write access to every
        // surface this runner touches. The audit log records the
        // plan author as the userId; the requestId carries the
        // scheduler's job-run id so the trail is reconstructible.
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

async function createScheduledRunEvidence(
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    ctx: RequestContext,
    data: { controlId: string; title: string; content: string },
): Promise<string> {
    const evidence = await db.evidence.create({
        data: {
            tenantId: ctx.tenantId,
            type: 'TEXT',
            title: data.title,
            content: data.content,
            // 'integration' mirrors the automation-runner's
            // category convention so the evidence list filters
            // these alongside other automated artefacts.
            category: 'integration',
            status: 'APPROVED',
            ownerUserId: ctx.userId,
        },
        select: { id: true },
    });
    await db.evidenceControlLink.create({
        data: {
            tenantId: ctx.tenantId,
            evidenceId: evidence.id,
            controlId: data.controlId,
            createdByUserId: ctx.userId ?? null,
        },
    });
    await logEvent(db, ctx, {
        action: 'EVIDENCE_AUTO_ATTACHED',
        entityType: 'Evidence',
        entityId: evidence.id,
        details: `Auto-attached scheduled-run evidence: ${data.title}`,
    });
    return evidence.id;
}

async function createFindingForFailedRun(
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    ctx: RequestContext,
    data: {
        planName: string;
        evidenceId: string;
        findingSummary: string | null;
        severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    },
): Promise<string> {
    const finding = await FindingRepository.create(db, ctx, {
        title: `Test failed: ${data.planName}`,
        description:
            data.findingSummary ??
            'A scheduled control test run completed with FAIL result and requires review.',
        severity: data.severity,
        type: 'NONCONFORMITY',
        status: 'OPEN',
    });

    // Bridge: Finding ← FindingEvidence ← Evidence(controlId).
    // This is the codebase's existing pattern for linking a
    // Finding to a Control — the Finding model has no direct
    // controlId column.
    await db.findingEvidence.create({
        data: {
            tenantId: ctx.tenantId,
            findingId: finding.id,
            evidenceId: data.evidenceId,
        },
    });

    await logEvent(db, ctx, {
        action: 'FINDING_AUTO_CREATED',
        entityType: 'Finding',
        entityId: finding.id,
        details: `Auto-created Finding from failed scheduled run: ${data.planName}`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'Finding',
            operation: 'created',
            after: {
                title: finding.title,
                severity: data.severity,
                type: 'NONCONFORMITY',
            },
            summary: `Auto-created from failed scheduled test run`,
        },
    });

    return finding.id;
}

// ─── BullMQ adapter ────────────────────────────────────────────────

/**
 * The shape `executor-registry.ts` registers. Wraps
 * `runControlTestRunner` and packages its result into the standard
 * `JobRunResult` contract.
 */
export async function controlTestRunnerExecutor(
    payload: ControlTestRunnerPayload,
): Promise<JobRunResult> {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const r = await runControlTestRunner(payload);
    return {
        jobName: 'control-test-runner',
        jobRunId: r.jobRunId,
        success: true,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - startMs),
        itemsScanned: 1,
        itemsActioned:
            r.runStatus === 'PLANNED' || r.runStatus === 'COMPLETED' ? 1 : 0,
        itemsSkipped: r.runStatus === 'SKIPPED' ? 1 : 0,
        details: {
            runId: r.runId,
            runStatus: r.runStatus,
            runResult: r.runResult,
            evidenceAttached: r.evidenceAttached,
            evidenceId: r.evidenceId,
            findingCreated: r.findingCreated,
            findingId: r.findingId,
            skipReason: r.skipReason,
        },
    };
}
