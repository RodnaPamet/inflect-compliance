/**
 * The MFA policy of every workspace a session can reach, not only its first.
 *
 * Sign-in asked one workspace whether this person owes a code: the session's
 * primary workspace, which is the member's OLDEST membership. So someone who
 * joined a workspace that requires MFA after one that does not was never
 * asked for a code there. The workspace said Required, and its members walked
 * in on a password alone.
 *
 * The primary workspace keeps its existing flag, `mfaPending`, which holds the
 * whole session at the challenge (src/middleware.ts). Every OTHER reachable
 * workspace whose policy asks for a code goes in `mfaPendingTenantIds`. The
 * edge then holds that workspace's own paths, and org paths, until its own
 * challenge is passed (`pendingMfaWorkspaceSlug` in src/lib/auth/guard.ts).
 * Enrolment is per workspace (`UserMfaEnrollment` is keyed on user AND
 * tenant), so each workspace's code is its own.
 *
 * A challenge counts for this session when it was passed after the session's
 * token was issued, the rule the primary workspace already uses.
 */
import type { MfaPolicy } from '@prisma/client';
import prisma from '@/lib/prisma';

/** Whether a workspace's policy asks this person for a code at sign-in. */
export function policyAsksForCode(policy: MfaPolicy, hasVerifiedEnrollment: boolean): boolean {
    if (policy === 'REQUIRED') return true;
    if (policy === 'OPTIONAL') return hasVerifiedEnrollment;
    return false;
}

/** The workspaces among `tenantIds` whose policy asks this person for a code. */
export async function workspacesAskingForCode(
    userId: string,
    tenantIds: readonly string[],
): Promise<string[]> {
    if (tenantIds.length === 0) return [];
    const ids = [...tenantIds];
    const [settings, enrollments] = await Promise.all([
        prisma.tenantSecuritySettings.findMany({
            where: { tenantId: { in: ids } },
            select: { tenantId: true, mfaPolicy: true },
            take: ids.length,
        }),
        prisma.userMfaEnrollment.findMany({
            where: { userId, tenantId: { in: ids }, type: 'TOTP' },
            select: { tenantId: true, isVerified: true },
            take: ids.length,
        }),
    ]);
    const policyOf = new Map(settings.map((s) => [s.tenantId, s.mfaPolicy]));
    const verified = new Set(enrollments.filter((e) => e.isVerified).map((e) => e.tenantId));
    return ids.filter((id) => policyAsksForCode(policyOf.get(id) ?? 'DISABLED', verified.has(id)));
}

/**
 * `pending`, minus each workspace whose challenge this person passed at or
 * after `issuedAt` (the token's `iat`, in seconds).
 */
export async function workspacesStillAskingForCode(
    userId: string,
    pending: readonly string[],
    issuedAt: number,
): Promise<string[]> {
    if (pending.length === 0) return [];
    const ids = [...pending];
    const passed = await prisma.userMfaEnrollment.findMany({
        where: {
            userId,
            tenantId: { in: ids },
            type: 'TOTP',
            lastChallengeAt: { gte: new Date(issuedAt * 1000) },
        },
        select: { tenantId: true },
        take: ids.length,
    });
    const cleared = new Set(passed.map((p) => p.tenantId));
    return ids.filter((id) => !cleared.has(id));
}

/**
 * The pending set after the session's memberships were re-read: workspaces the
 * session left drop out, and a workspace it gained since sign-in is asked about,
 * as sign-in would have asked. `primaryTenantId` is never in the result; it is
 * `mfaPending`'s.
 */
export async function pendingAfterMembershipRefresh(
    userId: string,
    args: {
        pending: readonly string[];
        before: ReadonlySet<string>;
        after: readonly string[];
        primaryTenantId: string | null | undefined;
    },
): Promise<string[]> {
    const reachable = new Set(args.after);
    const kept = args.pending.filter((id) => reachable.has(id) && id !== args.primaryTenantId);
    const gained = args.after.filter((id) => !args.before.has(id) && id !== args.primaryTenantId);
    const asking = await workspacesAskingForCode(userId, gained);
    return [...new Set([...kept, ...asking])];
}

/**
 * The workspace a slug names, when this person is an active member of it:
 * the workspace an MFA challenge at that slug's URL verifies a code for.
 */
export async function activeMemberWorkspaceId(userId: string, slug: string): Promise<string | null> {
    const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
    if (!tenant) return null;
    const membership = await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: tenant.id, userId } },
        select: { status: true },
    });
    return membership?.status === 'ACTIVE' ? tenant.id : null;
}
