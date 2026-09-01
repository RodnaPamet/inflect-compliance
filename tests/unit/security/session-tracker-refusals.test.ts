/**
 * Refusal / degradation-path tests for
 * `src/lib/security/session-tracker.ts`.
 *
 * `tests/unit/security/session-tracker.test.ts` covers the happy
 * lifecycle (mint → verify → touch → revoke) with ONE fixed
 * `next/headers` stub and a policy read that always succeeds. What it
 * cannot reach is everything this module does when the world
 * misbehaves, which is most of its branch count:
 *
 *   - `readTenantSessionPolicy` — its single retry, and the
 *     fail-OPEN-but-never-fail-SILENT outcome when both attempts throw.
 *     That path turns two security controls (concurrent-session cap +
 *     session lifetime cap) off, so the ERROR log and the
 *     `session.policy.resolution{outcome=failed}` counter are the only
 *     things standing between "control lapsed" and "nobody noticed".
 *   - `pickIp` / `pickUserAgent` — the proxy-header priority chain and
 *     the 512-byte user-agent bound.
 *   - `readRequestHeaders` — the `next/headers`-unavailable fallback.
 *   - `findOwnTenantSession` — the cross-tenant refusal the admin
 *     DELETE handler leans on. It had no test at all.
 *   - `listActiveSessionsForUser` — likewise untested.
 *
 * Time is always expressed RELATIVE to `Date.now()` at assertion time;
 * no literal date is ever seeded into an age-bounded column, so nothing
 * here can go green today and red overnight.
 */

// ── Mocks (hoisted above the imports by Jest) ───────────────────────

type SessionRow = {
    id: string;
    sessionId?: string;
    userId?: string;
    tenantId?: string | null;
    revokedAt?: Date | null;
    lastActiveAt?: Date;
    expiresAt?: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
    createdAt?: Date;
};

const mockUserSession = {
    create: jest.fn<Promise<{ id: string }>, [unknown]>(),
    findUnique: jest.fn<Promise<SessionRow | null>, [unknown]>(),
    update: jest.fn<Promise<unknown>, [unknown]>(),
    updateMany: jest.fn<Promise<unknown>, [unknown]>(),
    findMany: jest.fn<Promise<SessionRow[]>, [unknown]>(),
    groupBy: jest.fn<Promise<unknown[]>, [unknown]>(),
};

const mockTenantSecuritySettings = {
    findUnique: jest.fn<
        Promise<{
            sessionMaxAgeMinutes: number | null;
            maxConcurrentSessions: number | null;
        } | null>,
        [unknown]
    >(),
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

const mockLoggerWarn = jest.fn<void, [string, Record<string, unknown>?]>();
const mockLoggerError = jest.fn<void, [string, Record<string, unknown>?]>();
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        info: jest.fn(),
        debug: jest.fn(),
        warn: mockLoggerWarn,
        error: mockLoggerError,
    },
}));

const mockRecordSessionPolicyResolution =
    jest.fn<void, [{ outcome: 'ok' | 'failed' }]>();
jest.mock('@/lib/observability/metrics', () => ({
    __esModule: true,
    recordSessionPolicyResolution: (a: { outcome: 'ok' | 'failed' }) =>
        mockRecordSessionPolicyResolution(a),
}));

/**
 * Swappable `next/headers` stub. Must be named `mock*` — Jest refuses a
 * factory that closes over any other out-of-scope binding.
 *   - a `Headers` instance → that request's headers
 *   - `null`               → helper resolved but there is no request scope
 *   - `'throw'`            → `headers()` itself throws (worker / CLI flow)
 */
let mockHeadersState: Headers | null | 'throw' = null;
jest.mock(
    'next/headers',
    () => ({
        headers: async (): Promise<Headers | null> => {
            if (mockHeadersState === 'throw') {
                throw new Error('headers() called outside a request scope');
            }
            return mockHeadersState;
        },
    }),
    { virtual: true },
);

import {
    recordNewSession,
    verifyAndTouchSession,
    findOwnTenantSession,
    listActiveSessionsForUser,
} from '@/lib/security/session-tracker';

/** Build a Headers from a plain map — keeps each test's intent on one line. */
function headersOf(entries: Record<string, string>): Headers {
    const h = new Headers();
    for (const [k, v] of Object.entries(entries)) h.set(k, v);
    return h;
}

/** The `data` object handed to `prisma.userSession.create`. */
function createdData(): Record<string, unknown> {
    const call = mockUserSession.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
    };
    return call.data;
}

