/* eslint-disable @typescript-eslint/no-explicit-any -- a Prisma double and a
 * NextAuth route-handler call shape; the file-level disable is this repo's
 * standard for the shape. */
/**
 * A correct MFA code must get the user past the edge gate.
 *
 * The edge middleware reads `mfaPending` from the session COOKIE. After a
 * correct code, `verifyMfaChallenge` stamps `lastChallengeAt`, and the `jwt`
 * callback in `src/auth.ts` clears `mfaPending` on its next run — but in the
 * App Router a server read never writes the re-signed cookie back. Only
 * NextAuth's session route does. The challenge page used to navigate straight
 * on, so the cookie still said `mfaPending: true`, the gate sent the user back
 * to the challenge, and a workspace that required MFA admitted nobody.
 *
 * This runs the real pieces end to end — the real `/api/auth/session` handler,
 * the real `jwt` callback, the cookie it writes, and the real middleware
 * reading that cookie — with only Prisma doubled:
 *
 *   1. the cookie minted at sign-in, unrefreshed, is still sent to the
 *      challenge even after the code is recorded (the loop the page hit);
 *   2. the session route rewrites it with `mfaPending: false` once the code is
 *      recorded, and the gate then lets the user through;
 *   3. the session route does NOT clear it before a code is recorded, so the
 *      refresh is no way around the second factor.
 *
 * The page half — that the challenge page calls the session route before it
 * navigates — is tests/rendered/mfa-challenge-refresh.test.tsx.
 */
const enrollment = { lastChallengeAt: null as Date | null, isVerified: true };
jest.mock('@/lib/prisma', () => {
    const prisma = {
        userMfaEnrollment: { findUnique: jest.fn(async () => enrollment) },
        user: { findUnique: jest.fn(async () => ({ sessionVersion: 1 })) },
    };
    return { __esModule: true, default: prisma, prisma };
});
// NextAuth's App Router handler reads the incoming cookies and headers through
// `next/headers`, which Next fills from the live request. Here that request is
// the one the test hands the handler.
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
import { encode, decode } from 'next-auth/jwt';
import { GET as nextAuthGet } from '@/app/api/auth/[...nextauth]/route';
import middleware from '../../src/middleware';

const SECRET = process.env.AUTH_SECRET as string;
const COOKIE = 'next-auth.session-token';
const ORIGIN = 'http://localhost:3000';

/** The cookie a password sign-in mints for a member of a tenant that requires MFA. */
async function signedInCookie(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return encode({
        secret: SECRET,
        token: {
            sub: 'user-1',
            userId: 'user-1',
            email: 'member@example.com',
            role: 'READER',
            mfaPending: true,
            tenantId: 'tenant-1',
            tenantSlug: 'acme',
            memberships: [{ slug: 'acme', role: 'READER', tenantId: 'tenant-1' }],
            orgMemberships: [],
            sessionVersion: 1,
            // Checked just now, so the 5-minute claims refresh stays out of the way.
            sessionVersionCheckedAt: now,
        } as any,
    });
}

/** GET /api/auth/session through the real NextAuth handler; returns the re-signed cookie value. */
async function refreshThroughSessionRoute(cookie: string): Promise<string> {
    const req = new NextRequest(`${ORIGIN}/api/auth/session`, { headers: { cookie: `${COOKIE}=${cookie}` } });
    currentRequest = req;
    const res = await nextAuthGet(req, { params: Promise.resolve({ nextauth: ['session'] }) });
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().find((c: string) => c.startsWith(`${COOKIE}=`));
    expect(set).toBeDefined();
    return set!.slice(COOKIE.length + 1).split(';')[0];
}

/** Where the real middleware sends a page request carrying this cookie (null = let through). */
async function gateFor(cookie: string): Promise<string | null> {
    const res = await middleware(
        new NextRequest(`${ORIGIN}/t/acme/dashboard`, { headers: { cookie: `${COOKIE}=${cookie}` } }),
    );
    const location = res?.headers.get('location');
    return location ? new URL(location).pathname : null;
}

beforeAll(() => {
    process.env.NEXTAUTH_URL = ORIGIN;
});

beforeEach(() => {
    enrollment.lastChallengeAt = null;
});

describe('MFA challenge → session cookie → edge gate', () => {
    it('the unrefreshed sign-in cookie is still sent to the challenge after the code is recorded', async () => {
        const cookie = await signedInCookie();
        enrollment.lastChallengeAt = new Date(Date.now() + 2000);
        expect(await gateFor(cookie)).toBe('/t/acme/auth/mfa');
    });

    it('the session route rewrites the cookie once the code is recorded, and the gate lets the user through', async () => {
        const cookie = await signedInCookie();
        enrollment.lastChallengeAt = new Date(Date.now() + 2000);

        const refreshed = await refreshThroughSessionRoute(cookie);
        const claims = await decode({ token: refreshed, secret: SECRET });
        expect(claims?.mfaPending).toBe(false);
        expect(await gateFor(refreshed)).not.toBe('/t/acme/auth/mfa');
    });

    it('the session route does not clear it before a code is recorded', async () => {
        const cookie = await signedInCookie();
        const refreshed = await refreshThroughSessionRoute(cookie);
        const claims = await decode({ token: refreshed, secret: SECRET });
        expect(claims?.mfaPending).toBe(true);
        expect(await gateFor(refreshed)).toBe('/t/acme/auth/mfa');
    });
});
