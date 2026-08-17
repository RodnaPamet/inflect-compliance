/**
 * Compliance-posture summary — daily cron.
 *
 * Two jobs (the SharePoint fan-out pattern):
 *   • `compliance-posture-summary-dispatch` — daily cross-tenant fan-out:
 *     enumerate active tenants and enqueue one per-tenant summary job each.
 *   • `compliance-posture-summary` — per-tenant: (re)generate + cache the
 *     tenant's posture summary. References `payload.tenantId`.
 *
 * The per-tenant job builds a tenant-scoped read context, calls
 * `generateCompliancePostureSummary`, and upserts the cached row. All reads +
 * the upsert run inside `runInTenantContext` (RLS-bound) one frame down.
 *
 * @module app-layer/jobs/compliance-posture-summary
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { generateCompliancePostureSummary } from '@/app-layer/usecases/compliance-posture';
import { enqueue } from './queue';
import { fanOut, dispatchJobId, DAILY_BUCKET_MS } from './fan-out';
import type {
    CompliancePostureSummaryPayload,
    CompliancePostureDispatchPayload,
} from './types';

/**
 * Build a tenant-scoped read RequestContext for the daily cron actor.
 *
 * Picks an active member (OWNER/ADMIN preferred) so RLS + the read policies
 * resolve against a real user. Returns null when the tenant has no active
 * members (nothing to summarise). Lives in the job layer (not the usecase)
 * because it needs a cross-tenant/global read before any tenant context
 * exists — tenant-scoped usecase code must never import global prisma.
 */
async function buildPostureCronContext(
    tenantId: string,
): Promise<RequestContext | null> {
    const member = await prisma.tenantMembership.findFirst({
        where: { tenantId, status: 'ACTIVE' },
        // Role is a Postgres enum ordered by declaration
        // (OWNER, ADMIN, EDITOR, READER, AUDITOR), so `asc` surfaces an
        // OWNER/ADMIN first and falls back to any active member.
        orderBy: { role: 'asc' },
        select: { userId: true, role: true },
    });
    if (!member) return null;

    const appPermissions = getPermissionsForRole(member.role);
    return {
        requestId: `compliance-posture-${tenantId}`,
        userId: member.userId,
        tenantId,
        role: member.role,
        permissions: {
            canRead: appPermissions.controls.view,
            canWrite: appPermissions.controls.create,
            canAdmin: appPermissions.admin.manage,
            canAudit: appPermissions.audits.view,
            canExport: appPermissions.reports.export,
        },
        appPermissions,
    };
}

/**
 * Per-tenant runner. Builds the cron context for `payload.tenantId` and
 * regenerates the cached posture summary.
 */
export async function runCompliancePostureSummary(payload: CompliancePostureSummaryPayload) {
    const ctx = await buildPostureCronContext(payload.tenantId);
    if (!ctx) {
        logger.warn('compliance-posture-summary: tenant has no active members, skipping', {
            component: 'compliance-posture',
            tenantId: payload.tenantId,
        });
        return { tenantId: payload.tenantId, generated: false };
    }
    const result = await generateCompliancePostureSummary(ctx);
    return {
        tenantId: payload.tenantId,
        generated: true,
        provider: result.provider,
        postureLabel: result.postureLabel,
        isFallback: result.isFallback ?? false,
    };
}

/**
 * Cross-tenant fan-out. Enqueues one per-tenant summary job per active tenant.
 */
export async function runCompliancePostureDispatch(_payload: CompliancePostureDispatchPayload) {
    const tenants = await prisma.tenant.findMany({
        where: { deletedAt: null },
        select: { id: true },
        take: 5000,
    });

    // This dispatcher already isolated failures; what it lacked was a
    // deterministic id, so a retry re-queued a summary for every tenant.
    const { dispatched, failed } = await fanOut(
        tenants,
        'compliance-posture',
        ({ id }) => ({ tenantId: id }),
        ({ id }) =>
            enqueue(
                'compliance-posture-summary',
                { tenantId: id },
                { jobId: dispatchJobId('compliance-posture-summary', id, DAILY_BUCKET_MS) },
            ),
    );

    if (failed > 0 && dispatched === 0) {
        throw new Error(`compliance-posture-summary-dispatch: all ${failed} enqueues failed`);
    }
    return { tenants: tenants.length, dispatched, failed };
}
