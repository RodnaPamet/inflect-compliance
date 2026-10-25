/**
 * Unit tests for src/app-layer/usecases/session-security.ts
 *
 * Wave 4 of GAP-02. JWT revocation works by incrementing
 * `User.sessionVersion`. The auth callback compares the JWT's stamped
 * version against the DB on every request. A regression here breaks
 * the only mechanism we have to force-logout a compromised user.
 *
 * Behaviours protected:
 *   1. revokeUserSessions: self-revoke is always allowed (no admin
 *      check); revoking ANOTHER user requires canAdmin AND the target
 *      must share the caller's tenant.
 *   2. The membership lookup keys on `tenantId_userId` — a refactor
 *      that lookups by `userId` alone would let admin in tenant A
 *      revoke admin in tenant B.
 *   3. revokeAllTenantSessions is canAdmin-only and revokes every
 *      ACTIVE member's sessions — never a deactivated member's — keeping
 *      the caller's current session (#4117).
 *   3b. revokeOtherSessions ("Sign Out Other Sessions") revokes every
 *      session of the caller's EXCEPT the one making the request, and
 *      bumps no sessionVersion, which would sign that one out too (#4117).
 *   4. Audit emit is best-effort (failure NEVER blocks the revoke).
 *   5. getUserSessionVersion returns 0 when the user row is absent
 *      (safe default — auth callback treats this as "no session has
 *      ever been issued for this user").
 */

jest.mock('@/lib/prisma', () => ({
    prisma: {
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        userSession: {
            findUnique: jest.fn(),
            updateMany: jest.fn(),
        },
        tenantMembership: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
        // The array form: every op is already a (mocked) promise.
        $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
    },
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    revokeUserSessions,
    revokeOtherSessions,
    revokeAllTenantSessions,
    getUserSessionVersion,
} from '@/app-layer/usecases/session-security';
import { prisma } from '@/lib/prisma';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockUserFindUnique = prisma.user.findUnique as jest.MockedFunction<typeof prisma.user.findUnique>;
const mockUserUpdate = prisma.user.update as jest.MockedFunction<typeof prisma.user.update>;
const mockUserUpdateMany = prisma.user.updateMany as jest.MockedFunction<typeof prisma.user.updateMany>;
const mockMembershipFindUnique = prisma.tenantMembership.findUnique as jest.MockedFunction<typeof prisma.tenantMembership.findUnique>;
const mockMembershipFindMany = prisma.tenantMembership.findMany as jest.MockedFunction<typeof prisma.tenantMembership.findMany>;
const mockSessionFindUnique = prisma.userSession.findUnique as jest.MockedFunction<typeof prisma.userSession.findUnique>;
const mockSessionUpdateMany = prisma.userSession.updateMany as jest.MockedFunction<typeof prisma.userSession.updateMany>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

/** A live session row of the caller's (`makeRequestContext` userId is `user-1`). */
const liveOwnRow = (overrides: Record<string, unknown> = {}) =>
    ({
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 3_600_000),
        ...overrides,
    }) as never;

beforeEach(() => {
    jest.clearAllMocks();
    mockUserUpdate.mockResolvedValue({ id: 'user-1', sessionVersion: 2 } as never);
    mockUserUpdateMany.mockResolvedValue({ count: 0 } as never);
    mockSessionUpdateMany.mockResolvedValue({ count: 0 } as never);
    // RESET, not clear: a `…Once` value a test queued and the code never read
    // (no session id → no lookup) would otherwise leak into the next test.
    mockSessionFindUnique.mockReset().mockResolvedValue(null);
});

describe('revokeUserSessions — self vs other', () => {
    it('allows self-revoke without admin check (no canAdmin required)', async () => {
        const ctx = makeRequestContext('READER'); // even READER can self-revoke

        await revokeUserSessions(ctx, ctx.userId);

        // Regression: a refactor that tightened the gate to canAdmin
        // for ALL revokes would prevent users from logging themselves
        // out — the absolute baseline session-security control.
        expect(mockMembershipFindUnique).not.toHaveBeenCalled();
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ctx.userId },
                data: { sessionVersion: { increment: 1 } },
            }),
        );
    });

    it('rejects EDITOR revoking ANOTHER user (canAdmin required for cross-user revoke)', async () => {
        await expect(
            revokeUserSessions(makeRequestContext('EDITOR'), 'other-user'),
        ).rejects.toThrow(/Only admins/);
    });

    it('rejects ADMIN when target is NOT a member of the same tenant', async () => {
        mockMembershipFindUnique.mockResolvedValueOnce(null);

        await expect(
            revokeUserSessions(
                makeRequestContext('ADMIN', { tenantId: 'tenant-A' }),
                'tenant-B-user',
            ),
        ).rejects.toThrow(/not a member/);
        // Regression: a refactor that dropped the membership check
        // would let admin in A revoke admin in B's sessions — a
        // cross-tenant denial-of-service vector.
    });

    it('looks up membership keyed on tenantId_userId (composite, not userId alone)', async () => {
        mockMembershipFindUnique.mockResolvedValueOnce({
            id: 'm1', tenantId: 'tenant-1', userId: 'other',
        } as never);

        await revokeUserSessions(makeRequestContext('ADMIN'), 'other');

        expect(mockMembershipFindUnique).toHaveBeenCalledWith({
            where: {
                tenantId_userId: { tenantId: 'tenant-1', userId: 'other' },
            },
        });
    });

    it('audit emit is best-effort — revoke succeeds even if logEvent throws', async () => {
        mockLog.mockRejectedValueOnce(new Error('audit-chain-down'));

        const result = await revokeUserSessions(makeRequestContext('READER'));

        expect(result.newSessionVersion).toBe(2);
        // Regression: a refactor that let audit failure abort the revoke
        // would leave a compromised user with active sessions during
        // an audit-chain outage — the WORST possible window for this.
    });
});

