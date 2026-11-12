/* eslint-disable @typescript-eslint/no-explicit-any -- a Prisma double and
   hand-built NextAuth tokens; the code under test reads them through its own
   typed paths. */
/**
 * Every workspace a session can reach is asked for its MFA policy, not only
 * the first.
 *
 * Sign-in asked one workspace, the session's primary: the member's OLDEST
 * membership. Someone who joined a workspace that requires MFA after one that
 * does not was never asked for a code there.
 *
 * Now sign-in puts every other workspace that wants a code in
 * `mfaPendingTenantIds`. The edge holds that workspace's paths, and org paths,
 * until its own challenge is passed, and passing it clears that workspace
 * only. See `src/lib/auth/workspace-mfa.ts`.
 */
const db = {
    /** Each workspace's policy. */
    policies: {} as Record<string, string>,
    /** Each session's row: which workspaces that session passed the challenge of. */
    sessionPasses: {} as Record<string, string[]>,
    /** The account's ACTIVE memberships, oldest first. */
    memberships: [] as Array<{ tenantId: string; role: string; tenant: { id: string; slug: string } }>,
};
const BOTH_WORKSPACES = [
    // `alpha` is older, so it is the primary workspace.
    { tenantId: 't-alpha', role: 'EDITOR', tenant: { id: 't-alpha', slug: 'alpha' } },
    { tenantId: 't-beta', role: 'EDITOR', tenant: { id: 't-beta', slug: 'beta' } },
];

jest.mock('@/lib/prisma', () => {
    const prisma: any = {
        user: {
            findUnique: jest.fn(async () => ({
                id: 'user-1',
                sessionVersion: 1,
                passwordHash: 'hash',
                tenantMemberships: db.memberships,
                orgMemberships: [],
            })),
        },
        tenantIdentityProvider: { findMany: jest.fn(async () => []) },
        tenantSecuritySettings: {
            findUnique: jest.fn(async ({ where }: any) => ({
                mfaPolicy: db.policies[where.tenantId] ?? 'DISABLED',
                mfaFailClosed: false,
            })),
            findMany: jest.fn(async ({ where }: any) =>
                (where.tenantId.in as string[])
                    .filter((id) => db.policies[id])
                    .map((tenantId) => ({ tenantId, mfaPolicy: db.policies[tenantId] })),
            ),
        },
        userMfaEnrollment: {
            findUnique: jest.fn(async () => null),
            findMany: jest.fn(async () => []),
        },
        userSession: {
            findUnique: jest.fn(async ({ where }: any) =>
                db.sessionPasses[where.sessionId]
                    ? { userId: 'user-1', mfaPassedTenantIds: db.sessionPasses[where.sessionId] }
                    : null,
            ),
        },
    };
    return { __esModule: true, default: prisma, prisma };
});
jest.mock('@/lib/security/session-tracker', () => ({
    recordNewSession: jest.fn(async () => ({ sessionId: 'user-session-1' })),
    verifyAndTouchSession: jest.fn(async () => ({ revoked: false })),
}));

let currentRequest: { cookies: { getAll(): { name: string; value: string }[] }; headers: Headers } | null = null;
jest.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => currentRequest!.cookies.getAll() }),
    headers: async () => currentRequest!.headers,
}));
jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
    isApiReadRateLimited: jest.fn().mockReturnValue(false),
    extractTenantSlug: jest.fn().mockReturnValue(null),
}));

import { NextRequest } from 'next/server';
import { decode, encode } from 'next-auth/jwt';
import { authOptions } from '@/auth';
import { GET as nextAuthGet } from '@/app/api/auth/[...nextauth]/route';
import middleware from '../../src/middleware';

const SECRET = process.env.AUTH_SECRET as string;
const COOKIE = 'next-auth.session-token';
const ORIGIN = 'http://localhost:3000';

type JwtCb = NonNullable<NonNullable<typeof authOptions.callbacks>['jwt']>;
const jwtCallback = authOptions.callbacks!.jwt as JwtCb;

