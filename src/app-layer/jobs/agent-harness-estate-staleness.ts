/**
 * agent-harness-estate-staleness — the daily sweep behind the stale-estate
 * alert (#3741, the alerting follow-up of step 4a). Scheduled daily;
 * `schedules.ts` states the minute and why.
 *
 * With a `tenantId` it runs that one tenant — and records a row even when the
 * tenant declares no estate, which is how an empty tenant's "evaluated 0" is
 * written down. Without one it DISCOVERS every tenant that has the harness in
 * use and runs each:
 *
 *   • a declared estate — the population the pass judges;
 *   • an unrevoked scanner key — a tenant that trusts a scanner but declares
 *     no estate has scans nobody measures against a cadence, and its row says
 *     so (NOT_APPLICABLE, `evaluated: 0`) every day rather than nothing at all;
 *   • a stale-estate finding that is not CLOSED — so a finding whose estate was
 *     removed is still reported HELD on a row, never silently forgotten.
 *
 * A tenant with none of the three has never used the harness and is not
 * visited: a daily empty row per such tenant would be noise.
 *
 * Findings only: nothing this sweep reaches writes an estate, a scan or a key.
 *
 * @module app-layer/jobs/agent-harness-estate-staleness
 */
import type { AgentHarnessEstateStalenessPayload, JobRunResult } from './types';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { recordHarnessEstateStaleness } from '@/lib/observability/integration-metrics';
import { STALE_ESTATE_FINDING_SOURCE_KIND, STALE_ESTATE_REF_PREFIX } from '@/lib/agentic/harness-estate-staleness';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import {
    runHarnessEstateStaleness,
    type EstateStalenessPassResult,
} from '../usecases/agent-harness-estate-staleness';

/** The tenants the sweep checks. Drained, never capped. */
async function discoverTenants(): Promise<string[]> {
    const [estates, keys, findings] = await Promise.all([
        drainPages((cursor) =>
            prisma.agentHarnessEstate.findMany({
                select: { id: true, tenantId: true },
                orderBy: { id: 'asc' },
                take: DRAIN_PAGE_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
        ),
        drainPages((cursor) =>
            prisma.agentHarnessScannerKey.findMany({
                where: { revokedAt: null },
                select: { id: true, tenantId: true },
                orderBy: { id: 'asc' },
                take: DRAIN_PAGE_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
        ),
        drainPages((cursor) =>
            prisma.finding.findMany({
                where: {
                    sourceKind: STALE_ESTATE_FINDING_SOURCE_KIND,
                    sourceRef: { startsWith: STALE_ESTATE_REF_PREFIX },
                    status: { not: 'CLOSED' },
                    deletedAt: null,
                },
                select: { id: true, tenantId: true },
                orderBy: { id: 'asc' },
                take: DRAIN_PAGE_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
        ),
    ]);
    return [...new Set([...estates, ...keys, ...findings].map((r) => r.tenantId))].sort();
}

export async function runHarnessEstateStalenessSweep(
    payload: AgentHarnessEstateStalenessPayload,
    jobRunId: string,
    now?: Date,
): Promise<{ tenants: number; results: EstateStalenessPassResult[] }> {
    const tenantIds = payload.tenantId ? [payload.tenantId] : await discoverTenants();
    if (tenantIds.length === 0) {
        logger.warn('agentic: harness estate staleness swept ZERO tenants — no estate was judged', {
            component: 'agent-harness-estate-staleness',
            explicitTenant: payload.tenantId ?? null,
        });
        recordHarnessEstateStaleness({ outcome: 'swept_nobody', evaluated: 0, staleByReason: {} });
        return { tenants: 0, results: [] };
    }
    const results: EstateStalenessPassResult[] = [];
    for (const tenantId of tenantIds) {
        results.push(await runHarnessEstateStaleness({ tenantId, jobRunId, ...(now ? { now } : {}) }));
    }
    return { tenants: tenantIds.length, results };
}

/** BullMQ executor body. */
export async function runHarnessEstateStalenessJob(
    payload: AgentHarnessEstateStalenessPayload,
): Promise<JobRunResult> {
    return runJob(
        'agent-harness-estate-staleness',
        async () => {
            const jobRunId = crypto.randomUUID();
            const startedAt = new Date().toISOString();
            const startMs = performance.now();
            const r = await runHarnessEstateStalenessSweep(payload, jobRunId);
            const errored = r.results.filter((x) => x.status === 'ERROR').length;
            const sum = (pick: (x: EstateStalenessPassResult) => number) => r.results.reduce((n, x) => n + pick(x), 0);
            return {
                jobName: 'agent-harness-estate-staleness',
                jobRunId,
                // A tenant whose pass threw has an ERROR row of its own; the run
                // as a whole did not judge every estate it set out to.
                success: errored === 0,
                // Not retried: each failed tenant's ERROR row is already written,
                // and tomorrow's tick is the retry, on scans that have moved.
                ...(errored > 0 ? { errorMessage: `${errored} tenant pass(es) recorded ERROR`, noRetry: true } : {}),
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs: Math.round(performance.now() - startMs),
                itemsScanned: sum((x) => x.evaluated),
                itemsActioned: sum((x) => x.opened + x.reopened + x.resolved),
                itemsSkipped: errored,
                details: {
                    tenants: r.tenants,
                    evaluated: sum((x) => x.evaluated),
                    stale: sum((x) => x.stale),
                    opened: sum((x) => x.opened),
                    reopened: sum((x) => x.reopened),
                    stillOpen: sum((x) => x.stillOpen),
                    resolved: sum((x) => x.resolved),
                    held: sum((x) => x.held),
                    noEstates: r.results.filter((x) => x.status === 'NOT_APPLICABLE').length,
                    errored,
                },
            };
        },
        { tenantId: payload.tenantId },
    );
}
