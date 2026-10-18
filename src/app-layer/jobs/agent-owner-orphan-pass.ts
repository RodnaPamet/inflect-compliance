/**
 * agent-owner-orphan-pass — the daily sweep behind the owner-orphan pass
 * (#3670, step 2b). Scheduled at 05:15 UTC; `schedules.ts` states why.
 *
 * With a `tenantId` it runs that one tenant; without one it DISCOVERS every
 * tenant that holds a live, non-placeholder registered agent, plus every tenant
 * whose orphan-pass mode is not DISABLED, and runs each. The second half is
 * what lets a DRY_RUN tenant with no agent left record `NO_ACTIVE_AGENTS` rather
 * than nothing — the dwell gate counts those rows. Discovery is DRAINED, never
 * `take`-capped: a capped tenant list and a true one are indistinguishable at
 * the boundary, and the tail is other people's agents going unchecked.
 *
 * One tenant's pass never aborts the sweep: `runAgentOwnerOrphanPass` turns a
 * throw into that tenant's own ERROR row and returns.
 *
 * @module app-layer/jobs/agent-owner-orphan-pass
 */
import type { AgentOwnerOrphanPassPayload, JobRunResult } from './types';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { recordAgentOwnerOrphanPass } from '@/lib/observability/integration-metrics';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import {
    runAgentOwnerOrphanPass,
    type OrphanPassResult,
} from '../usecases/agent-owner-orphan-pass';

/** The tenants the sweep checks. See the module header. */
async function discoverTenants(): Promise<string[]> {
    const [withAgents, configured] = await Promise.all([
        drainPages((cursor) =>
            prisma.registeredAgent.findMany({
                where: { deletedAt: null, isLegacyPlaceholder: false },
                select: { id: true, tenantId: true },
                orderBy: { id: 'asc' },
                take: DRAIN_PAGE_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
        ),
        drainPages((cursor) =>
            prisma.tenantSecuritySettings.findMany({
                where: { agentOrphanPassMode: { not: 'DISABLED' } },
                select: { id: true, tenantId: true },
                orderBy: { id: 'asc' },
                take: DRAIN_PAGE_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
        ),
    ]);
    return [...new Set([...withAgents, ...configured].map((r) => r.tenantId))].sort();
}

export async function runAgentOwnerOrphanPassSweep(
    payload: AgentOwnerOrphanPassPayload,
    jobRunId: string,
): Promise<{ tenants: number; results: OrphanPassResult[] }> {
    const tenantIds = payload.tenantId ? [payload.tenantId] : await discoverTenants();

    // A SWEEP THAT CHECKED NOBODY IS NOT A SWEEP THAT PASSED — the drill's
    // lesson. No row can be written without a tenant, so the positive
    // assertion is a counter tick operators can alert on.
    if (tenantIds.length === 0) {
        logger.warn('agentic: owner-orphan pass swept ZERO tenants — nobody was checked', {
            component: 'agent-owner-orphan-pass',
            explicitTenant: payload.tenantId ?? null,
        });
        recordAgentOwnerOrphanPass({ outcome: 'swept_nobody', mode: 'none', orphans: 0 });
        return { tenants: 0, results: [] };
    }

    const slugs = new Map(
        (
            await prisma.tenant.findMany({
                where: { id: { in: tenantIds } },
                select: { id: true, slug: true },
                take: tenantIds.length,
            })
        ).map((t) => [t.id, t.slug]),
    );

    const results: OrphanPassResult[] = [];
    for (const tenantId of tenantIds) {
        results.push(
            await runAgentOwnerOrphanPass({ tenantId, tenantSlug: slugs.get(tenantId), jobRunId }),
        );
    }
    return { tenants: tenantIds.length, results };
}

/** BullMQ executor body. */
export async function runAgentOwnerOrphanPassJob(
    payload: AgentOwnerOrphanPassPayload,
): Promise<JobRunResult> {
    return runJob(
        'agent-owner-orphan-pass',
        async () => {
            const jobRunId = crypto.randomUUID();
            const startedAt = new Date().toISOString();
            const startMs = performance.now();
            const r = await runAgentOwnerOrphanPassSweep(payload, jobRunId);
            const errored = r.results.filter((x) => x.status === 'ERROR').length;
            return {
                jobName: 'agent-owner-orphan-pass',
                jobRunId,
                // The JOB succeeded whenever it ran every tenant it set out to;
                // a tenant whose pass broke is its own ERROR row and counter
                // tick. Failing the job would retry it, and a retry of a pass
                // that stops agents is not something to do three times in a
                // minute.
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs: Math.round(performance.now() - startMs),
                itemsScanned: r.tenants,
                itemsActioned: r.results.reduce((n, x) => n + x.contained, 0),
                itemsSkipped: errored,
                details: {
                    orphans: r.results.reduce((n, x) => n + x.orphans, 0),
                    failed: r.results.reduce((n, x) => n + x.failed, 0),
                    errored,
                },
            };
        },
        { tenantId: payload.tenantId },
    );
}
