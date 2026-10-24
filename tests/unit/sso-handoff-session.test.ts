/* eslint-disable @typescript-eslint/no-explicit-any -- a Prisma double and
 * NextAuth route-handler call shapes; the file-level disable is this repo's
 * standard for the shape. */
/**
 * A single sign-on ends in a session the app actually reads, and that session
 * reaches only the workspace whose identity provider vouched for the person.
 *
 * The SSO callbacks used to sign their own cookie with `jsonwebtoken`, named
 * `authjs.session-token`. NextAuth v4 reads `next-auth.session-token`, so the
 * edge gate never saw it and every SSO sign-in landed back on /login. They now
 * leave a single-use hand-off for the `sso-handoff` NextAuth provider, and
 * NextAuth opens the session.
 *
 * This runs the real pieces — the real OIDC and SAML callback routes, the real
 * NextAuth handler with the real `authorize`, `signIn` and `jwt` callbacks, and
 * the real middleware reading the cookie NextAuth wrote — with Prisma doubled
 * in memory and the identity provider's network calls stubbed:
 *
 *   1. both callbacks hand off: a scoped HttpOnly cookie and the completion
 *      page, never a session cookie of their own;
 *   2. redeeming the hand-off opens a NextAuth session that the edge lets into
 *      the SSO workspace, and into no other workspace or organization the
 *      account belongs to;
 *   3. a hand-off redeems once, only from the cookie, and not for a
 *      membership that ended after the callback;
 *   4. the SSO workspace's MFA policy applies to the session.
 */

// ── In-memory Prisma ─────────────────────────────────────────────────

type Membership = { tenantId: string; slug: string; role: string; status: string; createdAt: Date };
const db = {
    tokens: [] as { identifier: string; token: string; expires: Date }[],
    memberships: [] as Membership[],
    mfaPolicy: {} as Record<string, string>,
};

function matchesToken(row: { identifier: string; token: string; expires: Date }, where: any): boolean {
    if (where.token !== undefined && row.token !== where.token) return false;
    if (typeof where.identifier === 'string' && row.identifier !== where.identifier) return false;
    if (typeof where.identifier === 'object' && !row.identifier.startsWith(where.identifier.startsWith)) return false;
    if (where.expires?.gt && !(row.expires > where.expires.gt)) return false;
    if (where.expires?.lt && !(row.expires < where.expires.lt)) return false;
    return true;
}

jest.mock('@/lib/prisma', () => {
    const USER = { id: 'user-1', email: 'member@example.com', name: 'Mem Ber', sessionVersion: 1 };
    const prisma: any = {
        $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
        verificationToken: {
            create: jest.fn(async ({ data }: any) => {
                db.tokens.push({ ...data });
                return data;
            }),
            findUnique: jest.fn(async ({ where }: any) => db.tokens.find((r) => r.token === where.token) ?? null),
            deleteMany: jest.fn(async ({ where }: any) => {
                const before = db.tokens.length;
                db.tokens = db.tokens.filter((r) => !matchesToken(r, where));
                return { count: before - db.tokens.length };
            }),
        },
        tenant: {
            findUnique: jest.fn(async ({ where }: any) =>
                where.slug === 'beta' ? { id: 'tenant-b', slug: 'beta' } : null,
            ),
        },
        tenantIdentityProvider: {
            findFirst: jest.fn(async ({ where }: any) => ({
                id: 'idp-1',
                tenantId: 'tenant-b',
                isEnabled: true,
                type: where.type,
                configJson:
                    where.type === 'OIDC'
                        ? { issuer: 'https://idp.example', clientId: 'client', clientSecret: 'secret' }
                        : { entityId: 'urn:idp', ssoUrl: 'https://idp.example/sso', certificate: 'MIIC' },
            })),
        },
        tenantMembership: {
            findUnique: jest.fn(async ({ where }: any) => {
                const { tenantId, userId } = where.tenantId_userId;
                const m = db.memberships.find((x) => x.tenantId === tenantId);
                return m && userId === USER.id ? { ...m, user: USER } : null;
            }),
        },
        user: {
            findUnique: jest.fn(async ({ where }: any) => {
                if (where.id && where.id !== USER.id) return null;
                return {
                    ...USER,
                    tenantMemberships: db.memberships
                        .filter((m) => m.status === 'ACTIVE')
                        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                        .map((m) => ({ tenantId: m.tenantId, role: m.role, tenant: { id: m.tenantId, slug: m.slug } })),
                    orgMemberships: [
                        { organizationId: 'org-o', role: 'ORG_ADMIN', organization: { id: 'org-o', slug: 'omega' } },
                    ],
                };
            }),
        },
        tenantSecuritySettings: {
            findUnique: jest.fn(async ({ where }: any) => ({
                mfaPolicy: db.mfaPolicy[where.tenantId] ?? 'DISABLED',
                mfaFailClosed: false,
            })),
        },
        userMfaEnrollment: { findUnique: jest.fn(async () => null) },
    };
    return { __esModule: true, default: prisma, prisma };
});

