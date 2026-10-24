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
    /** Workspaces whose challenge was passed, and when. */
    challengedAt: {} as Record<string, Date>,
};

jest.mock('@/lib/prisma', () => {
    const prisma: any = {
        user: {
            findUnique: jest.fn(async () => ({
                id: 'user-1',
                sessionVersion: 1,
                passwordHash: 'hash',
                tenantMemberships: [
                    // `alpha` is older, so it is the primary workspace.
                    { tenantId: 't-alpha', role: 'EDITOR', tenant: { id: 't-alpha', slug: 'alpha' } },
                    { tenantId: 't-beta', role: 'EDITOR', tenant: { id: 't-beta', slug: 'beta' } },
                ],
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
            findMany: jest.fn(async ({ where }: any) =>
                (where.tenantId.in as string[])
                    .filter((id) => {
                        if (where.lastChallengeAt === undefined) return false;
                        const at = db.challengedAt[id];
                        return at !== undefined && at >= where.lastChallengeAt.gte;
                    })
                    .map((tenantId) => ({ tenantId, isVerified: true })),
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
    db.challengedAt = {};
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

    it('a challenge passed after the token was issued clears the workspace', async () => {
        const cookie = await cookieFor({ mfaPendingTenantIds: ['t-beta'] });
        db.challengedAt['t-beta'] = new Date(Date.now() + 1000);
        expect((await refreshed(cookie)).mfaPendingTenantIds).toEqual([]);
    });

    it('a challenge passed before the token was issued does not', async () => {
        const cookie = await cookieFor({ mfaPendingTenantIds: ['t-beta'] });
        db.challengedAt['t-beta'] = new Date(Date.now() - 60 * 60_000);
        expect((await refreshed(cookie)).mfaPendingTenantIds).toEqual(['t-beta']);
    });
});
