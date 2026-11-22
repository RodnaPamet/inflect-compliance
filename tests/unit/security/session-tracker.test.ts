/**
 * Unit tests for `src/lib/security/session-tracker.ts` (Epic C.3).
 *
 * Verifies the operational session-row lifecycle independently of the
 * NextAuth flow: minting, verification (revoked vs live), throttled
 * `lastActiveAt` touch, and `revokeSessionById`.
 */

// ─── Mocks (declared before imports — Jest hoists `jest.mock`) ───

const mockUserSession = {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
};

const mockTenantSecuritySettings = {
    findUnique: jest.fn(),
};

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        userSession: mockUserSession,
        tenantSecuritySettings: mockTenantSecuritySettings,
    },
    prisma: {
        userSession: mockUserSession,
        tenantSecuritySettings: mockTenantSecuritySettings,
    },
}));

// `next/headers` only resolves inside a request scope. Stub a Headers
// instance so the IP/UA capture code path is exercised here too.
jest.mock(
    'next/headers',
    () => ({
        headers: () => {
            const h = new Headers();
            h.set('x-forwarded-for', '203.0.113.7, 10.0.0.1');
            h.set('user-agent', 'jest/29 (test runner)');
            return h;
        },
    }),
    { virtual: true },
);

import {
    recordNewSession,
    verifyAndTouchSession,
    revokeSessionById,
    listActiveSessionsForTenant,
    listActiveSessionsForUserInTenant,
    countActiveSessionsForTenantUsers,
} from '@/lib/security/session-tracker';

beforeEach(() => {
    Object.values(mockUserSession).forEach((fn) => fn.mockReset?.());
    Object.values(mockTenantSecuritySettings).forEach((fn) => fn.mockReset?.());
    // Default: no tenant policy → unlimited concurrent sessions, no
    // duration cap. Individual tests override as needed.
    mockTenantSecuritySettings.findUnique.mockResolvedValue(null);
    mockUserSession.findMany.mockResolvedValue([]);
});

// ─── recordNewSession ───────────────────────────────────────────────

describe('recordNewSession', () => {
    it('persists ipAddress + userAgent + expiresAt and returns a 32-char sessionId', async () => {
        mockUserSession.create.mockResolvedValue({ id: 'row-1' });

        const expiresAt = new Date('2027-01-01T00:00:00Z');
        const out = await recordNewSession({
            userId: 'user-1',
            tenantId: 'tenant-1',
            expiresAt,
        });

        expect(out.sessionId).toMatch(/^[a-f0-9]{32}$/);
        expect(out.rowId).toBe('row-1');
        expect(mockUserSession.create).toHaveBeenCalledTimes(1);
        const data = mockUserSession.create.mock.calls[0][0].data;
        expect(data.userId).toBe('user-1');
        expect(data.tenantId).toBe('tenant-1');
        // Left-most XFF entry — original client IP.
        expect(data.ipAddress).toBe('203.0.113.7');
        expect(data.userAgent).toBe('jest/29 (test runner)');
        expect(data.expiresAt).toEqual(expiresAt);
    });

    it('returns a placeholder rowId on DB failure (sign-in must not break)', async () => {
        mockUserSession.create.mockRejectedValue(new Error('DB unavailable'));
        const out = await recordNewSession({
            userId: 'user-1',
            tenantId: null,
            expiresAt: new Date(),
        });
        expect(out.sessionId).toMatch(/^[a-f0-9]{32}$/);
        expect(out.rowId).toBe('');
    });
});

// ─── verifyAndTouchSession ─────────────────────────────────────────