beforeEach(() => {
    Object.values(mockUserSession).forEach((fn) => fn.mockReset());
    mockTenantSecuritySettings.findUnique.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    mockRecordSessionPolicyResolution.mockReset();

    mockHeadersState = null;
    mockTenantSecuritySettings.findUnique.mockResolvedValue(null);
    mockUserSession.findMany.mockResolvedValue([]);
    mockUserSession.create.mockResolvedValue({ id: 'row-1' });
});

// ─── Header capture — pickIp ────────────────────────────────────────

describe('recordNewSession — client IP resolution', () => {
    async function ipFor(headers: Headers | null | 'throw'): Promise<unknown> {
        mockHeadersState = headers;
        await recordNewSession({
            userId: 'u1',
            tenantId: null,
            expiresAt: new Date(Date.now() + 3600_000),
        });
        return createdData().ipAddress;
    }

    it('records null when there is no request scope at all', async () => {
        // Missing telemetry is preferable to a made-up IP in the audit row.
        expect(await ipFor(null)).toBeNull();
    });

    it('records null when next/headers throws instead of resolving', async () => {
        expect(await ipFor('throw')).toBeNull();
    });

    it('takes the LEFT-MOST x-forwarded-for entry — the original client', async () => {
        expect(
            await ipFor(
                headersOf({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }),
            ),
        ).toBe('203.0.113.7');
    });

    it('trims whitespace around the left-most forwarded entry', async () => {
        expect(await ipFor(headersOf({ 'x-forwarded-for': '  198.51.100.9 , 10.0.0.1' })))
            .toBe('198.51.100.9');
    });

    it('falls through to x-real-ip when the forwarded chain starts empty', async () => {
        // A proxy that emits a leading comma would otherwise record '' as
        // the client IP — an empty string is not an address.
        expect(
            await ipFor(
                headersOf({ 'x-forwarded-for': ', 10.0.0.1', 'x-real-ip': '198.51.100.4' }),
            ),
        ).toBe('198.51.100.4');
    });

    it('uses x-real-ip when no forwarded header is present', async () => {
        expect(await ipFor(headersOf({ 'x-real-ip': '198.51.100.5' }))).toBe(
            '198.51.100.5',
        );
    });

    it('uses cf-connecting-ip only after x-forwarded-for and x-real-ip miss', async () => {
        expect(await ipFor(headersOf({ 'cf-connecting-ip': '198.51.100.6' }))).toBe(
            '198.51.100.6',
        );
    });

    it('prefers x-real-ip over cf-connecting-ip when both are present', async () => {
        expect(
            await ipFor(
                headersOf({
                    'x-real-ip': '198.51.100.7',
                    'cf-connecting-ip': '198.51.100.8',
                }),
            ),
        ).toBe('198.51.100.7');
    });

    it('records null when a request scope exists but carries no IP header', async () => {
        expect(await ipFor(headersOf({ 'user-agent': 'curl/8' }))).toBeNull();
    });
});

// ─── Header capture — pickUserAgent ─────────────────────────────────

describe('recordNewSession — user-agent capture', () => {
    async function uaFor(headers: Headers | null): Promise<unknown> {
        mockHeadersState = headers;
        await recordNewSession({
            userId: 'u1',
            tenantId: null,
            expiresAt: new Date(Date.now() + 3600_000),
        });
        return createdData().userAgent;
    }

    it('records null when the request carries no user-agent', async () => {
        expect(await uaFor(headersOf({ 'x-real-ip': '198.51.100.5' }))).toBeNull();
    });

    it('records null when there is no request scope', async () => {
        expect(await uaFor(null)).toBeNull();
    });

    it('stores a normal user-agent verbatim', async () => {
        expect(await uaFor(headersOf({ 'user-agent': 'Mozilla/5.0 (X11)' }))).toBe(
            'Mozilla/5.0 (X11)',
        );
    });

    it('truncates a pathological user-agent to exactly 512 bytes', async () => {
        const monster = 'A'.repeat(4096);
        const stored = await uaFor(headersOf({ 'user-agent': monster }));
        // Row-size bound: synthetic traffic sends kilobyte-long UAs.
        expect(stored).toBe('A'.repeat(512));
    });

    it('keeps a user-agent of exactly 512 chars unchanged (boundary)', async () => {
        const exact = 'B'.repeat(512);
        expect(await uaFor(headersOf({ 'user-agent': exact }))).toBe(exact);
    });
});