describe('revokeUserSessions — an Owner or AI admin is an Owner\'s to sign out (owner decision, 2026-10-25)', () => {
    const member = (role: string) =>
        mockMembershipFindUnique.mockResolvedValueOnce({ id: 'm1', tenantId: 'tenant-1', userId: 'other', role } as never);

    it.each(['OWNER', 'AI_ADMIN'])('refuses an ADMIN revoking a %s, by name, and revokes nothing', async (role) => {
        member(role);
        const err = await revokeUserSessions(makeRequestContext('ADMIN'), 'other').catch((e) => e);
        expect(err).toMatchObject({
            status: 403,
            details: { reason: 'REVOKING_OWNER_MANAGED_SESSIONS_IS_OWNER_TIER' },
        });
        expect(err.message).toBe(`Only an OWNER can revoke an ${role}'s sessions.`);
        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(mockSessionUpdateMany).not.toHaveBeenCalled();
    });

    it.each(['OWNER', 'AI_ADMIN'])('lets an OWNER revoke a %s', async (role) => {
        member(role);
        await revokeUserSessions(makeRequestContext('OWNER'), 'other');
        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'other' } }));
    });

    it('still lets an ADMIN revoke an EDITOR or another ADMIN', async () => {
        member('EDITOR');
        await revokeUserSessions(makeRequestContext('ADMIN'), 'other');
        member('ADMIN');
        await revokeUserSessions(makeRequestContext('ADMIN'), 'other');
        expect(mockUserUpdate).toHaveBeenCalledTimes(2);
    });

    it('still lets an Owner-managed member revoke their own sessions', async () => {
        const ctx = makeRequestContext('AI_ADMIN');
        await revokeUserSessions(ctx, ctx.userId);
        expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ctx.userId } }));
    });

    it('Revoke All is not narrowed: an ADMIN still signs out every active member, Owners included', async () => {
        mockMembershipFindMany.mockResolvedValueOnce([{ userId: 'owner-1' }, { userId: 'ai-1' }] as never);
        const result = await revokeAllTenantSessions(makeRequestContext('ADMIN'), null);
        expect(result.usersAffected).toBe(2);
        expect(mockMembershipFindUnique).not.toHaveBeenCalled();
    });
});

describe('revokeOtherSessions — "Sign Out Other Sessions" keeps this session', () => {
    it('revokes every OTHER row of the caller and bumps no sessionVersion', async () => {
        // #4117: this used to delegate to revokeUserSessions, whose version bump
        // invalidates EVERY JWT the person holds — the one making the request
        // included — so the button signed its own user out.
        mockSessionFindUnique.mockResolvedValueOnce(liveOwnRow());
        mockSessionUpdateMany.mockResolvedValueOnce({ count: 3 } as never);
        const ctx = makeRequestContext('READER');

        const result = await revokeOtherSessions(ctx, 'sess-current');

        expect(result).toEqual({ userId: ctx.userId, currentSessionKept: true, sessionsRevoked: 3 });
        expect(mockSessionUpdateMany).toHaveBeenCalledTimes(1);
        expect(mockSessionUpdateMany).toHaveBeenCalledWith({
            where: { userId: ctx.userId, revokedAt: null, sessionId: { not: 'sess-current' } },
            data: expect.objectContaining({ revokedAt: expect.any(Date), revokedReason: 'user:sign-out-others' }),
        });
        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(mockUserUpdateMany).not.toHaveBeenCalled();
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            ctx,
            expect.objectContaining({ action: 'OTHER_SESSIONS_REVOKED', entityId: ctx.userId }),
        );
    });

    it.each([
        ['no session id on the token', null, null],
        ['no row for the id', 'sess-x', null],
        ["someone else's row", 'sess-x', liveOwnRow({ userId: 'other-user' })],
        ['a revoked row', 'sess-x', liveOwnRow({ revokedAt: new Date() })],
        ['an expired row', 'sess-x', liveOwnRow({ expiresAt: new Date(Date.now() - 1000) })],
    ])('with %s, revokes everything, this session included, and says so', async (_label, id, row) => {
        // The others cannot be told apart from this one, so the fail direction
        // is the one that still signs a stolen session out.
        mockSessionFindUnique.mockResolvedValueOnce(row);
        const ctx = makeRequestContext('READER');

        const result = await revokeOtherSessions(ctx, id);

        expect(result.currentSessionKept).toBe(false);
        expect(mockUserUpdateMany).toHaveBeenCalledWith({
            where: { id: { in: [ctx.userId] } },
            data: { sessionVersion: { increment: 1 } },
        });
        expect(mockSessionUpdateMany).toHaveBeenCalledWith({
            where: { userId: { in: [ctx.userId] }, revokedAt: null },
            data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        });
    });
});

