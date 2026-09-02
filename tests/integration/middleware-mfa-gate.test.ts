/* eslint-disable @typescript-eslint/no-explicit-any -- middleware test harness
 * mirrors tests/integration/middleware-public-reachability.test.ts (NextRequest
 * fixtures + mocked rate-limiters + getToken). */
/**
 * #2223 — MFA is enforced against the authenticated PRINCIPAL, not the URL
 * prefix.
 *
 * The gate used to be `isTenantPath(pathname) && !isMfaAllowedPath(pathname)`,
 * so an `mfaPending` session was refused on `/api/t/**` and admitted on all 93
 * flat API routes — 19 of which build a full tenant context via `getLegacyCtx`.
 *
 * A structural ratchet over `isTenantPath` call sites would not have caught
 * that and would not catch a regression: the defect is that the PREDICATE was
 * the wrong question, and a call-site scan cannot see the difference. So every
 * assertion here is behavioural, through the real `middleware()` export, one
 * per class of path.
 *
 * The four classes, and what each is protecting:
 *
 *   1. tenant path            — the one surface that always worked
 *   2. flat authenticated     — the 93 that did not; the actual bug
 *   3. public                 — must not regress into an MFA-gated surface
 *   4. token-authenticated    — machine callers must be untouched
 */
import { NextRequest } from 'next/server';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
    isApiReadRateLimited: jest.fn().mockReturnValue(false),
    extractTenantSlug: jest.fn().mockReturnValue(null),
}));
jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));

import middleware from '../../src/middleware';
import { getToken } from 'next-auth/jwt';

const mockGetToken = getToken as jest.Mock;

/** A signed-in user who has presented a password and not a second factor. */
function pendingToken(role: 'OWNER' | 'READER' = 'READER') {
    return {
        sub: 'user-1',
        userId: 'user-1',
        role,
        mfaPending: true,
        tenantId: 'tenant-1',
        tenantSlug: 'primary',
        memberships: [{ slug: 'acme', role, tenantId: 'tenant-1' }],
        orgMemberships: [{ slug: 'acme', role: 'ORG_ADMIN', organizationId: 'org-1' }],
    };
}

function req(method: string, pathname: string, headers: Record<string, string> = {}) {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method,
        headers: new Headers(headers),
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetToken.mockResolvedValue(pendingToken());
});

// ── Class 1 — tenant paths (the surface that already worked) ─────────

describe('MFA gate — class 1: tenant paths', () => {
    it('refuses a tenant API read', async () => {
        const res = await middleware(req('GET', '/api/t/acme/risks'), {} as any);
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({ error: 'MFA verification required' });
    });

    it('redirects a tenant page to the challenge, carrying `next`', async () => {
        const res = await middleware(req('GET', '/t/acme/dashboard'), {} as any);
        expect(res.status).toBe(307);
        const loc = new URL(res.headers.get('location')!);
        expect(loc.pathname).toBe('/t/acme/auth/mfa');
        expect(loc.searchParams.get('next')).toBe('/t/acme/dashboard');
    });
});

// ── Class 2 — flat authenticated paths (the bug) ─────────────────────

describe('MFA gate — class 2: flat authenticated API paths', () => {
    // Every one of these builds a tenant context through `getLegacyCtx`, or is
    // org/admin-scoped. All were reachable mid-challenge before #2223.
    it.each([
        ['the hash-chained audit trail', '/api/audit-log'],
        ['encrypted-at-rest evidence', '/api/evidence'],
        ['a single evidence record', '/api/evidence/ev-1'],
        ['findings', '/api/findings'],
        ['audits', '/api/audits'],
        ['the dashboard aggregate', '/api/dashboard'],
        ['notifications', '/api/notifications'],
        ['tasks', '/api/tasks'],
        ['clauses', '/api/clauses'],
        ['the framework mapping', '/api/mapping'],
        ['an org portfolio', '/api/org/acme/portfolio'],
        ['an org audit log', '/api/org/acme/audit-log'],
    ])('refuses %s (%s)', async (_label, path) => {
        const res = await middleware(req('GET', path), {} as any);
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({ error: 'MFA verification required' });
    });

    it('refuses a flat admin API even for an OWNER who clears the role gate', async () => {
        // Role is OWNER so section 3 passes; the MFA branch is what refuses.
        // A READER would be refused earlier with a different reason, which
        // would make this assertion prove nothing about MFA.
        mockGetToken.mockResolvedValue(pendingToken('OWNER'));
        const res = await middleware(req('GET', '/api/admin/diagnostics'), {} as any);
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({ error: 'MFA verification required' });
    });

    it('redirects a non-tenant PAGE using the token tenant, not the URL', async () => {
        // `/admin`, `/` and `/org/<slug>/…` carry no tenant slug. The old code
        // derived the slug from the path and, finding none, fell through — so
        // every page outside `/t/` skipped the gate silently.
        mockGetToken.mockResolvedValue(pendingToken('OWNER'));
        for (const path of ['/', '/admin', '/org/acme/dashboard']) {
            const res = await middleware(req('GET', path), {} as any);
            expect(res.status).toBe(307);
            const loc = new URL(res.headers.get('location')!);
            expect(loc.pathname).toBe('/t/primary/auth/mfa');
            expect(loc.searchParams.get('next')).toBe(path);
        }
    });
});

