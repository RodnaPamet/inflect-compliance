/**
 * Unit test — JWT membership refresh on `useSession().update()`.
 *
 * The `jwt` callback used to load tenant/org membership claims ONLY at
 * sign-in (`account && user`). That froze the claims: a membership the
 * user gained afterwards — most commonly a tenant they just created
 * (where they're granted OWNER) — stayed invisible to the Edge
 * tenant-access gate until a full re-login, so navigating into the new
 * tenant bounced to /no-tenant.
 *
 * The fix reloads the claims when the callback fires with
 * `trigger === 'update'` (what `useSession().update()` triggers). This
 * test locks that contract: an update-triggered callback re-reads the
 * DB and surfaces the freshly-created tenant in `token.memberships`.
 */

const findUnique = jest.fn();
const sessionFindUnique = jest.fn();
const sessionUpdate = jest.fn(async (..._a: unknown[]) => ({}));

// BOTH exports, pointing at ONE object. `@/lib/prisma` exports the same client
// as `default` and as the named `prisma`, and the two consumers here disagree
// about which they take: `src/auth.ts` imports the default, while
// `src/lib/security/session-tracker.ts` — which this file now exercises through
// the throttled path (#5246) — imports the named one. A mock providing only
// `default` left the tracker with an undefined client, so it failed open and
// reported "no session row", which is a DIFFERENT branch from the one under
// test and passed for the wrong reason.
const prismaMock = {
    user: { findUnique: (...a: unknown[]) => findUnique(...a) },
    // "Enforce SSO" reads which of the user's workspaces require it: none here.
    tenantIdentityProvider: { findMany: async () => [] },
    // The session row the throttled path reads (#5246).
    userSession: {
        findUnique: (...a: unknown[]) => sessionFindUnique(...a),
        update: (...a: unknown[]) => sessionUpdate(...a),
    },
};

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: prismaMock,
    prisma: prismaMock,
}));

import { authOptions } from '@/auth';

type JwtCb = NonNullable<NonNullable<typeof authOptions.callbacks>['jwt']>;

const jwtCallback = authOptions.callbacks!.jwt as JwtCb;

describe('jwt callback — membership refresh on update trigger', () => {
    beforeEach(() => findUnique.mockReset());

    it('re-reads memberships (incl. a newly-created OWNER tenant) on trigger=update', async () => {
        findUnique.mockResolvedValue({
            id: 'user-1',
            sessionVersion: 3,
            tenantMemberships: [
                {
                    tenantId: 't-new',
                    role: 'OWNER',
                    tenant: { id: 't-new', slug: 'acme-nis2' },
                },
            ],
            orgMemberships: [
                {
                    organizationId: 'o-1',
                    role: 'ORG_ADMIN',
                    organization: { id: 'o-1', slug: 'my-org' },
                },
            ],
        });

        // A stale token: signed in before the tenant existed, so it
        // carries no memberships.
        const staleToken = {
            email: 'owner@example.com',
            userId: 'user-1',
            memberships: [],
            orgMemberships: [],
        };

        const result = await jwtCallback({
            token: staleToken as never,
            trigger: 'update',
        } as never);

        // At least the membership reload hit the DB (the throttled
        // sessionVersion check may add a second, unrelated read).
        expect(findUnique).toHaveBeenCalled();
        expect(result.memberships).toEqual([
            { slug: 'acme-nis2', role: 'OWNER', tenantId: 't-new' },
        ]);
        // Primary/back-compat claims track the (only) membership.
        expect(result.tenantSlug).toBe('acme-nis2');
        expect(result.role).toBe('OWNER');
        expect(result.orgMemberships).toEqual([
            { slug: 'my-org', role: 'ORG_ADMIN', organizationId: 'o-1' },
        ]);
    });

    it('does NOT re-read the DB on a normal (non-update) subsequent request', async () => {
        const token = {
            email: 'owner@example.com',
            userId: 'user-1',
            memberships: [{ slug: 'acme', role: 'OWNER', tenantId: 't-acme' }],
        };

        const result = await jwtCallback({ token: token as never } as never);

        expect(findUnique).not.toHaveBeenCalled();
        // Claims untouched.
        expect(result.memberships).toEqual([
            { slug: 'acme', role: 'OWNER', tenantId: 't-acme' },
        ]);
    });
});


// ─── The claims re-read is throttled on a cadence that PERSISTS (#5246) ─────

describe('jwt callback — the claims re-read is gated on the session row, not the token', () => {
    /**
     * WHAT THIS IS ABOUT. The re-read used to be throttled on
     * `token.sessionVersionCheckedAt`, which lives in the token — and in the
     * App Router the re-signed cookie is never written back, so that timestamp
     * persisted exactly once, at sign-in. Five minutes later EVERY server
     * request re-ran the full claims read (a joined user+memberships+orgs query
     * plus a tenantsEnforcingSso query) for the life of the session.
     *
     * It is now gated on whether `verifyAndTouchSession` actually stamped
     * `lastActiveAt` — DB state, on a row this callback already reads.
     *
     * The two reads are told apart by their ARGUMENTS, not by a call count
     * alone: the revocation check is `where: { id }` selecting `sessionVersion`,
     * and the claims read is `where: { emailHash }` with includes.
     */
    const claimsReads = () =>
        findUnique.mock.calls.filter((c) => {
            const arg = c[0] as { where?: Record<string, unknown> } | undefined;
            return Boolean(arg?.where && 'emailHash' in arg.where);
        }).length;

    const tokenWithOldCheck = () => ({
        email: 'u@example.com',
        userId: 'user-1',
        userSessionId: 'sid-1',
        sessionVersion: 3,
        // Old enough that the OUTER gate opens — so what decides the claims
        // read is the session row alone.
        sessionVersionCheckedAt: 0,
    });

    const dbUser = {
        id: 'user-1',
        sessionVersion: 3,
        email: 'u@example.com',
        name: null,
        image: null,
        tenantMemberships: [],
        orgMemberships: [],
    };

    beforeEach(() => {
        findUnique.mockReset();
        sessionFindUnique.mockReset();
        sessionUpdate.mockClear();
        findUnique.mockResolvedValue(dbUser);
    });

    it('does NOT re-read the claims when the session row was touched recently', async () => {
        sessionFindUnique.mockResolvedValue({
            id: 'row-1',
            revokedAt: null,
            lastActiveAt: new Date(),
            expiresAt: new Date(Date.now() + 3_600_000),
        });

        await jwtCallback({ token: tokenWithOldCheck() } as never);

        // This is the whole point: the expensive read is skipped even though
        // the token's own timestamp says it is due.
        expect(claimsReads()).toBe(0);
        expect(sessionUpdate).not.toHaveBeenCalled();
    });

    it('DOES re-read the claims when the session row was just stamped', async () => {
        sessionFindUnique.mockResolvedValue({
            id: 'row-1',
            revokedAt: null,
            lastActiveAt: new Date(Date.now() - 6 * 60_000),
            expiresAt: new Date(Date.now() + 3_600_000),
        });

        await jwtCallback({ token: tokenWithOldCheck() } as never);

        expect(sessionUpdate).toHaveBeenCalledTimes(1);
        expect(claimsReads()).toBe(1);
    });

    it('falls back to the token timing when there is NO session row', async () => {
        // A token minted before session tracking, or a flow that writes no row.
        // There is no persisted signal, so skipping for ever would freeze the
        // claims — the fallback must re-read.
        sessionFindUnique.mockResolvedValue(null);

        await jwtCallback({ token: tokenWithOldCheck() } as never);

        expect(claimsReads()).toBe(1);
    });
});
