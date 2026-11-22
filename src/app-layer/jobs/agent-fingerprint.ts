/**
 * agent-fingerprint — the nightly agent behaviour fingerprint (Morpheus
 * roadmap Phase 1, D-L1-3: the CPU detector in the worker). Scheduled daily;
 * `schedules.ts` states the minute and why.
 *
 * OFF BY DEFAULT (G9). The sweep reads the operator's two keys first —
 * `AGENT_BEHAVIOUR_DETECTOR` and `AGENT_BEHAVIOUR_DETECTOR_TENANTS` — and a
 * deployment that has not turned both on reads no ledger, writes no row and
 * counts one `disabled` outcome. With them on, its population is exactly the
 * tenants the operator named; a named slug no tenant holds is logged and
 * skipped. With a `tenantId` it runs that one tenant, and only if the same two
 * keys admit it — a manual run is not a third way in.
 *
 * The latch is a third key (`AGENT_BEHAVIOUR_DETECTOR_LATCH`): without it a
 * threshold-B day raises its finding and stops nothing.
 *
 * @module app-layer/jobs/agent-fingerprint
 */
import type { AgentFingerprintPayload, JobRunResult } from './types';
import { env } from '@/env';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { recordAgentFingerprintPass } from '@/lib/observability/integration-metrics';
import {
    behaviourDetectorDecisionFor,
    behaviourDetectorTenantSlugs,
} from '@/lib/agentic/behaviour-detector-switch';
import {
    runAgentBehaviourFingerprint,
    type FingerprintPassResult,
} from '../usecases/agent-behaviour-fingerprint';

/** The operator's three keys, read once per run. */
export interface DetectorKeys {
    detector: string | undefined;
    tenants: string | undefined;
    latch: string | undefined;
}

function keysFromEnv(): DetectorKeys {
    return {
        detector: env.AGENT_BEHAVIOUR_DETECTOR,
        tenants: env.AGENT_BEHAVIOUR_DETECTOR_TENANTS,
        latch: env.AGENT_BEHAVIOUR_DETECTOR_LATCH,
    };
}

export interface FingerprintSweepResult {
    disabled: boolean;
    tenants: number;
    results: FingerprintPassResult[];
}

/** The sweep, with its keys and clock as arguments so a test can drive it. */
export async function runAgentFingerprintSweep(
    payload: AgentFingerprintPayload,
    jobRunId: string,
    keys: DetectorKeys = keysFromEnv(),
    now?: Date,
): Promise<FingerprintSweepResult> {
    const named = behaviourDetectorTenantSlugs(keys);
    const where = payload.tenantId
        ? { id: payload.tenantId, deletedAt: null }
        : { slug: { in: [...named] }, deletedAt: null };
    const tenants = named.length === 0
        ? []
        : await prisma.tenant.findMany({
              where,
              select: { id: true, slug: true },
              orderBy: { slug: 'asc' },
              take: payload.tenantId ? 1 : named.length,
          });

    const admitted = tenants
        .map((t) => ({ t, d: behaviourDetectorDecisionFor({ ...keys, tenantSlug: t.slug }) }))
        .filter(({ d }) => d.on);

    if (admitted.length === 0) {
        logger.info('agent behaviour fingerprint is off for this run — nothing read', {
            component: 'agent-fingerprint',
            explicitTenant: payload.tenantId ?? null,
            namedTenants: named.length,
        });
        recordAgentFingerprintPass({ outcome: 'disabled' });
        return { disabled: true, tenants: 0, results: [] };
    }
    if (!payload.tenantId && admitted.length < named.length) {
        const found = new Set(admitted.map(({ t }) => t.slug.toLowerCase()));
        logger.warn('agent behaviour fingerprint: a named tenant slug matches no live tenant', {
            component: 'agent-fingerprint',
            unmatched: named.filter((s) => !found.has(s)).length,
        });
    }

    const results: FingerprintPassResult[] = [];
    for (const { t, d } of admitted) {
        results.push(
            await runAgentBehaviourFingerprint({
                tenantId: t.id,
                tenantSlug: t.slug,
                latch: d.latch,
                jobRunId,
                triggeredBy: payload.tenantId ? 'manual' : 'scheduled',
                ...(now ? { now } : {}),
            }),
        );
    }
    return { disabled: false, tenants: admitted.length, results };
}

/** BullMQ executor body. */
export async function runAgentFingerprintJob(payload: AgentFingerprintPayload): Promise<JobRunResult> {
    return runJob(
        'agent-fingerprint',
        async () => {
            const jobRunId = crypto.randomUUID();
            const startedAt = new Date().toISOString();
            const startMs = performance.now();
            const r = await runAgentFingerprintSweep(payload, jobRunId);
            const errored = r.results.filter((x) => x.status === 'ERROR').length;
            const sum = (pick: (x: FingerprintPassResult) => number) => r.results.reduce((n, x) => n + pick(x), 0);
            return {
                jobName: 'agent-fingerprint',
                jobRunId,
                success: errored === 0,
                // Not retried: each failed tenant has its ERROR row, and a retry
                // of the same night would find the scored days and do nothing.
                ...(errored > 0 ? { errorMessage: `${errored} tenant pass(es) recorded ERROR`, noRetry: true } : {}),
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs: Math.round(performance.now() - startMs),
                itemsScanned: sum((x) => x.evaluated),
                itemsActioned: sum((x) => x.anomalous),
                itemsSkipped: errored,
                details: {
                    disabled: r.disabled,
                    tenants: r.tenants,
                    evaluated: sum((x) => x.evaluated),
                    learning: sum((x) => x.learning),
                    steady: sum((x) => x.steady),
                    anomalous: sum((x) => x.anomalous),
                    latched: sum((x) => x.latched),
                    errored,
                },
            };
        },
        { tenantId: payload.tenantId },
    );
}