describe('revokeAllTenantSessions', () => {
    it('rejects EDITOR (admin-only)', async () => {
        await expect(
            revokeAllTenantSessions(makeRequestContext('EDITOR'), 'sess-current'),
        ).rejects.toThrow(/Only admins/);
    });

    it('returns {usersAffected: 0} when the tenant has no active memberships', async () => {
        mockMembershipFindMany.mockResolvedValueOnce([] as never);

        const result = await revokeAllTenantSessions(makeRequestContext('ADMIN'), 'sess-current');

        expect(result.usersAffected).toBe(0);
        expect(mockUserUpdateMany).not.toHaveBeenCalled();
        expect(mockSessionUpdateMany).not.toHaveBeenCalled();
    });

    it('reads ACTIVE members only — a deactivated member is left alone', async () => {
        // #4117 (owner decision): a session belongs to the person, so revoking a
        // deactivated member's sessions would only sign them out of the OTHER
        // workspaces they still work in. The query used to carry no status.
        mockMembershipFindMany.mockResolvedValueOnce([] as never);

        await revokeAllTenantSessions(makeRequestContext('ADMIN', { tenantId: 'tenant-A' }), null);

        expect(mockMembershipFindMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-A', status: 'ACTIVE' },
            select: { userId: true },
        });
    });

    it("revokes every other member's sessions and the caller's OTHER sessions, keeping this one", async () => {
        mockMembershipFindMany.mockResolvedValueOnce([
            { userId: 'u1' }, { userId: 'user-1' }, { userId: 'u3' },
        ] as never);
        mockSessionFindUnique.mockResolvedValueOnce(liveOwnRow());
        const ctx = makeRequestContext('ADMIN');

        const result = await revokeAllTenantSessions(ctx, 'sess-current');

        expect(result).toEqual({ usersAffected: 3, currentSessionKept: true });
        // The caller is NOT in the version bump: it would end this session too.
        expect(mockUserUpdateMany).toHaveBeenCalledWith({
            where: { id: { in: ['u1', 'u3'] } },
            data: { sessionVersion: { increment: 1 } },
        });
        expect(mockSessionUpdateMany).toHaveBeenCalledWith({
            where: { userId: { in: ['u1', 'u3'] }, revokedAt: null },
            data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        });
        expect(mockSessionUpdateMany).toHaveBeenCalledWith({
            where: { userId: ctx.userId, revokedAt: null, sessionId: { not: 'sess-current' } },
            data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        });
    });

    it("leaves the caller's sessions alone when the caller is not an ACTIVE member here", async () => {
        mockMembershipFindMany.mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u2' }] as never);

        const result = await revokeAllTenantSessions(makeRequestContext('ADMIN'), 'sess-current');

        expect(result).toEqual({ usersAffected: 2, currentSessionKept: true });
        expect(mockUserUpdateMany).toHaveBeenCalledWith({
            where: { id: { in: ['u1', 'u2'] } },
            data: { sessionVersion: { increment: 1 } },
        });
        expect(mockSessionFindUnique).not.toHaveBeenCalled();
    });

    it('signs the caller out with everyone when the current session cannot be identified', async () => {
        mockMembershipFindMany.mockResolvedValueOnce([
            { userId: 'u1' }, { userId: 'user-1' },
        ] as never);

        const result = await revokeAllTenantSessions(makeRequestContext('ADMIN'), null);

        expect(result).toEqual({ usersAffected: 2, currentSessionKept: false });
        expect(mockUserUpdateMany).toHaveBeenCalledWith({
            where: { id: { in: ['u1', 'user-1'] } },
            data: { sessionVersion: { increment: 1 } },
        });
    });
});

describe('getUserSessionVersion', () => {
    it('returns sessionVersion from the User row', async () => {
        mockUserFindUnique.mockResolvedValueOnce({ sessionVersion: 7 } as never);
        const v = await getUserSessionVersion('u1');
        expect(v).toBe(7);
    });

    it('returns 0 when the user row is missing (safe default)', async () => {
        mockUserFindUnique.mockResolvedValueOnce(null);
        const v = await getUserSessionVersion('missing');
        // Regression: returning undefined would force the auth callback's
        // strict-equality compare to fail and force-logout every JWT
        // for that userId — a real cascade if the user row is mid-delete.
        expect(v).toBe(0);
    });
});
