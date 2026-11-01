/**
 * SP-5 — SharePoint sync-health aggregation for the admin dashboard.
 *
 * #4873 — a health page has to tell "healthy" from "never tested" from
 * "switched off", and its figures have to be the whole population:
 *
 *   • Each connection carries `isEnabled`, so the page can say Disabled rather
 *     than a green OK for a connection that runs nothing.
 *   • Coverage is COUNTED in the database (`groupBy`), not tallied over the
 *     first 2,000 mappings, which under-counted a large import with no notice.
 *   • The documents behind Stale and Failed are listed — the first
 *     `PROBLEM_SAMPLE` of them, with `problemsTotal` saying how many there are —
 *     so a figure leads to the files it counts.
 *
 * @module integrations/providers/sharepoint/health
 */
import type { RequestContext } from '../../../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanAdmin } from '../../../policies/common';

/** How many stale or failed documents the page lists by name. */
export const PROBLEM_SAMPLE = 25;

export interface SharePointHealthProblem {
    mappingId: string;
    status: 'STALE' | 'FAILED';
    /** The evidence the file was imported as, when the mapping names one. */
    evidenceId: string | null;
    evidenceTitle: string | null;
    errorMessage: string | null;
    lastSyncedAt: string | null;
}

export interface SharePointHealth {
    connections: Array<{
        id: string;
        name: string;
        isEnabled: boolean;
        lastTestedAt: string | null;
        lastTestStatus: string | null;
    }>;
    executions: Array<{
        id: string;
        automationKey: string;
        status: string;
        triggeredBy: string;
        executedAt: string;
        durationMs: number | null;
    }>;
    evidenceCoverage: { synced: number; stale: number; failed: number; total: number };
    /** The first `PROBLEM_SAMPLE` stale or failed documents, failed first. */
    problems: SharePointHealthProblem[];
    /** How many stale or failed documents there are in all. */
    problemsTotal: number;
    policyLinks: number;
}

/** Aggregate connection health, recent executions, sync coverage + policy links. */
export async function getSharePointHealth(ctx: RequestContext): Promise<SharePointHealth> {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        const connections = await db.integrationConnection.findMany({
            where: { tenantId: ctx.tenantId, provider: 'sharepoint' },
            select: { id: true, name: true, isEnabled: true, lastTestedAt: true, lastTestStatus: true },
            take: 50,
        });

        const executions = await db.integrationExecution.findMany({
            where: { tenantId: ctx.tenantId, provider: 'sharepoint' },
            select: { id: true, automationKey: true, status: true, triggeredBy: true, executedAt: true, durationMs: true },
            orderBy: { executedAt: 'desc' },
            take: 100,
        });

        const byStatus = await db.integrationSyncMapping.groupBy({
            by: ['syncStatus'],
            where: { tenantId: ctx.tenantId, provider: 'sharepoint' },
            _count: { _all: true },
        });
        const countOf = (status: string) =>
            byStatus.find((row) => row.syncStatus === status)?._count._all ?? 0;
        const evidenceCoverage = {
            synced: countOf('SYNCED'),
            stale: countOf('STALE'),
            failed: countOf('FAILED'),
            total: byStatus.reduce((sum, row) => sum + row._count._all, 0),
        };

        const problemRows = await db.integrationSyncMapping.findMany({
            where: {
                tenantId: ctx.tenantId,
                provider: 'sharepoint',
                syncStatus: { in: ['FAILED', 'STALE'] },
            },
            select: {
                id: true,
                syncStatus: true,
                localEntityType: true,
                localEntityId: true,
                errorMessage: true,
                lastSyncedAt: true,
            },
            // FAILED sorts before STALE in the enum, so the failures, which can
            // be retried, are the ones a capped list never hides.
            orderBy: [{ syncStatus: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
            take: PROBLEM_SAMPLE,
        });
        const evidenceIds = problemRows
            .filter((m) => m.localEntityType === 'Evidence')
            .map((m) => m.localEntityId);
        const evidence = evidenceIds.length
            ? await db.evidence.findMany({
                  where: { tenantId: ctx.tenantId, id: { in: evidenceIds } },
                  select: { id: true, title: true },
                  take: evidenceIds.length,
              })
            : [];
        const titleOf = new Map(evidence.map((e) => [e.id, e.title]));

        const policyLinks = await db.policy.count({
            where: { tenantId: ctx.tenantId, spItemId: { not: null } },
        });

        return {
            connections: connections.map((c) => ({
                id: c.id,
                name: c.name,
                isEnabled: c.isEnabled,
                lastTestedAt: c.lastTestedAt ? c.lastTestedAt.toISOString() : null,
                lastTestStatus: c.lastTestStatus,
            })),
            executions: executions.map((e) => ({
                id: e.id,
                automationKey: e.automationKey,
                status: e.status,
                triggeredBy: e.triggeredBy,
                executedAt: e.executedAt.toISOString(),
                durationMs: e.durationMs,
            })),
            evidenceCoverage,
            problems: problemRows.map((m) => {
                const isEvidence = m.localEntityType === 'Evidence' && titleOf.has(m.localEntityId);
                return {
                    mappingId: m.id,
                    status: m.syncStatus === 'FAILED' ? ('FAILED' as const) : ('STALE' as const),
                    evidenceId: isEvidence ? m.localEntityId : null,
                    evidenceTitle: isEvidence ? (titleOf.get(m.localEntityId) ?? null) : null,
                    errorMessage: m.errorMessage,
                    lastSyncedAt: m.lastSyncedAt ? m.lastSyncedAt.toISOString() : null,
                };
            }),
            problemsTotal: evidenceCoverage.stale + evidenceCoverage.failed,
            policyLinks,
        };
    });
}