// ─── Tenant policy resolution — retry + fail-open-but-loud ──────────

describe('readTenantSessionPolicy (via recordNewSession)', () => {
    const input = () => ({
        userId: 'u1',
        tenantId: 't1',
        expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
    });

    it('retries ONCE after a transient read failure and then applies the policy', async () => {
        mockTenantSecuritySettings.findUnique
            .mockRejectedValueOnce(new Error('connection reset'))
            .mockResolvedValueOnce({
                sessionMaxAgeMinutes: 10,
                maxConcurrentSessions: null,
            });

        await recordNewSession(input());

        expect(mockTenantSecuritySettings.findUnique).toHaveBeenCalledTimes(2);
        // The retry SUCCEEDED, so the control applied: expiry is capped to
        // ~10 minutes rather than the 30-day input.
        const expiresAt = createdData().expiresAt as Date;
        expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 5_000);
        expect(mockRecordSessionPolicyResolution).toHaveBeenCalledWith({ outcome: 'ok' });
        expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it('gives up after the second failure — logs at ERROR and counts outcome=failed', async () => {
        mockTenantSecuritySettings.findUnique
            .mockRejectedValueOnce(new Error('blip one'))
            .mockRejectedValueOnce(new Error('blip two'));

        await recordNewSession(input());

        expect(mockTenantSecuritySettings.findUnique).toHaveBeenCalledTimes(2);
        expect(mockRecordSessionPolicyResolution).toHaveBeenCalledWith({
            outcome: 'failed',
        });
        expect(mockRecordSessionPolicyResolution).not.toHaveBeenCalledWith({
            outcome: 'ok',
        });
        // ERROR, not warn — two security controls have stopped applying.
        expect(mockLoggerError).toHaveBeenCalledTimes(1);
        const [message, fields] = mockLoggerError.mock.calls[0];
        expect(message).toMatch(/could not resolve tenant session policy/);
        expect(fields).toMatchObject({
            component: 'session-tracker',
            tenantId: 't1',
            error: 'blip two',
        });
    });

    it('fails OPEN on total policy-read failure — sign-in still completes uncapped', async () => {
        mockTenantSecuritySettings.findUnique.mockRejectedValue(new Error('down'));
        const expiresAt = new Date(Date.now() + 30 * 24 * 3600_000);

        const out = await recordNewSession({ userId: 'u1', tenantId: 't1', expiresAt });

        expect(out.rowId).toBe('row-1');
        // Uncapped: the input expiry is preserved verbatim...
        expect(createdData().expiresAt).toEqual(expiresAt);
        // ...and no eviction sweep ran, because the cap is unknown.
        expect(mockUserSession.findMany).not.toHaveBeenCalled();
    });

    it('does not read tenant policy at all for a session with no tenant', async () => {
        await recordNewSession({
            userId: 'u1',
            tenantId: null,
            expiresAt: new Date(Date.now() + 3600_000),
        });
        expect(mockTenantSecuritySettings.findUnique).not.toHaveBeenCalled();
        expect(mockRecordSessionPolicyResolution).not.toHaveBeenCalled();
    });

    it('treats a tenant with no settings row as "no policy", not as a failure', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue(null);
        const expiresAt = new Date(Date.now() + 30 * 24 * 3600_000);

        await recordNewSession({ userId: 'u1', tenantId: 't1', expiresAt });

        expect(mockRecordSessionPolicyResolution).toHaveBeenCalledWith({ outcome: 'ok' });
        expect(mockLoggerError).not.toHaveBeenCalled();
        expect(createdData().expiresAt).toEqual(expiresAt);
    });
});

// ─── Policy edge values ─────────────────────────────────────────────