describe('verifyAndTouchSession', () => {
    it('returns revoked=true when revokedAt is set', async () => {
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-1',
            revokedAt: new Date(),
            lastActiveAt: new Date(),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        const out = await verifyAndTouchSession('sid');
        // `touched: false` — a revoked row is not stamped, so it offers the
        // caller no claims-refresh signal (#5246).
        expect(out).toEqual({ revoked: true, rowId: 'row-1', touched: false });
        expect(mockUserSession.update).not.toHaveBeenCalled();
    });

    it('returns revoked=false (no rowId) when no row exists — legacy tokens still work', async () => {
        mockUserSession.findUnique.mockResolvedValue(null);
        const out = await verifyAndTouchSession('sid');
        // No row means no persisted cadence at all. The jwt callback reads this
        // as "no signal" and falls back to its own timing rather than never
        // refreshing the claims (#5246).
        expect(out).toEqual({ revoked: false, rowId: null, touched: false });
        expect(mockUserSession.update).not.toHaveBeenCalled();
    });

    it('skips touch when last write is recent (throttle)', async () => {
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-1',
            revokedAt: null,
            lastActiveAt: new Date(),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        const out = await verifyAndTouchSession('sid');
        // Within the interval: no write, and so no claims refresh this request.
        expect(out).toEqual({ revoked: false, rowId: 'row-1', touched: false });
        expect(mockUserSession.update).not.toHaveBeenCalled();
    });

    it('updates lastActiveAt when last write is older than 5 minutes', async () => {
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-1',
            revokedAt: null,
            lastActiveAt: new Date(Date.now() - 6 * 60 * 1000),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        const out = await verifyAndTouchSession('sid');
        expect(mockUserSession.update).toHaveBeenCalledTimes(1);
        const args = mockUserSession.update.mock.calls[0][0];
        expect(args.where).toEqual({ id: 'row-1' });
        expect(args.data.lastActiveAt).toBeInstanceOf(Date);
        // THE signal the claims refresh is throttled on (#5246): true only
        // when the interval actually elapsed and the write happened.
        expect(out.touched).toBe(true);
    });

    it('reports touched=false when the touch WRITE fails (#5246)', async () => {
        // The flag is set after the update resolves, so a failed write reports
        // no cadence rather than a cadence that did not persist — otherwise the
        // claims refresh would be skipped for five minutes on the strength of a
        // write that never landed.
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-1',
            revokedAt: null,
            lastActiveAt: new Date(Date.now() - 6 * 60 * 1000),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        mockUserSession.update.mockRejectedValueOnce(new Error('write failed'));
        const out = await verifyAndTouchSession('sid');
        expect(out.touched).toBe(false);
        // The whole call fails open, as it already did for a failed read.
        expect(out.revoked).toBe(false);
    });

    it('fails-open on DB error — returns revoked=false so a transient blip does not sign everyone out', async () => {
        mockUserSession.findUnique.mockRejectedValue(new Error('boom'));
        const out = await verifyAndTouchSession('sid');
        expect(out).toEqual({ revoked: false, rowId: null, touched: false });
    });
});

// ─── revokeSessionById ─────────────────────────────────────────────

describe('revokeSessionById', () => {
    it('marks revokedAt + revokedReason on a live row', async () => {
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-1',
            userId: 'user-9',
            revokedAt: null,
        });
        mockUserSession.update.mockResolvedValue({});
        const out = await revokeSessionById({
            sessionId: 'sid-X',
            reason: 'admin:abc',
        });
        expect(out).toEqual({
            revoked: true,
            sessionId: 'sid-X',
            userId: 'user-9',
        });
        const upd = mockUserSession.update.mock.calls[0][0];
        expect(upd.where).toEqual({ id: 'row-1' });
        expect(upd.data.revokedAt).toBeInstanceOf(Date);
        expect(upd.data.revokedReason).toBe('admin:abc');
    });

    it('returns revoked=false when the row is already revoked (no double-update)', async () => {
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-1',
            userId: 'user-9',
            revokedAt: new Date(),
        });
        const out = await revokeSessionById({
            sessionId: 'sid-X',
            reason: 'admin:abc',
        });
        expect(out.revoked).toBe(false);
        expect(mockUserSession.update).not.toHaveBeenCalled();
    });

    it('returns revoked=false when no row exists', async () => {
        mockUserSession.findUnique.mockResolvedValue(null);
        const out = await revokeSessionById({
            sessionId: 'no-such',
            reason: 'admin:abc',
        });
        expect(out).toEqual({
            revoked: false,
            sessionId: null,
            userId: null,
        });
    });
});

// ─── listActiveSessionsForTenant ───────────────────────────────────

describe('listActiveSessionsForTenant', () => {
    it('filters by tenantId, excludes revoked + expired, returns ISO timestamps', async () => {
        const now = new Date('2026-04-23T12:00:00Z');
        mockUserSession.findMany.mockResolvedValue([
            {
                sessionId: 's1',
                userId: 'u1',
                tenantId: 't1',
                ipAddress: '1.2.3.4',
                userAgent: 'firefox',
                createdAt: now,
                expiresAt: new Date('2026-05-23T12:00:00Z'),
                lastActiveAt: now,
            },
        ]);
        const out = await listActiveSessionsForTenant('t1');
        expect(mockUserSession.findMany).toHaveBeenCalledTimes(1);
        const where = mockUserSession.findMany.mock.calls[0][0].where;
        expect(where.tenantId).toBe('t1');
        expect(where.revokedAt).toBeNull();
        expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
        expect(out).toHaveLength(1);
        expect(out[0].sessionId).toBe('s1');
        expect(out[0].createdAt).toBe('2026-04-23T12:00:00.000Z');
    });
});

// ─── Tenant policy enforcement (Epic C.3 hardening pass) ──────────