const MEMBERSHIPS = [
    { slug: 'alpha', role: 'EDITOR', tenantId: 't-alpha' },
    { slug: 'beta', role: 'EDITOR', tenantId: 't-beta' },
];

beforeEach(() => {
    db.policies = {};
    db.sessionPasses = { 'sess-this': [], 'sess-other': [] };
    db.memberships = BOTH_WORKSPACES;
});

/** A password sign-in through the real `jwt` callback. */
async function signIn() {
    return jwtCallback({
        token: { sub: 'user-1', email: 'member@example.com' } as any,
        user: { id: 'user-1', email: 'member@example.com' } as any,
        account: { provider: 'credentials', type: 'credentials', providerAccountId: 'user-1' } as any,
    } as any);
}

async function cookieFor(claims: Record<string, unknown>): Promise<string> {
    return encode({
        secret: SECRET,
        token: {
            sub: 'user-1',
            userId: 'user-1',
            email: 'member@example.com',
            role: 'EDITOR',
            tenantId: 't-alpha',
            tenantSlug: 'alpha',
            memberships: MEMBERSHIPS,
            orgMemberships: [{ slug: 'holding', role: 'ORG_ADMIN', organizationId: 'org-1' }],
            sessionVersion: 1,
            sessionVersionCheckedAt: Math.floor(Date.now() / 1000),
            mfaPending: false,
            userSessionId: 'sess-this',
            ...claims,
        } as any,
    });
}

/** Where the real middleware sends this request (null = let through). */
async function edge(cookie: string, path: string): Promise<{ status: number; location: string | null }> {
    const res = await middleware(new NextRequest(`${ORIGIN}${path}`, { headers: { cookie: `${COOKIE}=${cookie}` } }));
    const location = res?.headers.get('location');
    return { status: res?.status ?? 200, location: location ? new URL(location).pathname + new URL(location).search : null };
}

describe('sign-in asks every workspace, not only the oldest', () => {
    it('a later workspace that requires MFA is pending, though the first does not', async () => {
        db.policies = { 't-alpha': 'DISABLED', 't-beta': 'REQUIRED' };
        const token = await signIn();
        expect(token.tenantId).toBe('t-alpha');
        expect(token.mfaPending).toBe(false);
        expect(token.mfaPendingTenantIds).toEqual(['t-beta']);
    });

    it('nothing is pending when no other workspace asks for a code', async () => {
        db.policies = { 't-alpha': 'DISABLED', 't-beta': 'OPTIONAL' };
        const token = await signIn();
        expect(token.mfaPendingTenantIds).toEqual([]);
    });
});

describe('the edge holds a pending workspace, and only it', () => {
    let cookie: string;
    beforeEach(async () => {
        cookie = await cookieFor({ mfaPendingTenantIds: ['t-beta'] });
    });

    it("sends a page in the pending workspace to that workspace's own challenge", async () => {
        expect((await edge(cookie, '/t/beta/dashboard')).location).toBe('/t/beta/auth/mfa?next=%2Ft%2Fbeta%2Fdashboard');
    });

    it("refuses the pending workspace's API", async () => {
        expect((await edge(cookie, '/api/t/beta/controls')).status).toBe(403);
    });

    it('leaves the workspace that asked for nothing alone', async () => {
        expect((await edge(cookie, '/t/alpha/dashboard')).location).toBeNull();
    });

    it("keeps the pending workspace's challenge and enrolment reachable", async () => {
        expect((await edge(cookie, '/t/beta/auth/mfa')).location).toBeNull();
        expect((await edge(cookie, '/t/beta/security/mfa')).location).toBeNull();
    });

    it('holds org paths too: an org portfolio includes the pending workspace', async () => {
        expect((await edge(cookie, '/org/holding')).location).toBe('/t/beta/auth/mfa?next=%2Forg%2Fholding');
    });

    it("sends a pending PRIMARY to the primary's challenge, whichever workspace was asked for", async () => {
        const primaryPending = await cookieFor({ mfaPending: true, mfaPendingTenantIds: [] });
        expect((await edge(primaryPending, '/t/beta/dashboard')).location).toBe('/t/alpha/auth/mfa?next=%2Ft%2Fbeta%2Fdashboard');
    });
});