jest.mock('@/lib/security/session-tracker', () => ({
    recordNewSession: jest.fn(async () => ({ sessionId: 'user-session-1' })),
    verifyAndTouchSession: jest.fn(async () => ({ revoked: false })),
}));

// ── The identity provider ────────────────────────────────────────────

jest.mock('@/lib/security/oidc-client', () => ({
    decodeState: jest.fn(() => ({ tenantSlug: 'beta', providerId: 'idp-1', codeVerifier: 'v', nonce: 'n' })),
    discoverOidc: jest.fn(async () => ({})),
    exchangeCodeForTokens: jest.fn(async () => ({ id_token: 'id-token' })),
    validateIdTokenNonce: jest.fn(() => true),
    extractIdTokenClaims: jest.fn(() => ({ sub: 'ext-1', email: 'member@example.com' })),
}));
jest.mock('@/lib/security/saml-client', () => ({
    decodeSamlRelayState: jest.fn(() => ({ tenantSlug: 'beta', providerId: 'idp-1' })),
    buildSamlInstance: jest.fn(() => ({})),
    validateSamlResponse: jest.fn(async () => ({ nameId: 'ext-1', email: 'member@example.com', name: 'Mem Ber' })),
}));
jest.mock('@/app-layer/usecases/sso', () => ({
    linkExternalIdentity: jest.fn(async () => ({ status: 'linked', userId: 'user-1', isNewLink: false })),
}));

// ── Request plumbing ─────────────────────────────────────────────────

// NextAuth's App Router handler (and the hand-off provider) read cookies and
// headers through `next/headers`, which Next fills from the live request. Here
// that request is the one the test hands the handler.
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
import { decode } from 'next-auth/jwt';
import { GET as nextAuthGet, POST as nextAuthPost } from '@/app/api/auth/[...nextauth]/route';
import { GET as oidcCallback } from '@/app/api/auth/sso/oidc/callback/route';
import { POST as samlCallback } from '@/app/api/auth/sso/saml/callback/route';
import middleware from '../../src/middleware';

const SECRET = process.env.AUTH_SECRET as string;
const ORIGIN = 'http://localhost:3000';
const SESSION_COOKIE = 'next-auth.session-token';

function setCookie(res: Response, name: string): string | undefined {
    return res.headers.getSetCookie().find((c: string) => c.startsWith(`${name}=`));
}
const cookieValue = (header: string) => header.split(';')[0].split('=').slice(1).join('=');

async function runOidcCallback(): Promise<Response> {
    const req = new NextRequest(`${ORIGIN}/api/auth/sso/oidc/callback?code=abc&state=xyz`);
    currentRequest = req;
    return oidcCallback(req);
}

