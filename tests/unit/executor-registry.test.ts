/**
 * Unit coverage for the job executor registry.
 *
 * Exercises the registry's dispatch/lookup layer without running each
 * heavy executor body: registration (+ duplicate-throw), unknown-job
 * failure result, the catch/fault-isolation branch, the pure
 * `health-check` executor (which has no dynamic import), and the
 * lookup helpers (`getExecutor` / `has` / `listRegistered` / `size` /
 * `_reset`).
 */
import { executorRegistry } from '@/app-layer/jobs/executor-registry';
import type { JobRunResult } from '@/app-layer/jobs/types';
import {
    IntegrationAuthError,
    IntegrationRateLimitedError,
} from '@/app-layer/integrations/http-resilience';

// ── Mock the heavy job modules behind the uniform `{ result }` executors
// so we can drive their closure bodies through `execute` without loading
// Prisma / integration SDKs. Each returns a minimal successful result. ──
const RESULT: JobRunResult = {
    jobName: 'mock',
    jobRunId: 'mock-run',
    success: true,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1,
    itemsScanned: 0,
    itemsActioned: 0,
    itemsSkipped: 0,
};
jest.mock('@/app-layer/jobs/vendor-renewal-check', () => ({
    runVendorRenewalCheck: jest.fn(async () => ({ result: RESULT })),
}));
jest.mock('@/app-layer/jobs/deadline-monitor', () => ({
    runDeadlineMonitor: jest.fn(async () => ({ result: RESULT })),
}));
jest.mock('@/app-layer/jobs/evidence-expiry-monitor', () => ({
    runEvidenceExpiryMonitor: jest.fn(async () => ({ result: RESULT })),
}));
jest.mock('@/app-layer/jobs/notification-dispatch', () => ({
    runNotificationDispatch: jest.fn(async () => ({ result: RESULT })),
}));
jest.mock('@/app-layer/jobs/snapshot', () => ({
    runSnapshotJob: jest.fn(async () => ({ result: RESULT })),
}));
jest.mock('@/app-layer/jobs/sla-monitor', () => ({
    runSlaMonitorJob: jest.fn(async () => ({ result: RESULT })),
}));
jest.mock('@/app-layer/jobs/rule-chain-dispatch', () => ({
    runRuleChainDispatch: jest.fn(async () => ({ result: RESULT })),
}));
jest.mock('@/app-layer/jobs/subflow-dispatcher', () => ({
    runSubflowDispatch: jest.fn(async () => ({ result: RESULT })),
}));
jest.mock('@/app-layer/jobs/schedule-trigger-sweep', () => ({
    runScheduleTriggerSweep: jest.fn(async () => ({ result: RESULT })),
}));
jest.mock('@/app-layer/jobs/compliance-digest', () => ({
    runComplianceDigest: jest.fn(async () => ({ result: RESULT })),
}));
jest.mock('@/app-layer/jobs/control-test-runner', () => ({
    controlTestRunnerExecutor: jest.fn(async () => RESULT),
}));