describe('recordNewSession — policy edge values', () => {
    it('ignores sessionMaxAgeMinutes=0 rather than expiring the session instantly', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: 0,
            maxConcurrentSessions: null,
        });
        const expiresAt = new Date(Date.now() + 3600_000);
        await recordNewSession({ userId: 'u1', tenantId: 't1', expiresAt });
        expect(createdData().expiresAt).toEqual(expiresAt);
    });

    it('ignores a negative sessionMaxAgeMinutes', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: -60,
            maxConcurrentSessions: null,
        });
        const expiresAt = new Date(Date.now() + 3600_000);
        await recordNewSession({ userId: 'u1', tenantId: 't1', expiresAt });
        expect(createdData().expiresAt).toEqual(expiresAt);
    });

    it('ignores maxConcurrentSessions=0 — it must not lock every user out', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: null,
            maxConcurrentSessions: 0,
        });
        await recordNewSession({
            userId: 'u1',
            tenantId: 't1',
            expiresAt: new Date(Date.now() + 3600_000),
        });
        expect(mockUserSession.findMany).not.toHaveBeenCalled();
        expect(mockUserSession.updateMany).not.toHaveBeenCalled();
        expect(mockUserSession.create).toHaveBeenCalledTimes(1);
    });

    it('does not evict when the user has exactly cap-1 live sessions', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: null,
            maxConcurrentSessions: 3,
        });
        mockUserSession.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
        await recordNewSession({
            userId: 'u1',
            tenantId: 't1',
            expiresAt: new Date(Date.now() + 3600_000),
        });
        expect(mockUserSession.updateMany).not.toHaveBeenCalled();
    });

    it('evicts enough of the OLDEST sessions to land one below the cap', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: null,
            maxConcurrentSessions: 2,
        });
        // Four live sessions, cap 2 → three must go so the new one fits.
        mockUserSession.findMany.mockResolvedValue([
            { id: 's1' },
            { id: 's2' },
            { id: 's3' },
            { id: 's4' },
        ]);
        await recordNewSession({
            userId: 'u1',
            tenantId: 't1',
            expiresAt: new Date(Date.now() + 3600_000),
        });

        const order = (mockUserSession.findMany.mock.calls[0][0] as {
            orderBy: { lastActiveAt: string };
        }).orderBy;
        // Oldest by lastActiveAt, NOT createdAt — an idle device must not
        // outlive an actively used one forever.
        expect(order).toEqual({ lastActiveAt: 'asc' });

        const evict = mockUserSession.updateMany.mock.calls[0][0] as {
            where: { id: { in: string[] } };
            data: { revokedReason: string };
        };
        expect(evict.where.id.in).toStrictEqual(['s1', 's2', 's3']);
        expect(evict.data.revokedReason).toBe('policy:concurrent-limit');
    });

    it('still creates the session when eviction throws — sign-in is never blocked', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: null,
            maxConcurrentSessions: 1,
        });
        mockUserSession.findMany.mockRejectedValue(new Error('eviction read failed'));

        const out = await recordNewSession({
            userId: 'u1',
            tenantId: 't1',
            expiresAt: new Date(Date.now() + 3600_000),
        });

        expect(out.rowId).toBe('row-1');
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            'session-tracker: eviction failed',
            expect.objectContaining({
                component: 'session-tracker',
                error: 'eviction read failed',
            }),
        );
    });

    it('keeps the input expiry when the tenant policy window is the LONGER one', async () => {
        mockTenantSecuritySettings.findUnique.mockResolvedValue({
            sessionMaxAgeMinutes: 60 * 24 * 365,
            maxConcurrentSessions: null,
        });
        const expiresAt = new Date(Date.now() + 3600_000);
        await recordNewSession({ userId: 'u1', tenantId: 't1', expiresAt });
        expect(createdData().expiresAt).toEqual(expiresAt);
    });
});

// ─── verifyAndTouchSession — expiry bookkeeping failure ─────────────

describe('verifyAndTouchSession — expiry bookkeeping', () => {
    it('still reports revoked=true when the policy:expired write fails', async () => {
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-9',
            revokedAt: null,
            // Relative to now — never a literal date.
            lastActiveAt: new Date(Date.now() - 60_000),
            expiresAt: new Date(Date.now() - 1_000),
        });
        mockUserSession.update.mockRejectedValue(new Error('write conflict'));

        // The bookkeeping stamp is cosmetic; forcing re-auth is not.
        await expect(verifyAndTouchSession('sess-9')).resolves.toStrictEqual({
            revoked: true,
            rowId: 'row-9',
        });
    });

    it('treats an exactly-now expiry as expired (<=, not <)', async () => {
        const now = new Date();
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-10',
            revokedAt: null,
            lastActiveAt: now,
            expiresAt: now,
        });
        mockUserSession.update.mockResolvedValue({});

        const out = await verifyAndTouchSession('sess-10');
        expect(out.revoked).toBe(true);
        const write = mockUserSession.update.mock.calls[0][0] as {
            data: { revokedReason: string };
        };
        expect(write.data.revokedReason).toBe('policy:expired');
    });
});

// ─── findOwnTenantSession — cross-tenant refusal ────────────────────