// ── Class 3 — public paths ───────────────────────────────────────────

describe('MFA gate — class 3: public paths', () => {
    // These are allowed at step 1, BEFORE the JWT is read. Asserting that
    // `getToken` was never called is the stronger claim: it shows the MFA
    // branch is unreachable for them rather than merely non-firing.
    it.each([
        ['liveness probe', '/api/livez'],
        ['readiness probe', '/api/readyz'],
        ['health alias', '/api/health'],
        ['NextAuth session', '/api/auth/session'],
        ['NextAuth sign-out', '/api/auth/signout'],
        ['the login page', '/login'],
        ['the tenant picker', '/tenants'],
        ['the no-tenant landing', '/no-tenant'],
        ['an invite preview', '/invite/tok123'],
    ])('%s is served without the JWT ever being read (%s)', async (_label, path) => {
        const res = await middleware(req('GET', path), {} as any);
        expect(res.status).toBe(200);
        expect(mockGetToken).not.toHaveBeenCalled();
    });
});

// ── Class 4 — token-authenticated machine callers ────────────────────

describe('MFA gate — class 4: token-authenticated machine surfaces', () => {
    it.each([
        ['SCIM', '/api/scim/v2/Users'],
        ['MCP', '/api/mcp'],
        ['the Stripe webhook', '/api/stripe/webhook'],
        ['the AV webhook', '/api/storage/av-webhook'],
        ['the SharePoint webhook', '/api/webhooks/sharepoint'],
        ['an integration webhook', '/api/integrations/webhooks/jira'],
        ['the CSP report beacon', '/api/csp-report'],
        ['the web-vitals beacon', '/api/telemetry/vitals'],
    ])('%s is untouched by the MFA gate (%s)', async (_label, path) => {
        const res = await middleware(req('POST', path), {} as any);
        expect(res.status).toBe(200);
        expect(mockGetToken).not.toHaveBeenCalled();
    });

    it('the gate is a no-op for any caller with no mfaPending claim', async () => {
        // A server-to-server credential produces no `mfaPending` at all. Prove
        // that directly rather than inferring it from the path exemptions
        // above: a token missing the field must not be treated as pending.
        mockGetToken.mockResolvedValue({
            sub: 'svc',
            role: 'READER',
            memberships: [{ slug: 'acme', role: 'READER', tenantId: 'tenant-1' }],
        });
        for (const path of ['/api/evidence', '/api/t/acme/risks', '/api/audit-log']) {
            const res = await middleware(req('GET', path), {} as any);
            expect(res.status).toBe(200);
        }
    });
});

// ── The allowlist — a pending user must be able to finish ────────────

describe('MFA gate — the challenge surface stays reachable', () => {
    it.each([
        ['the challenge page', '/t/acme/auth/mfa'],
        ['the enrolment page', '/t/acme/security/mfa'],
        ['the enrolment API', '/api/t/acme/security/mfa/enroll'],
        ['the challenge-verify API', '/api/t/acme/security/mfa/challenge/verify'],
    ])('%s is reachable while pending (%s)', async (_label, path) => {
        const res = await middleware(req('GET', path), {} as any);
        expect(res.status).toBe(200);
    });

    it('the enrolment page does not bounce back to the challenge', async () => {
        // Under a REQUIRED policy an unenrolled user is pending from first
        // sign-in, and the challenge page's "Set up MFA" button links here.
        // While `/t/<slug>/security/mfa` was gated, that click redirected
        // straight back to the challenge — a two-page loop with no way out.
        const res = await middleware(req('GET', '/t/acme/security/mfa'), {} as any);
        expect(res.headers.get('location')).toBeNull();
    });
});

// ── Nothing changes for a user who has completed the challenge ───────

describe('MFA gate — mfaPending false', () => {
    it.each([
        '/api/t/acme/risks',
        '/api/evidence',
        '/api/audit-log',
        '/t/acme/dashboard',
        '/',
    ])('%s passes once the challenge is done', async (path) => {
        mockGetToken.mockResolvedValue({ ...pendingToken('OWNER'), mfaPending: false });
        const res = await middleware(req('GET', path), {} as any);
        expect(res.status).toBe(200);
    });
});
