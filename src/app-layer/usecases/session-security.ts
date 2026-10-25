/**
 * Session Security Usecases
 *
 * Session revocation for JWT-based sessions:
 * - revokeUserSessions: every session of a target user (ADMIN or self)
 * - revokeOtherSessions: every session of the caller EXCEPT the one making the
 *   request ("Sign Out Other Sessions")
 * - revokeAllTenantSessions: every session of this tenant's ACTIVE members,
 *   the caller's current session excepted (ADMIN-only)
 * - getUserSessionVersion: read current sessionVersion (for JWT callback)
 *
 * DESIGN: Two revocation mechanisms, both checked by the auth.ts JWT callback,
 * which throws `SessionRevokedError` on either (#4119):
 *
 *   - `User.sessionVersion` — bumping it invalidates EVERY JWT the person holds,
 *     the one making the request included. It is how "revoke everything" works.
 *   - `UserSession.revokedAt` (Epic C.3) — one row per sign-in, named by the
 *     JWT's `userSessionId`. Stamping rows revokes those sign-ins only, which is
 *     the only way to sign out a person's OTHER sessions and keep this one.
 *
 * A session belongs to the person, not to a tenant: either mechanism signs the
 * person out of every workspace they belong to.
 */
import { prisma } from '@/lib/prisma';
import type { RequestContext } from '../types';
import { forbidden, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';

// ─── Types ──────────────────────────────────────────────────────────

export interface SessionRevocationResult {
    userId: string;
    newSessionVersion: number;
}

export interface OtherSessionsRevocationResult {
    userId: string;
    /**
     * TRUE when the session making the request was identified and left signed
     * in. FALSE when it could not be (no `userSessionId` on the token, or no
     * live row for it): then every session was revoked, this one included,
     * because "the others" cannot be told apart from it.
     */
    currentSessionKept: boolean;
    /** Sign-ins revoked by row. */
    sessionsRevoked: number;
}

export interface BulkRevocationResult {
    /** ACTIVE members whose sessions were revoked, the caller included. */
    usersAffected: number;
    /**
     * Whether the session making the request is still signed in. FALSE only
     * when the caller is an ACTIVE member whose current session could not be
     * identified, and so was revoked with everyone else's.
     */
    currentSessionKept: boolean;
}

// ─── The caller's current session ───────────────────────────────────

/**
 * The session making this request, when it can be named: the JWT's
 * `userSessionId` (read by the route, passed in), and only when its row is the
 * caller's own and still live. A row that is revoked, expired, absent or
 * someone else's names no session to keep.
 */
async function liveOwnSession(
    userId: string,
    currentSessionId: string | null | undefined,
): Promise<string | null> {
    if (!currentSessionId) return null;
    const row = await prisma.userSession.findUnique({
        where: { sessionId: currentSessionId },
        select: { userId: true, revokedAt: true, expiresAt: true },
    });
    if (!row || row.userId !== userId || row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return currentSessionId;
}

/**
 * Every session of these users: the version bump, then their live rows
 * stamped. Two operations, for one `$transaction`; the second's count is the
 * number of sign-ins revoked by row.
 */
function revokeEverySession(userIds: string[], reason: string, now: Date) {
    return [
        prisma.user.updateMany({
            where: { id: { in: userIds } },
            data: { sessionVersion: { increment: 1 } },
        }),
        prisma.userSession.updateMany({
            where: { userId: { in: userIds }, revokedAt: null },
            data: { revokedAt: now, revokedReason: reason },
        }),
    ];
}

/** Every live row of this user's except the one named — no version bump. */
function revokeSessionsExcept(userId: string, keptSessionId: string, reason: string, now: Date) {
    return prisma.userSession.updateMany({
        where: { userId, revokedAt: null, sessionId: { not: keptSessionId } },
        data: { revokedAt: now, revokedReason: reason },
    });
}

// ─── Revoke User Sessions ───────────────────────────────────────────

/**
 * Revokes all sessions for a target user by incrementing their sessionVersion
 * and stamping their live session rows.
 * - Self: always allowed
 * - Other user: ADMIN-only, and target must be in the same tenant
 */
export async function revokeUserSessions(
    ctx: RequestContext,
    targetUserId?: string,
): Promise<SessionRevocationResult> {
    const effectiveUserId = targetUserId || ctx.userId;

    // Non-admins can only revoke their own sessions
    if (effectiveUserId !== ctx.userId) {
        if (!ctx.permissions.canAdmin) {
            throw forbidden('Only admins can revoke other users\' sessions');
        }

        // Verify target user is in the same tenant
        const membership = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: {
                    tenantId: ctx.tenantId,
                    userId: effectiveUserId,
                },
            },
        });

        if (!membership) {
            throw notFound('Target user is not a member of this tenant');
        }
    }

    const [updated] = await prisma.$transaction([
        prisma.user.update({
            where: { id: effectiveUserId },
            data: { sessionVersion: { increment: 1 } },
            select: { id: true, sessionVersion: true },
        }),
        prisma.userSession.updateMany({
            where: { userId: effectiveUserId, revokedAt: null },
            data: {
                revokedAt: new Date(),
                revokedReason: effectiveUserId === ctx.userId ? 'user:self' : `admin:${ctx.userId}`,
            },
        }),
    ]);

    // Audit
    const action = effectiveUserId === ctx.userId ? 'CURRENT_SESSION_REVOKED' : 'SESSIONS_REVOKED_FOR_USER';
    try {
        await logEvent(prisma, ctx, {
            action,
            entityType: 'User',
            entityId: effectiveUserId,
            details: `Sessions revoked. New sessionVersion: ${updated.sessionVersion}`,
            detailsJson: { category: 'custom', event: 'unknown' },
        });
    } catch { /* audit is best-effort */ }

    return {
        userId: updated.id,
        newSessionVersion: updated.sessionVersion,
    };
}

