/**
 * Session-resolution tests for `src/lib/auth.ts`.
 *
 * `tests/unit/rbac.test.ts` already covers the pure role predicates
 * (`hasMinRole`, `canRead`, …). What it does not touch is the half of
 * the module that decides WHO the caller is:
 *
 *   - `getSession` — the single session mechanism after the legacy
 *     `token`-cookie fallback was deleted. Every default it applies
 *     (`tenantId ?? ''`, `email ?? ''`, `role ?? 'READER'`) is a
 *     security-relevant fallback, and `role ?? 'READER'` in particular
 *     must never widen.
 *   - `getSessionOrThrow` — the refusal that every usecase's
 *     RequestContext is built on.
 *   - `getCurrentUser` — must not touch the database at all when there
 *     is no session.
 *   - `hasTenantRole` — resolves from `TenantMembership`, so a stale
 *     role on the JWT cannot grant access.
 */
import type { Role } from '@prisma/client';

// ── Mocks (hoisted above the imports by Jest) ──────────────────────────

/** Mirrors the fields `getSession` actually reads off the Auth.js session. */
type SessionUserLike = {
    id: string;
    tenantId?: string | null;
    email?: string | null;
    role?: Role | null;
};
type SessionLike = { user?: SessionUserLike | null } | null;

const mockAuth = jest.fn<Promise<SessionLike>, []>();
jest.mock('@/auth', () => ({
    __esModule: true,
    auth: () => mockAuth(),
}));

const mockUserFindUnique = jest.fn<Promise<unknown>, [unknown]>();
const mockMembershipFindUnique = jest.fn<Promise<unknown>, [unknown]>();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: { findUnique: (a: unknown) => mockUserFindUnique(a) },
        tenantMembership: { findUnique: (a: unknown) => mockMembershipFindUnique(a) },
    },
}));

import {
    getSession,
    getSessionOrThrow,
    getCurrentUser,
    hasTenantRole,
    hashPassword,
    verifyPassword,
} from '@/lib/auth';
import { UnauthorizedError } from '@/lib/errors/types';

beforeEach(() => {
    mockAuth.mockReset();
    mockUserFindUnique.mockReset();
    mockMembershipFindUnique.mockReset();
});

// ─── getSession ──────────────────────────────────────────────────────

describe('getSession', () => {
    it('returns null when Auth.js has no session', async () => {
        mockAuth.mockResolvedValue(null);
        expect(await getSession()).toBeNull();
    });

    it('returns null when the session object exists but carries no user', async () => {
        // A session shell with no `user` is not an authenticated caller;
        // treating it as one would build a RequestContext with an empty
        // userId.
        mockAuth.mockResolvedValue({});
        expect(await getSession()).toBeNull();
    });

    it('returns null when session.user is explicitly null', async () => {
        mockAuth.mockResolvedValue({ user: null });
        expect(await getSession()).toBeNull();
    });

    it('maps a fully populated session onto the JwtPayload shape', async () => {
        mockAuth.mockResolvedValue({
            user: {
                id: 'usr_1',
                tenantId: 'tnt_1',
                email: 'alice@example.com',
                role: 'ADMIN',
            },
        });
        expect(await getSession()).toStrictEqual({
            userId: 'usr_1',
            tenantId: 'tnt_1',
            email: 'alice@example.com',
            role: 'ADMIN',
        });
    });

    it('defaults a missing role to READER — the LEAST privileged role', async () => {
        // This is the load-bearing fallback in the file. If it ever
        // defaults to anything above READER, a token minted without a
        // role claim silently gains write or admin rights.
        mockAuth.mockResolvedValue({ user: { id: 'usr_1' } });
        const session = await getSession();
        expect(session?.role).toBe('READER');
    });

    it('defaults a null role to READER, not to the tenant default', async () => {
        mockAuth.mockResolvedValue({
            user: { id: 'usr_1', tenantId: 'tnt_1', email: 'a@b.com', role: null },
        });
        expect((await getSession())?.role).toBe('READER');
    });

    it('defaults an absent tenantId to the empty string, never to a tenant id', async () => {
        // Empty string is deliberately NOT a valid tenant: it matches no
        // row, so a tenant-scoped query returns nothing rather than
        // leaking another tenant's data.
        mockAuth.mockResolvedValue({ user: { id: 'usr_1', role: 'ADMIN' } });
        expect((await getSession())?.tenantId).toBe('');
    });

    it('defaults an absent email to the empty string', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'usr_1', role: 'ADMIN' } });
        expect((await getSession())?.email).toBe('');
    });

    it('applies every default at once for a bare user record', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'usr_1' } });
        expect(await getSession()).toStrictEqual({
            userId: 'usr_1',
            tenantId: '',
            email: '',
            role: 'READER',
        });
    });
});

// ─── getSessionOrThrow ───────────────────────────────────────────────