describe('recordNewSession — sessionMaxAgeMinutes policy', () => {
    it('caps expiresAt to now + maxAgeMinutes when the policy is shorter than the input', async () => {
        // Policy: 60 minutes. Input expiry: 30 days. The row should
        // land at ~60 minutes from now, not 30 days.
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: 60,
            maxConcurrentSessions: null,
        });
        mockUserSession.create.mockResolvedValue({ id: 'row-1' });

        await recordNewSession({
            userId: 'u1',
            tenantId: 't1',
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        const data = mockUserSession.create.mock.calls[0][0].data;
        const cappedMs = data.expiresAt.getTime() - Date.now();
        // Loose bound — wall-clock noise inside the test.
        expect(cappedMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
        expect(cappedMs).toBeGreaterThan(60 * 60 * 1000 - 5_000);
    });

    it('keeps the input expiresAt when the policy is longer', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: 30 * 24 * 60, // 30 days
            maxConcurrentSessions: null,
        });
        mockUserSession.create.mockResolvedValue({ id: 'row-1' });

        const inputExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1h
        await recordNewSession({
            userId: 'u1',
            tenantId: 't1',
            expiresAt: inputExpiry,
        });
        const data = mockUserSession.create.mock.calls[0][0].data;
        expect(data.expiresAt).toEqual(inputExpiry);
    });
});

describe('recordNewSession — maxConcurrentSessions policy', () => {
    it('evicts the oldest session by lastActiveAt when at the cap', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: null,
            maxConcurrentSessions: 3,
        });
        // 3 active sessions; ordered oldest-first by lastActiveAt ASC
        // (matches the helper's findMany ordering).
        mockUserSession.findMany.mockResolvedValue([
            { id: 'old-1' },
            { id: 'old-2' },
            { id: 'old-3' },
        ]);
        mockUserSession.create.mockResolvedValue({ id: 'new' });

        await recordNewSession({
            userId: 'u1',
            tenantId: 't1',
            expiresAt: new Date(Date.now() + 60_000),
        });

        // Cap is 3, we're inserting 1 more → must evict 1 oldest.
        expect(mockUserSession.updateMany).toHaveBeenCalledTimes(1);
        const args = mockUserSession.updateMany.mock.calls[0][0];
        expect(args.where).toEqual({ id: { in: ['old-1'] } });
        expect(args.data.revokedReason).toBe('policy:concurrent-limit');
    });

    it('does not evict anyone when below the cap', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: null,
            maxConcurrentSessions: 5,
        });
        mockUserSession.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
        mockUserSession.create.mockResolvedValue({ id: 'new' });

        await recordNewSession({
            userId: 'u1',
            tenantId: 't1',
            expiresAt: new Date(Date.now() + 60_000),
        });
        expect(mockUserSession.updateMany).not.toHaveBeenCalled();
    });

    it('skips eviction entirely when the policy is null (legacy behaviour)', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: null,
            maxConcurrentSessions: null,
        });
        mockUserSession.create.mockResolvedValue({ id: 'new' });

        await recordNewSession({
            userId: 'u1',
            tenantId: 't1',
            expiresAt: new Date(Date.now() + 60_000),
        });
        // findMany only fires for the eviction lookup; with policy null
        // the helper short-circuits before that call.
        expect(mockUserSession.findMany).not.toHaveBeenCalled();
        expect(mockUserSession.updateMany).not.toHaveBeenCalled();
    });
});

describe('verifyAndTouchSession — expiry as implicit revocation', () => {
    it('marks the row revoked with policy:expired when expiresAt is in the past', async () => {
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-1',
            revokedAt: null,
            lastActiveAt: new Date(),
            expiresAt: new Date(Date.now() - 60_000),
        });
        const out = await verifyAndTouchSession('sid');
        // An expired row is stamped revoked, not touched: the write it makes is
        // `revokedAt`, so it is no claims-refresh cadence (#5246).
        expect(out).toEqual({ revoked: true, rowId: 'row-1', touched: false });

        const upd = mockUserSession.update.mock.calls[0][0];
        expect(upd.where).toEqual({ id: 'row-1' });
        expect(upd.data.revokedAt).toBeInstanceOf(Date);
        expect(upd.data.revokedReason).toBe('policy:expired');
    });
});

// ─── Per-user listing + per-tenant counts ──────────────────────────

describe('listActiveSessionsForUserInTenant', () => {
    it('scopes by tenantId AND userId and excludes revoked/expired', async () => {
        mockUserSession.findMany.mockResolvedValue([]);
        await listActiveSessionsForUserInTenant({
            tenantId: 't1',
            userId: 'u1',
        });
        const where = mockUserSession.findMany.mock.calls[0][0].where;
        expect(where).toEqual({
            tenantId: 't1',
            userId: 'u1',
            revokedAt: null,
            expiresAt: { gt: expect.any(Date) },
        });
    });
});

describe('countActiveSessionsForTenantUsers', () => {
    it('returns a flat userId → count map', async () => {
        mockUserSession.groupBy.mockResolvedValue([
            { userId: 'u1', _count: { _all: 2 } },
            { userId: 'u2', _count: { _all: 1 } },
        ]);
        const out = await countActiveSessionsForTenantUsers('t1');
        expect(out).toEqual({ u1: 2, u2: 1 });
    });

    it('returns an empty map when no users have sessions', async () => {
        mockUserSession.groupBy.mockResolvedValue([]);
        const out = await countActiveSessionsForTenantUsers('t1');
        expect(out).toEqual({});
    });
});