describe('findOwnTenantSession', () => {
    it('REFUSES a session that exists in a DIFFERENT tenant', async () => {
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-1',
            tenantId: 'tenant-B',
            userId: 'u1',
            revokedAt: null,
        });
        // Returning null (rather than 404-vs-403) is what stops the admin
        // DELETE handler leaking whether the id exists elsewhere.
        await expect(
            findOwnTenantSession({ tenantId: 'tenant-A', sessionId: 's1' }),
        ).resolves.toBeNull();
    });

    it('REFUSES a tenant-scoped lookup of a tenant-less (NULL tenantId) session', async () => {
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-1',
            tenantId: null,
            userId: 'u1',
            revokedAt: null,
        });
        await expect(
            findOwnTenantSession({ tenantId: 'tenant-A', sessionId: 's1' }),
        ).resolves.toBeNull();
    });

    it('returns null when no row exists for the id', async () => {
        mockUserSession.findUnique.mockResolvedValue(null);
        await expect(
            findOwnTenantSession({ tenantId: 'tenant-A', sessionId: 'nope' }),
        ).resolves.toBeNull();
    });

    it('returns the row — WITHOUT tenantId — on an in-tenant match', async () => {
        const revokedAt = new Date(Date.now() - 5_000);
        mockUserSession.findUnique.mockResolvedValue({
            id: 'row-1',
            tenantId: 'tenant-A',
            userId: 'u9',
            revokedAt,
        });
        await expect(
            findOwnTenantSession({ tenantId: 'tenant-A', sessionId: 's1' }),
        ).resolves.toStrictEqual({ id: 'row-1', userId: 'u9', revokedAt });
        expect(mockUserSession.findUnique).toHaveBeenCalledWith({
            where: { sessionId: 's1' },
            select: { id: true, tenantId: true, userId: true, revokedAt: true },
        });
    });
});

// ─── listActiveSessionsForUser ──────────────────────────────────────

describe('listActiveSessionsForUser', () => {
    it('scopes by userId, excludes revoked + expired, and serialises timestamps', async () => {
        const createdAt = new Date(Date.now() - 7_200_000);
        const expiresAt = new Date(Date.now() + 7_200_000);
        const lastActiveAt = new Date(Date.now() - 60_000);
        mockUserSession.findMany.mockResolvedValue([
            {
                id: 'row-1',
                sessionId: 's1',
                userId: 'u1',
                tenantId: 't1',
                ipAddress: '198.51.100.1',
                userAgent: 'curl/8',
                createdAt,
                expiresAt,
                lastActiveAt,
            },
        ]);

        const out = await listActiveSessionsForUser('u1');

        expect(out).toStrictEqual([
            {
                sessionId: 's1',
                userId: 'u1',
                tenantId: 't1',
                ipAddress: '198.51.100.1',
                userAgent: 'curl/8',
                createdAt: createdAt.toISOString(),
                expiresAt: expiresAt.toISOString(),
                lastActiveAt: lastActiveAt.toISOString(),
            },
        ]);

        const where = (mockUserSession.findMany.mock.calls[0][0] as {
            where: Record<string, unknown>;
            orderBy: unknown;
        });
        expect(where.where).toMatchObject({ userId: 'u1', revokedAt: null });
        expect(where.where.expiresAt).toHaveProperty('gt');
        expect(where.orderBy).toEqual({ lastActiveAt: 'desc' });
    });

    it('returns an empty array — not undefined — when the user has no sessions', async () => {
        mockUserSession.findMany.mockResolvedValue([]);
        await expect(listActiveSessionsForUser('u1')).resolves.toStrictEqual([]);
    });

    it('preserves a null ipAddress / userAgent rather than dropping the key', async () => {
        const t = new Date(Date.now() - 1_000);
        mockUserSession.findMany.mockResolvedValue([
            {
                id: 'row-1',
                sessionId: 's1',
                userId: 'u1',
                tenantId: null,
                ipAddress: null,
                userAgent: null,
                createdAt: t,
                expiresAt: t,
                lastActiveAt: t,
            },
        ]);
        // toStrictEqual, not toEqual: toEqual cannot tell a null-valued key
        // from a missing one once the value is undefined.
        await expect(listActiveSessionsForUser('u1')).resolves.toStrictEqual([
            {
                sessionId: 's1',
                userId: 'u1',
                tenantId: null,
                ipAddress: null,
                userAgent: null,
                createdAt: t.toISOString(),
                expiresAt: t.toISOString(),
                lastActiveAt: t.toISOString(),
            },
        ]);
    });
});
