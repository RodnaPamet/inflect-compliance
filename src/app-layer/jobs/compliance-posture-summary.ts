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
import type { PermissionSet } from '@/lib/permissions';
import type { Permissions } from '@/lib/tenant-context';
import { borrowedJobActor, BORROW_FAILURE, type BorrowFailure } from '@/app-layer/context-system';
import type { RequestContext } from '@/app-layer/types';
import { generateCompliancePostureSummary } from '@/app-layer/usecases/compliance-posture';
import { enqueue } from './queue';
import { fanOut, dispatchJobId, DAILY_BUCKET_MS } from './fan-out';
import type {
    CompliancePostureSummaryPayload,
    CompliancePostureDispatchPayload,
} from './types';

/**
 * Whether a borrowed actor's RESOLVED authority lets this job do its work:
 * `generateCompliancePostureSummary` reaches `gatherPostureSignals`,
 * which asserts `assertCanRead`.
 *
 * One definition, read by the pick below, so the job can never choose a member
 * its own usecase would then refuse (#4388).
 */
export function mayGeneratePostureSummary(authority: { permissions: Permissions; appPermissions: PermissionSet }): boolean {
    return authority.permissions.canRead === true;
}

/**
 * Build a tenant-scoped read RequestContext for the daily cron actor.
 *
 * Picks an active member (OWNER/ADMIN preferred) so RLS + the read policies
 * resolve against a real user. Comes up empty for TWO distinct reasons -- no
 * active member at all, or members none of whose resolved authority may read
 * the posture signals -- and reports which. Lives in the job layer (not the usecase)
 * because it needs a cross-tenant/global read before any tenant context
 * exists — tenant-scoped usecase code must never import global prisma.
 */
async function buildPostureCronContext(
    tenantId: string,
): Promise<{ ctx: RequestContext; reason: null } | { ctx: null; reason: BorrowFailure }> {
    // The actor is the first member IN ORDER whose resolved authority allows
    // this job's work -- custom role included. It used to be the oldest
    // OWNER/ADMIN with `getPermissionsForRole(role)`, which dropped the custom
    // role, and the coarse flags were hand-projected from granular ones rather
    // than computed from the role (#4388).
    const { actor, reason } = await borrowedJobActor({
        tenantId,
        orderBy: 'role',
        allows: mayGeneratePostureSummary,
    });
    if (!actor) return { ctx: null, reason };
    return {
        ctx: {
            requestId: `compliance-posture-${tenantId}`,
            userId: actor.userId,
            tenantId,
            role: actor.role,
            permissions: actor.permissions,
            appPermissions: actor.appPermissions,
        },
        reason: null,
    };
}

/**
 * Per-tenant runner. Builds the cron context for `payload.tenantId` and
 * regenerates the cached posture summary.
 */
export async function runCompliancePostureSummary(payload: CompliancePostureSummaryPayload) {
    const { ctx, reason } = await buildPostureCronContext(payload.tenantId);
    if (!ctx) {
        // This used to say "has no active members" unconditionally, which is
        // false for the case the pick was added for: members who exist and may
        // not read the signals. Name the reason the pick actually gave (#4388).
        logger.warn(
            reason === BORROW_FAILURE.NO_ACTIVE_MEMBER
                ? 'compliance-posture-summary: tenant has no active members, skipping'
                : 'compliance-posture-summary: no member may read posture signals, skipping',
            { component: 'compliance-posture', tenantId: payload.tenantId, reason },
        );
        return { tenantId: payload.tenantId, generated: false, reason };
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