describe("passing a workspace's challenge clears that workspace", () => {
    async function refreshed(cookie: string) {
        const req = new NextRequest(`${ORIGIN}/api/auth/session`, { headers: { cookie: `${COOKIE}=${cookie}` } });
        currentRequest = req;
        const res = await nextAuthGet(req, { params: Promise.resolve({ nextauth: ['session'] }) });
        const set = res.headers.getSetCookie().find((c: string) => c.startsWith(`${COOKIE}=`))!;
        return (await decode({ token: set.split(';')[0].split('=').slice(1).join('='), secret: SECRET })) as any;
    }

    it('a challenge this session passed clears the workspace', async () => {
        const cookie = await cookieFor({ mfaPendingTenantIds: ['t-beta'] });
        db.sessionPasses['sess-this'].push('t-beta');
        expect((await refreshed(cookie)).mfaPendingTenantIds).toEqual([]);
    });

    it('a challenge another session passed does not', async () => {
        const cookie = await cookieFor({ mfaPendingTenantIds: ['t-beta'] });
        db.sessionPasses['sess-other'].push('t-beta');
        expect((await refreshed(cookie)).mfaPendingTenantIds).toEqual(['t-beta']);
    });

    it('a session with no row clears nothing', async () => {
        const cookie = await cookieFor({ mfaPendingTenantIds: ['t-beta'], userSessionId: 'sess-gone' });
        db.sessionPasses['sess-this'].push('t-beta');
        expect((await refreshed(cookie)).mfaPendingTenantIds).toEqual(['t-beta']);
    });
});

describe('when the primary workspace changes during the session', () => {
    /** A refresh of the claims through the real `jwt` callback. */
    async function refresh(token: Record<string, unknown>) {
        return jwtCallback({ token: token as any, trigger: 'update' } as any);
    }

    it("the new primary keeps the code it still wanted, and the edge holds the session at its challenge", async () => {
        db.policies = { 't-beta': 'REQUIRED' };
        const signedIn: any = await signIn();
        expect(signedIn.tenantId).toBe('t-alpha');
        expect(signedIn.mfaPending).toBe(false);
        expect(signedIn.mfaPendingTenantIds).toEqual(['t-beta']);

        // The member loses `alpha`; `beta` becomes the primary.
        db.memberships = [BOTH_WORKSPACES[1]];
        const after: any = await refresh({ ...signedIn, userSessionId: 'sess-this' });
        expect(after.tenantId).toBe('t-beta');
        expect(after.mfaPending).toBe(true);
        expect(after.mfaPendingTenantIds).toEqual([]);

        const cookie = await cookieFor({ ...after, memberships: [MEMBERSHIPS[1]] });
        expect((await edge(cookie, '/t/beta/dashboard')).location).toMatch(/^\/t\/beta\/auth\/mfa/);
    });

    it('a new primary that asked for nothing, or whose code this session passed, is not held', async () => {
        db.policies = { 't-beta': 'REQUIRED' };
        const signedIn: any = await signIn();
        // This session passed beta's challenge before alpha was lost.
        db.sessionPasses['sess-this'] = ['t-beta'];
        const passed: any = await jwtCallback({ token: { ...signedIn, userSessionId: 'sess-this' } as any } as any);
        expect(passed.mfaPendingTenantIds).toEqual([]);

        db.memberships = [BOTH_WORKSPACES[1]];
        const after: any = await refresh(passed);
        expect(after.tenantId).toBe('t-beta');
        expect(after.mfaPending).toBe(false);
    });

    it("an unchanged primary keeps its own flag on a refresh", async () => {
        db.policies = { 't-alpha': 'REQUIRED' };
        const signedIn: any = await signIn();
        expect(signedIn.mfaPending).toBe(true);
        const after: any = await refresh({ ...signedIn, userSessionId: 'sess-this' });
        expect(after.tenantId).toBe('t-alpha');
        expect(after.mfaPending).toBe(true);
    });
});