// ── makeResult-wrapper executors: mock each job module's return with the
// exact shape its closure reads, so the wrapper body runs end-to-end. ──
jest.mock('@/lib/prisma', () => ({ prisma: {} }));
jest.mock('@/app-layer/jobs/nvd-cve-sync', () => ({
    runNvdCveSync: jest.fn(async () => ({
        fetched: 0, upserted: 0, skipped: 0, matched: 0, windowStart: 'a', windowEnd: 'b',
    })),
}));
jest.mock('@/app-layer/jobs/automation-runner', () => ({
    runScheduledAutomations: jest.fn(async () => ({
        totalDue: 0, executed: 0, skipped: 0, passed: 0, failed: 0, errors: [], dryRun: false,
    })),
}));
jest.mock('@/app-layer/jobs/dailyEvidenceExpiry', () => {
    const sweep = { tasksCreated: 0, skippedDuplicate: 0, scanned: 0 };
    return {
        runDailyEvidenceExpiryNotifications: jest.fn(async () => ({
            sweeps: { days30: { ...sweep }, days7: { ...sweep }, days1: { ...sweep } },
            outbox: {},
        })),
    };
});
jest.mock('@/app-layer/jobs/data-lifecycle', () => ({
    purgeSoftDeletedOlderThan: jest.fn(async () => [{ scanned: 0, purged: 0 }]),
    purgeExpiredEvidenceOlderThan: jest.fn(async () => ({ scanned: 0, purged: 0 })),
    runRetentionSweep: jest.fn(async () => [{ scanned: 0, expired: 0 }]),
}));
jest.mock('@/app-layer/jobs/policyReviewReminder', () => ({
    processOverdueReminders: jest.fn(async () => ({ processed: 0, policies: [] })),
}));
jest.mock('@/app-layer/jobs/access-review-reminder', () => ({
    processAccessReviewReminders: jest.fn(async () => ({
        scanned: 0, enqueued: 0, skippedDuplicate: 0, skippedNoEmail: 0, skippedComplete: 0,
    })),
}));
jest.mock('@/app-layer/jobs/access-review-overdue-escalation', () => ({
    processAccessReviewOverdueEscalation: jest.fn(async () => ({
        scanned: 0, enqueued: 0, skippedDuplicate: 0, skippedNoAdminEmail: 0, skippedComplete: 0,
    })),
}));
jest.mock('@/app-layer/jobs/exception-expiry-monitor', () => ({
    runExceptionExpiryMonitor: jest.fn(async () => ({
        scanned: 0, enqueued: 0, skippedDuplicate: 0, skippedNoEmail: 0, skippedNoRecipient: 0,
    })),
}));
jest.mock('@/app-layer/jobs/task-due-notification', () => ({
    processTaskDueNotifications: jest.fn(async () => ({
        scanned: 0, created: 0, skippedDuplicate: 0, byWindow: {},
    })),
}));
jest.mock('@/app-layer/jobs/retention', () => ({
    runEvidenceRetentionSweep: jest.fn(async () => ({
        scanned: 0, archived: 0, expired: 0, dryRun: false,
    })),
}));
jest.mock('@/app-layer/jobs/sync-pull', () => ({
    runSyncPull: jest.fn(async () => undefined),
}));
jest.mock('@/app-layer/jobs/key-rotation', () => ({
    runKeyRotation: jest.fn(async () => ({
        totalScanned: 0, totalRewritten: 0, tenantId: 't', dekRewrapped: false,
        dekRewrapError: null, perField: {}, totalErrors: 0, jobRunId: 'j',
    })),
}));
jest.mock('@/app-layer/jobs/tenant-dek-rotation', () => ({
    runTenantDekRotation: jest.fn(async () => ({
        totalScanned: 0, totalRewritten: 0, totalSkipped: 0, tenantId: 't',
        previousEncryptedDekCleared: true, perField: {}, totalErrors: 0, jobRunId: 'j',
    })),
}));
jest.mock('@/app-layer/jobs/automation-event-dispatch', () => ({
    runAutomationEventDispatch: jest.fn(async () => ({
        rulesConsidered: 0, executionsCreated: 0, executionsSkippedDuplicate: 0,
        executionsSkippedFilter: 0, tenantId: 't', event: 'e', rulesMatched: 0,
        executionsFailed: 0, jobRunId: 'j',
    })),
}));
jest.mock('@/app-layer/jobs/control-test-scheduler', () => ({
    runControlTestScheduler: jest.fn(async () => ({
        totalDue: 0, enqueued: 0, skippedClaimRace: 0, skippedInvalidSchedule: 0,
        bootstrapped: 0, enqueueFailures: 0, dryRun: false, jobRunId: 'j',
    })),
}));
jest.mock('@/app-layer/jobs/evidence-import', () => ({
    runEvidenceImport: jest.fn(async (_payload, cb) => {
        if (cb) await cb({ phase: 'done' });
        return {
            totalEntries: 0, extracted: 0, skipped: 0, errored: 0, tenantId: 't',
            evidenceIds: [], skipReasons: {}, firstError: null, jobRunId: 'j',
        };
    }),
}));
jest.mock('@/app-layer/jobs/sharepoint-delta-sync', () => ({
    runSharePointDeltaSyncJob: jest.fn(async () => ({ drivesSynced: 0, reimported: 0, staled: 0 })),
    runSharePointDeltaSyncDispatch: jest.fn(async () => ({ connections: 0, dispatched: 0 })),
}));
jest.mock('@/app-layer/jobs/sharepoint-policy-jobs', () => ({
    runSharePointPolicyPull: jest.fn(async () => ({ pulled: true })),
    runSharePointSubscriptionRenew: jest.fn(async () => ({ subscriptions: 0, renewed: 0 })),
}));
jest.mock('@/app-layer/jobs/report-delivery-jobs', () => ({
    runReportDelivery: jest.fn(async () => ({
        due: 0, generated: 0, delivered: 0, pushed: 0, failed: 0,
    })),
}));
jest.mock('@/app-layer/jobs/risk-appetite-jobs', () => ({
    runRiskAppetiteMonitor: jest.fn(async () => ({ scanned: 0, newBreaches: 0, tenants: 0, resolved: 0 })),
}));
jest.mock('@/app-layer/jobs/risk-snapshot-jobs', () => ({
    runRiskSnapshot: jest.fn(async () => ({ scanned: 0, riskSnapshots: 0, tenants: 0, pruned: 0 })),
}));
jest.mock('@/app-layer/jobs/dau-mau-aggregator', () => ({
    runDauMauAggregation: jest.fn(async () => ({ dailyTotal: 0, monthlyTotal: 0, daily: {}, monthly: {} })),
}));
jest.mock('@/app-layer/jobs/onboarding-abandonment-sweep', () => ({
    runOnboardingAbandonmentSweep: jest.fn(async () => ({ scanned: 0, abandoned: 0, byStep: {} })),
}));
jest.mock('@/app-layer/jobs/incident-notification-deadlines', () => ({
    processIncidentNotificationDeadlines: jest.fn(async () => ({
        scanned: 0, becameDue: 0, becameOverdue: 0, notified: 0, capped: 0,
    })),
}));

