/* eslint-disable @typescript-eslint/no-explicit-any -- a Prisma double and
 * NextAuth route-handler call shapes; the file-level disable is this repo's
 * standard for the shape. */
/**
 * "Enforce SSO" holds at sign-in and at the edge.
 *
 * The admin form promised that while a workspace enforces single sign-on its
 * people sign in through its identity provider and only break-glass admins may
 * still use a password. Nothing read the flag. Now
 * (src/lib/auth/sso-enforcement.ts) a workspace that enforces SSO is reachable
 * only by a session its own IdP opened, or by an OWNER/ADMIN with a password
 * who signed in with it.
 *
 * This runs the real NextAuth handler (CSRF, then the credentials callback),
 * the real `signIn` and `jwt` callbacks and the real middleware, with Prisma
 * doubled in memory and the password check stubbed:
 *
 *   - a password sign-in that enforcement would leave with no workspace is
 *     refused, naming the workspace, and opens no session;
 *   - a person with another workspace still signs in, and the session carries
 *     no claim to the enforced one, so the edge refuses it;
 *   - a break-glass OWNER keeps the password way in;
 *   - Google is not a way around it, even for that OWNER;
 *   - nothing changes for a workspace that does not enforce SSO.
 */
type Membership = { tenantId: string; slug: string; role: string; status: string; createdAt: Date };
const db = {
    memberships: [] as Membership[],
    enforced: [] as string[],
    passwordHash: '$2b$10$hash' as string | null,
};