describe('getSessionOrThrow', () => {
    it('REFUSES with an UnauthorizedError (401) when there is no session', async () => {
        mockAuth.mockResolvedValue(null);
        await expect(getSessionOrThrow()).rejects.toBeInstanceOf(UnauthorizedError);
        await expect(getSessionOrThrow()).rejects.toMatchObject({ status: 401 });
    });

    it('REFUSES when the session has no user, not just when auth() returns null', async () => {
        mockAuth.mockResolvedValue({});
        await expect(getSessionOrThrow()).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('returns the payload unchanged when a session exists', async () => {
        mockAuth.mockResolvedValue({
            user: { id: 'usr_1', tenantId: 't1', email: 'a@b.com', role: 'EDITOR' },
        });
        await expect(getSessionOrThrow()).resolves.toStrictEqual({
            userId: 'usr_1',
            tenantId: 't1',
            email: 'a@b.com',
            role: 'EDITOR',
        });
    });
});

// ─── getCurrentUser ──────────────────────────────────────────────────

describe('getCurrentUser', () => {
    it('returns null WITHOUT querying the database when unauthenticated', async () => {
        mockAuth.mockResolvedValue(null);
        expect(await getCurrentUser()).toBeNull();
        // The short-circuit matters: `findUnique({ where: { id: undefined } })`
        // is a Prisma error at best and an unscoped read at worst.
        expect(mockUserFindUnique).not.toHaveBeenCalled();
    });

    it('looks the user up by the session userId only', async () => {
        mockAuth.mockResolvedValue({
            user: { id: 'usr_7', tenantId: 't1', email: 'a@b.com', role: 'READER' },
        });
        mockUserFindUnique.mockResolvedValue({ id: 'usr_7' });

        expect(await getCurrentUser()).toEqual({ id: 'usr_7' });
        expect(mockUserFindUnique).toHaveBeenCalledWith({ where: { id: 'usr_7' } });
    });

    it('propagates a null row for a session pointing at a deleted user', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'ghost', role: 'READER' } });
        mockUserFindUnique.mockResolvedValue(null);
        expect(await getCurrentUser()).toBeNull();
    });
});

// ─── hasTenantRole ───────────────────────────────────────────────────

describe('hasTenantRole', () => {
    it('REFUSES when the user has no membership on that tenant', async () => {
        mockMembershipFindUnique.mockResolvedValue(null);
        expect(await hasTenantRole('usr_1', 'tnt_other', 'READER')).toBe(false);
    });

    it('scopes the lookup to the (tenantId, userId) compound key', async () => {
        mockMembershipFindUnique.mockResolvedValue({ role: 'ADMIN' });
        await hasTenantRole('usr_1', 'tnt_1', 'ADMIN');
        expect(mockMembershipFindUnique).toHaveBeenCalledWith({
            where: { tenantId_userId: { tenantId: 'tnt_1', userId: 'usr_1' } },
        });
    });

    it('REFUSES when the membership role sits below the required role', async () => {
        mockMembershipFindUnique.mockResolvedValue({ role: 'READER' });
        expect(await hasTenantRole('usr_1', 'tnt_1', 'ADMIN')).toBe(false);
    });

    it('allows when the membership role is above the required role', async () => {
        mockMembershipFindUnique.mockResolvedValue({ role: 'OWNER' });
        expect(await hasTenantRole('usr_1', 'tnt_1', 'ADMIN')).toBe(true);
    });

    it('REFUSES an AUDITOR asked for EDITOR — AUDITOR is not in the write chain', async () => {
        mockMembershipFindUnique.mockResolvedValue({ role: 'AUDITOR' });
        expect(await hasTenantRole('usr_1', 'tnt_1', 'EDITOR')).toBe(false);
    });
});

// ─── hashPassword / verifyPassword ───────────────────────────────────

describe('hashPassword', () => {
    // bcrypt at cost 12 is intentionally slow.
    jest.setTimeout(30_000);

    it('produces a cost-12 bcrypt hash that is not the plaintext', async () => {
        const hash = await hashPassword('correct horse battery staple');
        expect(hash).not.toBe('correct horse battery staple');
        // $2<variant>$<cost>$ — the cost must not silently drop.
        expect(hash).toMatch(/^\$2[aby]\$12\$/);
    });

    it('salts — the same password hashes differently every time', async () => {
        const a = await hashPassword('same-password');
        const b = await hashPassword('same-password');
        expect(a).not.toBe(b);
    });

    it('round-trips through verifyPassword and REFUSES a near-miss', async () => {
        const hash = await hashPassword('s3cret-passphrase');
        await expect(verifyPassword('s3cret-passphrase', hash)).resolves.toBe(true);
        await expect(verifyPassword('s3cret-passphras', hash)).resolves.toBe(false);
        await expect(verifyPassword('', hash)).resolves.toBe(false);
    });
});