// Loosely-typed view so we can register/execute synthetic job names
// (the public API is generic over the closed `JobName` union).
const reg = executorRegistry as unknown as {
    register(name: string, fn: () => Promise<JobRunResult>): void;
    execute(name: string, payload: unknown): Promise<JobRunResult>;
    getExecutor(name: string): unknown;
    has(name: string): boolean;
    listRegistered(): string[];
    size: number;
    _reset(): void;
};

describe('executorRegistry — default registrations', () => {
    it('auto-registers the built-in executors at import time', () => {
        expect(reg.size).toBeGreaterThan(20);
        const names = reg.listRegistered();
        expect(names).toContain('health-check');
        expect(names).toContain('nvd-cve-sync');
        expect(names).toContain('automation-runner');
        expect(names).toContain('incident-notification-deadlines');
    });

    it('has() / getExecutor() resolve known + unknown names', () => {
        expect(reg.has('health-check')).toBe(true);
        expect(reg.has('definitely-not-a-job')).toBe(false);
        expect(reg.getExecutor('health-check')).toBeInstanceOf(Function);
        expect(reg.getExecutor('definitely-not-a-job')).toBeUndefined();
    });
});

describe('executorRegistry.execute — dispatch + fault isolation', () => {
    it('runs the pure health-check executor and defaults the message to "pong"', async () => {
        const enqueuedAt = new Date().toISOString();
        const result = await reg.execute('health-check', { enqueuedAt });
        expect(result.success).toBe(true);
        expect(result.jobName).toBe('health-check');
        expect(result.jobRunId).toBeTruthy();
        expect(result.details?.message).toBe('pong');
        expect(result.details?.enqueuedAt).toBe(enqueuedAt);
        expect(typeof result.durationMs).toBe('number');
    });

    it('passes through an explicit health-check message', async () => {
        const result = await reg.execute('health-check', {
            enqueuedAt: new Date().toISOString(),
            message: 'custom-ping',
        });
        expect(result.details?.message).toBe('custom-ping');
    });

    it('returns a failure result (not a throw) for an unknown job', async () => {
        const result = await reg.execute('totally-unknown-job', {});
        expect(result.success).toBe(false);
        expect(result.jobName).toBe('totally-unknown-job');
        expect(result.errorMessage).toMatch(/no executor registered/i);
        expect(result.durationMs).toBe(0);
        expect(result.itemsScanned).toBe(0);
    });

    it('catches an executor throw and returns a failure result', async () => {
        reg.register('unit-throwing-job', async () => {
            throw new Error('boom from executor');
        });
        const result = await reg.execute('unit-throwing-job', {});
        expect(result.success).toBe(false);
        expect(result.jobName).toBe('unit-throwing-job');
        expect(result.errorMessage).toBe('boom from executor');
        expect(typeof result.durationMs).toBe('number');
    });

    it('catches a non-Error throw and stringifies it', async () => {
        reg.register('unit-string-throw-job', async () => {
            throw 'plain string failure';
        });
        const result = await reg.execute('unit-string-throw-job', {});
        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe('plain string failure');
    });

    // ── Queue-retry suppression ──────────────────────────────────────────
    // This catch block is the single funnel for every executor throw, which
    // makes it the only place that can decide whether BullMQ re-runs the job.
    // Getting it wrong is invisible in the happy path and expensive in the
    // failure path: `attempts: 3` with 5s exponential backoff turns one
    // throttled sync into three full re-syncs inside ~35 seconds.

    it('flags a rate-limit failure as no-retry', async () => {
        reg.register('unit-throttled-job', async () => {
            throw new IntegrationRateLimitedError('https://okta.example.com/x', 600_000);
        });
        const result = await reg.execute('unit-throttled-job', {});

        expect(result.success).toBe(false);
        // Still a recorded failure — the bypass suppresses the RETRY, not the
        // failure. A silently-succeeding throttle would be worse than the bug.
        expect(result.noRetry).toBe(true);
    });

    it('flags a revoked credential as no-retry', async () => {
        reg.register('unit-revoked-job', async () => {
            throw new IntegrationAuthError(401, 'https://graph.microsoft.com/v1.0/users');
        });
        const result = await reg.execute('unit-revoked-job', {});

        expect(result.success).toBe(false);
        expect(result.noRetry).toBe(true);
    });

    it('leaves an ordinary failure retryable', async () => {
        // The bypass must stay narrow. A transient network fault is exactly
        // what the queue's retry is for, and marking everything no-retry would
        // trade an amplification bug for a durability one.
        reg.register('unit-transient-job', async () => {
            throw new TypeError('fetch failed');
        });
        const result = await reg.execute('unit-transient-job', {});

        expect(result.success).toBe(false);
        expect(result.noRetry).toBeUndefined();
    });
});

