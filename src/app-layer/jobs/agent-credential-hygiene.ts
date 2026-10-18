/**
 * agent-credential-hygiene — the daily sweep behind the credential-hygiene pass
 * (#3670, step 2b). Scheduled at 06:00 UTC; `schedules.ts` states why.
 *
 * With a `tenantId` it runs that one tenant; without one it DISCOVERS every
 * tenant holding an unrevoked API key, an external MCP server connection, or a
 * hygiene finding that is not CLOSED, and runs each. The third set is what lets
 * a finding close after its tenant's last weak credential was revoked: with no
 * credential left the tenant would otherwise never be visited again, and an open
 * finding about a key that no longer exists would stay open for ever.
 *
 * Findings only — nothing this sweep reaches writes a credential.
 *
 * @module app-layer/jobs/agent-credential-hygiene
 */
import type { AgentCredentialHygienePayload, JobRunResult } from './types';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { recordAgentCredentialHygiene } from '@/lib/observability/integration-metrics';
import { HYGIENE_FINDING_SOURCE_KIND } from '@/lib/agentic/credential-hygiene';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import {
    runAgentCredentialHygiene,
    type HygienePassResult,
} from '../usecases/agent-credential-hygiene';

/** The tenants the sweep checks. Drained, never capped. */
async function discoverTenants(): Promise<string[]> {
    const [keys, connections, findings] = await Promise.all([
        drainPages((cursor) =>
            prisma.tenantApiKey.findMany({
                where: { revokedAt: null },
                select: { id: true, tenantId: true },
                orderBy: { id: 'asc' },
                take: DRAIN_PAGE_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
        ),
        drainPages((cursor) =>
            prisma.integrationConnection.findMany({
                where: { provider: MCP_SERVER_PROVIDER_ID },
                select: { id: true, tenantId: true },
                orderBy: { id: 'asc' },
                take: DRAIN_PAGE_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
        ),
        drainPages((cursor) =>
            prisma.finding.findMany({
                where: {
                    sourceKind: HYGIENE_FINDING_SOURCE_KIND,
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
    return [...new Set([...keys, ...connections, ...findings].map((r) => r.tenantId))].sort();
}

export async function runAgentCredentialHygieneSweep(
    payload: AgentCredentialHygienePayload,
    jobRunId: string,
): Promise<{ tenants: number; results: HygienePassResult[] }> {
    const tenantIds = payload.tenantId ? [payload.tenantId] : await discoverTenants();
    if (tenantIds.length === 0) {
        logger.warn('agentic: credential hygiene swept ZERO tenants — nothing was checked', {
            component: 'agent-credential-hygiene',
            explicitTenant: payload.tenantId ?? null,
        });
        recordAgentCredentialHygiene({ outcome: 'swept_nobody', opened: 0, reopened: 0, resolved: 0 });
        return { tenants: 0, results: [] };
    }
    const results: HygienePassResult[] = [];
    for (const tenantId of tenantIds) {
        results.push(await runAgentCredentialHygiene({ tenantId, jobRunId }));
    }
    return { tenants: tenantIds.length, results };
}

/** BullMQ executor body. */
export async function runAgentCredentialHygieneJob(
    payload: AgentCredentialHygienePayload,
): Promise<JobRunResult> {
    return runJob(
        'agent-credential-hygiene',
        async () => {
            const jobRunId = crypto.randomUUID();
            const startedAt = new Date().toISOString();
            const startMs = performance.now();
            const r = await runAgentCredentialHygieneSweep(payload, jobRunId);
            const errored = r.results.filter((x) => x.status === 'ERROR').length;
            return {
                jobName: 'agent-credential-hygiene',
                jobRunId,
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs: Math.round(performance.now() - startMs),
                itemsScanned: r.tenants,
                itemsActioned: r.results.reduce((n, x) => n + x.opened + x.reopened, 0),
                itemsSkipped: errored,
                details: {
                    opened: r.results.reduce((n, x) => n + x.opened, 0),
                    reopened: r.results.reduce((n, x) => n + x.reopened, 0),
                    resolved: r.results.reduce((n, x) => n + x.resolved, 0),
                    errored,
                },
            };
        },
        { tenantId: payload.tenantId },
    );
}