jest.mock('@/lib/prisma', () => {
    const USER = { id: 'user-1', email: 'member@example.com', name: 'Mem Ber', sessionVersion: 1 };
    const active = () =>
        db.memberships
            .filter((m) => m.status === 'ACTIVE')
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map((m) => ({ tenantId: m.tenantId, role: m.role, tenant: { id: m.tenantId, slug: m.slug } }));
    const prisma: any = {
        user: {
            findUnique: jest.fn(async () => ({
                ...USER,
                passwordHash: db.passwordHash,
                tenantMemberships: active(),
                orgMemberships: [],
            })),
        },
        tenantIdentityProvider: {
            findMany: jest.fn(async ({ where }: any) =>
                db.enforced
                    .filter((t) => (where.tenantId.in as string[]).includes(t))
                    .map((tenantId) => ({ tenantId })),
            ),
        },
        tenantSecuritySettings: { findUnique: jest.fn(async () => null) },
        userMfaEnrollment: { findUnique: jest.fn(async () => null) },
    };
    return { __esModule: true, default: prisma, prisma };
});
jest.mock('@/lib/auth/credentials', () => ({
    authenticateWithPassword: jest.fn(async () => ({
        ok: true, userId: 'user-1', email: 'member@example.com', name: 'Mem Ber',
    })),
}));
jest.mock('@/lib/security/session-tracker', () => ({
    recordNewSession: jest.fn(async () => ({ sessionId: 'user-session-1' })),
    verifyAndTouchSession: jest.fn(async () => ({ revoked: false })),
}));
let currentRequest: any = null;
jest.mock('next/headers', () => ({
    cookies: async () => ({
        getAll: () => currentRequest.cookies.getAll(),
        get: (name: string) => currentRequest.cookies.get(name),
    }),
    headers: async () => currentRequest.headers,
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
import { GET as nextAuthGet, POST as nextAuthPost } from '@/app/api/auth/[...nextauth]/route';
import { authOptions } from '@/auth';
import middleware from '../../src/middleware';

const SECRET = process.env.AUTH_SECRET as string;
const ORIGIN = 'http://localhost:3000';
const SESSION_COOKIE = 'next-auth.session-token';

const setCookie = (res: Response, name: string) =>
    res.headers.getSetCookie().find((c: string) => c.startsWith(`${name}=`));
const cookieValue = (header: string) => header.split(';')[0].split('=').slice(1).join('=');

/** What the sign-in form does: CSRF, then the credentials callback. */
async function passwordSignIn(): Promise<{ session: string | null; url: string }> {
    const csrfReq = new NextRequest(`${ORIGIN}/api/auth/csrf`);
    currentRequest = csrfReq;
    const csrfRes = await nextAuthGet(csrfReq, { params: Promise.resolve({ nextauth: ['csrf'] }) });
    const { csrfToken } = await csrfRes.json();
    const csrfCookie = setCookie(csrfRes, 'next-auth.csrf-token')!.split(';')[0];

    const req = new NextRequest(`${ORIGIN}/api/auth/callback/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
        body: new URLSearchParams({
            csrfToken, json: 'true', email: 'member@example.com', password: 'pw', callbackUrl: `${ORIGIN}/tenants`,
        }).toString(),
    });
    currentRequest = req;
    const res = await nextAuthPost(req, { params: Promise.resolve({ nextauth: ['callback', 'credentials'] }) });
    const session = setCookie(res, SESSION_COOKIE);
    const { url } = await res.json();
    return { session: session ? cookieValue(session) : null, url };
}

/** The claims an OAuth (Google) sign-in mints, through the real `jwt` callback. */
async function googleSignInToken(): Promise<string> {
    const jwt = authOptions.callbacks!.jwt!;
    const token = await jwt({
        token: { sub: 'user-1', email: 'member@example.com', name: 'Mem Ber' },
        user: { id: 'user-1', email: 'member@example.com', name: 'Mem Ber' } as any,
        account: { provider: 'google', type: 'oauth', providerAccountId: 'g-1' } as any,
        trigger: 'signIn',
    } as any);
    return encode({ secret: SECRET, token: token as any });
}

async function gateFor(session: string, path: string): Promise<string | null> {
    const res = await middleware(new NextRequest(`${ORIGIN}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
    const location = res?.headers.get('location');
    return location ? new URL(location).pathname : null;
}

beforeAll(() => {
    process.env.NEXTAUTH_URL = ORIGIN;
});

beforeEach(() => {
    db.memberships = [
        { tenantId: 'tenant-b', slug: 'beta', role: 'READER', status: 'ACTIVE', createdAt: new Date('2025-01-01') },
    ];
    db.enforced = [];
    db.passwordHash = '$2b$10$hash';
});

describe('"Enforce SSO" at sign-in and at the edge', () => {
    it('refuses a password sign-in that would leave no workspace, names the workspace, and opens no session', async () => {
        db.enforced = ['tenant-b'];
        const { session, url } = await passwordSignIn();
        expect(session).toBeNull();
        expect(new URL(url, ORIGIN).searchParams.get('error')).toBe('sso_required:beta');
    });

    it('lets a person with another workspace sign in, with no claim to the enforced one', async () => {
        db.memberships.push({ tenantId: 'tenant-c', slug: 'gamma', role: 'EDITOR', status: 'ACTIVE', createdAt: new Date('2026-01-01') });
        db.enforced = ['tenant-b'];
        const { session } = await passwordSignIn();
        expect(session).not.toBeNull();

        const claims: any = await decode({ token: session!, secret: SECRET });
        expect(claims.signInMethod).toBe('credentials');
        expect(claims.memberships.map((m: any) => m.slug)).toEqual(['gamma']);
        expect(await gateFor(session!, '/t/gamma/dashboard')).toBeNull();
        expect(await gateFor(session!, '/t/beta/dashboard')).not.toBeNull();
    });

    it('keeps the password way in for a break-glass OWNER', async () => {
        db.memberships[0].role = 'OWNER';
        db.enforced = ['tenant-b'];
        const { session } = await passwordSignIn();
        expect(session).not.toBeNull();
        expect(await gateFor(session!, '/t/beta/dashboard')).toBeNull();
    });

    it('does not count an OWNER without a password as break-glass', async () => {
        db.memberships[0].role = 'OWNER';
        db.passwordHash = null;
        db.enforced = ['tenant-b'];
        const { session, url } = await passwordSignIn();
        expect(session).toBeNull();
        expect(new URL(url, ORIGIN).searchParams.get('error')).toBe('sso_required:beta');
    });

    it('is not side-stepped by Google, even for that OWNER', async () => {
        db.memberships[0].role = 'OWNER';
        db.enforced = ['tenant-b'];
        const session = await googleSignInToken();
        const claims: any = await decode({ token: session, secret: SECRET });
        expect(claims.signInMethod).toBe('oauth');
        expect(claims.memberships).toEqual([]);
        expect(await gateFor(session, '/t/beta/dashboard')).not.toBeNull();
    });

    it('changes nothing for a workspace that does not enforce SSO', async () => {
        const { session } = await passwordSignIn();
        expect(session).not.toBeNull();
        expect(await gateFor(session!, '/t/beta/dashboard')).toBeNull();
        expect(await gateFor(await googleSignInToken(), '/t/beta/dashboard')).toBeNull();
    });
});