async function runSamlCallback(): Promise<Response> {
    const body = new URLSearchParams({ SAMLResponse: 'PHNhbWw+', RelayState: 'relay' });
    const req = new NextRequest(`${ORIGIN}/api/auth/sso/saml/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    currentRequest = req;
    return samlCallback(req);
}

/**
 * What `signIn('sso-handoff', { redirect: false })` does from the completion
 * page: fetch a CSRF token, then POST the provider's callback. Returns the
 * session cookie NextAuth set, if any.
 */
async function redeemThroughNextAuth(
    handoffCookie: string | null,
    extraBody: Record<string, string> = {},
): Promise<string | null> {
    const csrfReq = new NextRequest(`${ORIGIN}/api/auth/csrf`);
    currentRequest = csrfReq;
    const csrfRes = await nextAuthGet(csrfReq, { params: Promise.resolve({ nextauth: ['csrf'] }) });
    const { csrfToken } = await csrfRes.json();
    const csrfCookie = setCookie(csrfRes, 'next-auth.csrf-token')!.split(';')[0];

    const cookies = [csrfCookie];
    if (handoffCookie) cookies.push(`inflect_sso_handoff=${handoffCookie}`);
    const req = new NextRequest(`${ORIGIN}/api/auth/callback/sso-handoff`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies.join('; ') },
        body: new URLSearchParams({ csrfToken, json: 'true', callbackUrl: `${ORIGIN}/t/beta/dashboard`, ...extraBody }).toString(),
    });
    currentRequest = req;
    const res = await nextAuthPost(req, { params: Promise.resolve({ nextauth: ['callback', 'sso-handoff'] }) });
    const session = setCookie(res, SESSION_COOKIE);
    return session ? cookieValue(session) : null;
}

/** Where the real middleware sends a page request carrying this session (null = let through). */
async function gateFor(sessionCookie: string, path: string): Promise<string | null> {
    const res = await middleware(new NextRequest(`${ORIGIN}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const location = res?.headers.get('location');
    return location ? new URL(location).pathname : null;
}

async function handoffFromCallback(): Promise<string> {
    const res = await runOidcCallback();
    return cookieValue(setCookie(res, 'inflect_sso_handoff')!);
}

beforeAll(() => {
    process.env.NEXTAUTH_URL = ORIGIN;
});

beforeEach(() => {
    db.tokens = [];
    // The account belongs to two workspaces; `alpha` is the older one, so it
    // is the one an unscoped session would make primary.
    db.memberships = [
        { tenantId: 'tenant-a', slug: 'alpha', role: 'ADMIN', status: 'ACTIVE', createdAt: new Date('2025-01-01') },
        { tenantId: 'tenant-b', slug: 'beta', role: 'READER', status: 'ACTIVE', createdAt: new Date('2026-01-01') },
    ];
    db.mfaPolicy = {};
});

describe('the SSO callbacks hand off to NextAuth', () => {
    it('SAML: a refusal reaches the sign-in page as a GET', async () => {
        db.memberships[1].status = 'DEACTIVATED';
        const res = await runSamlCallback();
        expect(res.status).toBe(303);
        expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('no_membership');
    });

    it.each([
        ['OIDC', runOidcCallback],
        ['SAML', runSamlCallback],
    ])('%s: a scoped, single-use hand-off cookie and the completion page — no session cookie of its own', async (_kind, run) => {
        const res = await run();

        // See Other: the SAML callback answers a POST, which must not be
        // replayed to the completion page.
        expect(res.status).toBe(303);
        const location = new URL(res.headers.get('location')!);
        expect(location.pathname).toBe('/login/sso-complete');
        expect(location.searchParams.get('next')).toBe('/t/beta/dashboard');

        const handoff = setCookie(res, 'inflect_sso_handoff');
        expect(handoff).toBeDefined();
        expect(handoff).toMatch(/Path=\/api\/auth\/callback\/sso-handoff/i);
        expect(handoff).toMatch(/HttpOnly/i);
        expect(handoff).toMatch(/Max-Age=60/i);

        const names = res.headers.getSetCookie().map((c: string) => c.split('=')[0]);
        expect(names).toEqual(['inflect_sso_handoff']);
        expect(db.tokens).toHaveLength(1);
        // Stored hashed: the cookie's value is not in the table.
        expect(db.tokens[0].token).not.toBe(cookieValue(handoff!));
    });

    it('a membership that is not ACTIVE gets no hand-off', async () => {
        db.memberships[1].status = 'DEACTIVATED';
        const res = await runOidcCallback();
        const location = new URL(res.headers.get('location')!);
        expect(location.pathname).toBe('/login');
        expect(location.searchParams.get('error')).toBe('no_membership');
        expect(setCookie(res, 'inflect_sso_handoff')).toBeUndefined();
        expect(db.tokens).toHaveLength(0);
    });
});

describe('redeeming the hand-off opens a NextAuth session scoped to the SSO workspace', () => {
    it('the session NextAuth writes names the SSO workspace alone', async () => {
        const session = await redeemThroughNextAuth(await handoffFromCallback());
        expect(session).not.toBeNull();

        const claims: any = await decode({ token: session!, secret: SECRET });
        expect(claims.userId).toBe('user-1');
        expect(claims.ssoTenantId).toBe('tenant-b');
        expect(claims.tenantId).toBe('tenant-b');
        expect(claims.tenantSlug).toBe('beta');
        expect(claims.memberships).toEqual([{ slug: 'beta', role: 'READER', tenantId: 'tenant-b' }]);
        expect(claims.orgMemberships).toEqual([]);
        expect(claims.mfaPending).toBe(false);
        // The operational session row, so revocation works on it.
        expect(claims.userSessionId).toBe('user-session-1');
    });

    it('the edge lets it into the SSO workspace and nowhere else the account belongs', async () => {
        const session = (await redeemThroughNextAuth(await handoffFromCallback()))!;
        expect(await gateFor(session, '/t/beta/dashboard')).toBeNull();
        expect(await gateFor(session, '/t/alpha/dashboard')).not.toBeNull();
        expect(await gateFor(session, '/org/omega')).not.toBeNull();
    });

    it("the SSO workspace's MFA policy applies, not the account's oldest workspace's", async () => {
        db.mfaPolicy = { 'tenant-a': 'DISABLED', 'tenant-b': 'REQUIRED' };
        const session = (await redeemThroughNextAuth(await handoffFromCallback()))!;
        const claims: any = await decode({ token: session, secret: SECRET });
        expect(claims.mfaPending).toBe(true);
        expect(await gateFor(session, '/t/beta/dashboard')).toBe('/t/beta/auth/mfa');
    });
});

describe('a hand-off is good once, from its cookie, for a live membership', () => {
    it('redeems once', async () => {
        const handoff = await handoffFromCallback();
        expect(await redeemThroughNextAuth(handoff)).not.toBeNull();
        expect(await redeemThroughNextAuth(handoff)).toBeNull();
    });

    it('is read from the cookie only — the same value in the request body opens nothing', async () => {
        const handoff = await handoffFromCallback();
        expect(await redeemThroughNextAuth(null, { handoff, token: handoff })).toBeNull();
        // ...and was not spent by the attempt.
        expect(await redeemThroughNextAuth(handoff)).not.toBeNull();
    });

    it('opens nothing for a membership ended after the callback', async () => {
        const handoff = await handoffFromCallback();
        db.memberships[1].status = 'DEACTIVATED';
        expect(await redeemThroughNextAuth(handoff)).toBeNull();
    });

    it('opens nothing once expired', async () => {
        const handoff = await handoffFromCallback();
        db.tokens[0].expires = new Date(Date.now() - 1000);
        expect(await redeemThroughNextAuth(handoff)).toBeNull();
    });
});