describe('executorRegistry.execute — result-passthrough executors (mocked deps)', () => {
    const RESULT_JOBS = [
        'vendor-renewal-check',
        'deadline-monitor',
        'evidence-expiry-monitor',
        'notification-dispatch',
        'compliance-snapshot',
        'sla-monitor',
        'rule-chain-dispatch',
        'subflow-dispatch',
        'schedule-trigger-sweep',
        'compliance-digest',
        'control-test-runner',
    ];

    it.each(RESULT_JOBS)('dispatches %s through its closure to a success result', async (name) => {
        const result = await reg.execute(name, {
            tenantId: 't1',
            windows: [],
            categories: [],
            planId: 'p1',
            scheduledForIso: new Date().toISOString(),
        });
        expect(result.success).toBe(true);
    });

    const MAKERESULT_JOBS = [
        'nvd-cve-sync',
        'automation-runner',
        'daily-evidence-expiry',
        'data-lifecycle',
        'policy-review-reminder',
        'access-review-reminder',
        'access-review-overdue-escalation',
        'exception-expiry-monitor',
        'task-due-notification',
        'retention-sweep',
        'sync-pull',
        'key-rotation',
        'tenant-dek-rotation',
        'automation-event-dispatch',
        'control-test-scheduler',
        'evidence-import',
        'sharepoint-delta-sync',
        'sharepoint-delta-sync-dispatch',
        'sharepoint-policy-pull',
        'sharepoint-subscription-renew',
        'report-delivery',
        'risk-appetite-monitor',
        'risk-snapshot',
        'dau-mau-aggregator',
        'onboarding-abandonment-sweep',
        'incident-notification-deadlines',
    ];

    it.each(MAKERESULT_JOBS)('runs the %s makeResult wrapper end-to-end', async (name) => {
        const result = await reg.execute(name, {
            tenantId: 't1',
            enqueuedAt: new Date().toISOString(),
            mappingKey: { provider: 'p', remoteEntityType: 'r' },
            initiatedByUserId: 'u1',
            requestId: 'rq1',
            batchSize: 10,
            connectionId: 'c1',
            policyId: 'pol1',
            date: undefined,
            nowIso: new Date().toISOString(),
        });
        expect(result.success).toBe(true);
        expect(result.jobName).toBe(name);
    });
});

describe('executorRegistry.register — duplicate guard + reset', () => {
    it('throws on duplicate registration', () => {
        reg.register('unit-dupe-job', async () => ({
            jobName: 'unit-dupe-job',
            jobRunId: 'x',
            success: true,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 0,
            itemsScanned: 0,
            itemsActioned: 0,
            itemsSkipped: 0,
        }));
        expect(() =>
            reg.register('unit-dupe-job', async () => ({
                jobName: 'unit-dupe-job',
                jobRunId: 'y',
                success: true,
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                durationMs: 0,
                itemsScanned: 0,
                itemsActioned: 0,
                itemsSkipped: 0,
            })),
        ).toThrow(/duplicate executor registration/i);
    });

    it('_reset() clears all registrations (test-only)', () => {
        expect(reg.size).toBeGreaterThan(0);
        reg._reset();
        expect(reg.size).toBe(0);
        expect(reg.listRegistered()).toEqual([]);
        expect(reg.has('health-check')).toBe(false);
    });
});
