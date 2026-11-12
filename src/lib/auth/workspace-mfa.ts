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
 * A challenge counts for this session only when THIS session passed it: the
 * pass is recorded on the session's own `UserSession` row
 * (`mfaPassedTenantIds`). Comparing the enrolment's `lastChallengeAt` with the
 * token's issue time, as this used to, let any session's pass clear every older
 * session of the same person.
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
 * `pending`, minus each workspace whose challenge THIS session passed:
 * the ones its own `UserSession` row lists. No session row, or a row that is
 * not this person's, clears nothing.
 */
export async function workspacesStillAskingForCode(
    userId: string,
    pending: readonly string[],
    userSessionId: string | null | undefined,
): Promise<string[]> {
    if (pending.length === 0) return [];
    const passed = await workspacesPassedBySession(userId, userSessionId);
    return pending.filter((id) => !passed.has(id));
}

/** The workspaces whose MFA challenge the session named by `userSessionId` passed. */
export async function workspacesPassedBySession(
    userId: string,
    userSessionId: string | null | undefined,
): Promise<Set<string>> {
    if (!userSessionId) return new Set();
    const row = await prisma.userSession.findUnique({
        where: { sessionId: userSessionId },
        select: { userId: true, mfaPassedTenantIds: true },
    });
    if (!row || row.userId !== userId) return new Set();
    return new Set(row.mfaPassedTenantIds);
}

/**
 * The MFA state after the session's memberships were re-read: workspaces the
 * session left drop out, and a workspace it gained since sign-in is asked about,
 * as sign-in would have asked.
 *
 * The primary workspace can change on a re-read (the oldest membership was
 * removed, its workspace deleted, or it now enforces SSO). Its pending state
 * moves with it: everything pending before, the old primary included when
 * `primaryPendingBefore`, is one set, and the new primary's flag is read from
 * that set. Before, the new primary was dropped from the set and its own flag
 * was never raised, so a workspace that still wanted a code stopped asking.
 *
 * `pending` never contains `primaryTenantId`; `primaryPending` is its flag.
 */
export async function pendingAfterMembershipRefresh(
    userId: string,
    args: {
        pending: readonly string[];
        before: ReadonlySet<string>;
        after: readonly string[];
        primaryTenantId: string | null | undefined;
        /** The primary before the re-read, and whether it still wanted a code. */
        primaryBefore?: string | null;
        primaryPendingBefore?: boolean;
    },
): Promise<{ pending: string[]; primaryPending: boolean }> {
    const reachable = new Set(args.after);
    const wasPending = new Set(args.pending);
    if (args.primaryPendingBefore && args.primaryBefore) wasPending.add(args.primaryBefore);
    const kept = [...wasPending].filter((id) => reachable.has(id));
    const gained = args.after.filter((id) => !args.before.has(id));
    const asking = await workspacesAskingForCode(userId, gained);
    const all = new Set([...kept, ...asking]);
    const primaryPending = args.primaryTenantId ? all.has(args.primaryTenantId) : false;
    if (args.primaryTenantId) all.delete(args.primaryTenantId);
    return { pending: [...all], primaryPending };
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

/** The refusal for a workspace that still wants this session's code: the edge's own words. */
export const WORKSPACE_MFA_REQUIRED = 'MFA verification required';

/**
 * Does this workspace still want an MFA code from this session?
 *
 * Sign-in asks every workspace in the session's membership claim, and the edge
 * holds the pending ones. The claim is capped (`MAX_JWT_MEMBERSHIPS`), so a
 * workspace past the cap was never asked and the edge cannot hold it: the
 * server tenant gate asks here instead. A workspace in the claim costs no
 * query; one outside it is asked whether it wants a code, and whether this
 * session passed its challenge.
 */
export async function workspaceStillAsksThisSession(args: {
    userId: string;
    tenantId: string;
    claimedTenantIds: readonly string[];
    pendingTenantIds: readonly string[];
    sessionId: () => Promise<string | null>;
}): Promise<boolean> {
    if (args.pendingTenantIds.includes(args.tenantId)) return true;
    if (args.claimedTenantIds.includes(args.tenantId)) return false;
    const asking = await workspacesAskingForCode(args.userId, [args.tenantId]);
    if (asking.length === 0) return false;
    const passed = await workspacesPassedBySession(args.userId, await args.sessionId());
    return !passed.has(args.tenantId);
}