// ─── Revoke Other Sessions ──────────────────────────────────────────

/**
 * "Sign Out Other Sessions": revokes every session of the caller's EXCEPT the
 * one making the request, which stays signed in (#4117). It used to bump
 * `sessionVersion`, which revoked the current session too and sent the caller
 * to the sign-in page under a button that promised the opposite.
 *
 * `currentSessionId` is the request JWT's `userSessionId`. When it names no
 * live session of the caller's, the others cannot be told apart from this
 * one, so everything is revoked — the fail direction that still signs out a
 * stolen session — and `currentSessionKept` says so.
 */
export async function revokeOtherSessions(
    ctx: RequestContext,
    currentSessionId: string | null,
): Promise<OtherSessionsRevocationResult> {
    const kept = await liveOwnSession(ctx.userId, currentSessionId);
    const now = new Date();

    if (!kept) {
        const [, rows] = await prisma.$transaction(
            revokeEverySession([ctx.userId], 'user:sign-out-all', now),
        );
        const sessionsRevoked = rows.count;
        try {
            await logEvent(prisma, ctx, {
                action: 'CURRENT_SESSION_REVOKED',
                entityType: 'User',
                entityId: ctx.userId,
                details:
                    'Sign out other sessions: the current session could not be identified, ' +
                    'so every session was revoked, this one included.',
                detailsJson: {
                    category: 'access',
                    operation: 'sessions_revoked',
                    detail: 'CURRENT_SESSION_NOT_IDENTIFIED',
                },
            });
        } catch { /* audit is best-effort */ }
        return { userId: ctx.userId, currentSessionKept: false, sessionsRevoked };
    }

    const rows = await revokeSessionsExcept(ctx.userId, kept, 'user:sign-out-others', now);
    try {
        await logEvent(prisma, ctx, {
            action: 'OTHER_SESSIONS_REVOKED',
            entityType: 'User',
            entityId: ctx.userId,
            details: `Signed out ${rows.count} other session(s); the current session was kept.`,
            detailsJson: {
                category: 'access',
                operation: 'other_sessions_revoked',
                detail: `${rows.count} session(s) revoked`,
            },
        });
    } catch { /* audit is best-effort */ }

    return { userId: ctx.userId, currentSessionKept: true, sessionsRevoked: rows.count };
}

// ─── Revoke All Tenant Sessions ─────────────────────────────────────

/**
 * Revokes every session of this tenant's ACTIVE members (#4117, owner
 * decision). ADMIN-only. Useful after a security incident.
 *
 * - A session belongs to the PERSON, so each member is signed out of every
 *   workspace they belong to, not only this one. The confirm dialog says so.
 * - DEACTIVATED, REMOVED and INVITED members are left alone: they cannot open
 *   this workspace, and revoking their sessions would only sign them out of
 *   the other workspaces they still work in.
 * - The caller's current session is kept, as with "Sign Out Other Sessions";
 *   their other sessions are revoked. When the current session cannot be
 *   identified the caller is signed out with everyone else.
 */
export async function revokeAllTenantSessions(
    ctx: RequestContext,
    currentSessionId: string | null,
): Promise<BulkRevocationResult> {
    if (!ctx.permissions.canAdmin) {
        throw forbidden('Only admins can revoke all tenant sessions');
    }

    const memberships = await prisma.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId, status: 'ACTIVE' },
        select: { userId: true },
    });
    const memberIds = memberships.map((m) => m.userId);

    if (memberIds.length === 0) {
        return { usersAffected: 0, currentSessionKept: true };
    }

    const callerIsMember = memberIds.includes(ctx.userId);
    const kept = callerIsMember ? await liveOwnSession(ctx.userId, currentSessionId) : null;
    const everyone = kept ? memberIds.filter((id) => id !== ctx.userId) : memberIds;
    const reason = `admin:revoke-all:${ctx.userId}`;
    const now = new Date();

    await prisma.$transaction([
        ...(everyone.length > 0 ? revokeEverySession(everyone, reason, now) : []),
        ...(kept ? [revokeSessionsExcept(ctx.userId, kept, reason, now)] : []),
    ]);

    const usersAffected = everyone.length + (kept ? 1 : 0);

    // Audit
    try {
        await logEvent(prisma, ctx, {
            action: 'ALL_TENANT_SESSIONS_REVOKED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details:
                `Revoked sessions for ${usersAffected} active members` +
                (kept ? '; the current session was kept.' : '.'),
            detailsJson: { category: 'access', operation: 'all_tenant_sessions_revoked', detail: 'ALL_TENANT_SESSIONS_REVOKED' },
        });
    } catch { /* audit is best-effort */ }

    // FALSE only when the caller was signed out with everyone else: a caller
    // who is not an ACTIVE member here was not revoked at all.
    return { usersAffected, currentSessionKept: kept !== null || !callerIsMember };
}

// ─── Get Session Version ────────────────────────────────────────────

/**
 * Returns the current sessionVersion for a user.
 * Used by the auth.ts JWT callback to check for forced reauth.
 */
export async function getUserSessionVersion(
    userId: string,
): Promise<number> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { sessionVersion: true },
    });

    return user?.sessionVersion ?? 0;
}
