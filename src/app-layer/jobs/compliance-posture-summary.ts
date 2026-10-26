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
import type { RequestContext } from '@/app-layer/types';
import { initiatorAuthority } from '@/app-layer/context-system';
import { generateCompliancePostureSummary } from '@/app-layer/usecases/compliance-posture';
import { enqueue } from './queue';
import { fanOut, dispatchJobId, DAILY_BUCKET_MS } from './fan-out';
import type {
    CompliancePostureSummaryPayload,
    CompliancePostureDispatchPayload,
} from './types';

/**
 * Whether a member's resolved authority lets the summary be generated as them:
 * the reads `generateCompliancePostureSummary` makes refuse without the coarse
 * read flag (`assertCanRead`) and without `frameworks.view` (its framework
 * list). Every built-in role holds both, so for a tenant with no custom roles
 * the actor is the most senior member, as before. One definition, read when
 * the actor is chosen, so the job never acts as a member its own reads refuse.
 */
export function mayGeneratePostureSummary(authority: {
    permissions: Permissions;
    appPermissions: PermissionSet;
}): boolean {
    return authority.permissions.canRead && authority.appPermissions.frameworks.view === true;
}

/** Why a tenant's summary was not generated. Each is logged and returned in the job's result. */
export const POSTURE_SUMMARY_UNROUTABLE = {
    /** The tenant has no ACTIVE membership at all (nothing to summarise). */
    NO_ACTIVE_MEMBER: 'NO_ACTIVE_MEMBER',
    /** It has some, but every one's resolved permissions withhold a read the summary makes. */
    NO_MEMBER_WITH_POSTURE_READS: 'NO_MEMBER_WITH_POSTURE_READS',
} as const;
export type PostureSummaryUnroutableReason = keyof typeof POSTURE_SUMMARY_UNROUTABLE;

/**
 * Build a tenant-scoped read RequestContext for the daily cron actor.
 *
 * Picks the most senior active member (OWNER/ADMIN first) whose authority,
 * resolved as a request from them resolves it (`initiatorAuthority`, custom
 * role and coarse flags included, #4388), passes `mayGeneratePostureSummary`,
 * so RLS + the read policies resolve against a real user. A member whose custom
 * role withholds a read is passed over for the next one.
 *
 * The coarse flags used to be projected from the granular set, which gave a
 * built-in EDITOR, READER or AI_ADMIN a `canAudit` their own request does not
 * hold. They carry a request's `false` now (owner decision, 2026-10-26, as for
 * the initiator jobs in #4375); nothing on this job's path reads it. Lives in the job
 * layer (not the usecase) because it needs a cross-tenant/global read before
 * any tenant context exists — tenant-scoped usecase code must never import
 * global prisma. Exported for its test.
 */
export async function buildPostureCronContext(
    tenantId: string,
): Promise<{ ok: true; ctx: RequestContext } | { ok: false; reason: PostureSummaryUnroutableReason }> {
    // Uncapped: one tenant's active memberships, read once a day. A cap could
    // leave out the member who qualifies and report the tenant as having nobody.
    const members = await prisma.tenantMembership.findMany({
        where: { tenantId, status: 'ACTIVE' },
        // Role is a Postgres enum ordered by declaration
        // (OWNER, ADMIN, EDITOR, READER, AUDITOR, AI_ADMIN), so `asc`
        // surfaces an OWNER/ADMIN first and falls back to any active member.
        // AI_ADMIN is last on purpose (#3699): it must never sort as more
        // senior than the roles above it.
        orderBy: { role: 'asc' },
        select: {
            userId: true,
            role: true,
            customRole: { select: { baseRole: true, permissionsJson: true } },
        },
    });
    if (members.length === 0) return { ok: false, reason: POSTURE_SUMMARY_UNROUTABLE.NO_ACTIVE_MEMBER };
    for (const member of members) {
        const authority = initiatorAuthority(member);
        if (!mayGeneratePostureSummary(authority)) continue;
        return {
            ok: true,
            ctx: {
                requestId: `compliance-posture-${tenantId}`,
                userId: member.userId,
                tenantId,
                ...authority,
            },
        };
    }
    return { ok: false, reason: POSTURE_SUMMARY_UNROUTABLE.NO_MEMBER_WITH_POSTURE_READS };
}

/**
 * Per-tenant runner. Builds the cron context for `payload.tenantId` and
 * regenerates the cached posture summary.
 */
export async function runCompliancePostureSummary(payload: CompliancePostureSummaryPayload) {
    const actor = await buildPostureCronContext(payload.tenantId);
    if (!actor.ok) {
        logger.warn('compliance-posture-summary: no member to generate the summary as, skipping', {
            component: 'compliance-posture',
            tenantId: payload.tenantId,
            reason: actor.reason,
        });
        return { tenantId: payload.tenantId, generated: false, reason: actor.reason };
    }
    const result = await generateCompliancePostureSummary(actor.ctx);
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
