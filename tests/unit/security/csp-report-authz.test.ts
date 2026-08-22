/**
 * `GET /api/security/csp-report` is an operator surface, and `POST` on the
 * same path is a public sink. Both halves are load-bearing, in opposite
 * directions, which is the whole difficulty of this route.
 *
 * The path sits in `MACHINE_CALLER_PREFIXES` so the edge lets a
 * credential-less POST through — a browser will not attach a cookie to a CSP
 * report, so a gate there means zero reports, permanently and silently. That
 * allowlist matches on PATH, not method, so the GET was public too, and it
 * returned `getViolationSummary(50)`: whole `CspViolation` records carrying
 * `documentUri` (`/t/<tenant-slug>/…`, i.e. tenant slugs are enumerable),
 * `originalPolicy` (the enforced CSP, a map for anyone hunting a bypass),
 * `sourceFile` and `blockedUri` (#2103). The handler carried a comment saying
 * the middleware protected it, which is why nobody looked twice.
 *
 * So there are four things to keep true, and each negative below is paired
 * with the positive that proves the code got as far as deciding:
 *
 *   1. no credential          → 401, and the buffer HAD something to leak
 *   2. a session, any role    → 401 (a tenant role is the wrong axis: the
 *                               ring buffer is one array per PROCESS, so
 *                               reading it is cross-tenant by construction)
 *   3. the platform key       → 200 with the summary  ← without this, a
 *                               handler that refused everyone would pass 1+2
 *   4. POST, no credentials   → 204 AND the report is stored
 *
 * Nothing here mocks `verifyPlatformApiKey`. The gate under test is the real
 * constant-time compare against a real header — a mocked gate is satisfied
 * whether or not the handler consults it.
 */
import { NextRequest } from 'next/server';

import { isPublicPath } from '@/lib/auth/guard';

const HEADER = 'x-platform-admin-key';
const KEY = 'k'.repeat(40);
const WRONG_KEY = 'w'.repeat(40);
const PATH = '/api/security/csp-report';
const TENANT_PAGE = 'https://app.example/t/acme-holdings/risks/r-17';

type RouteModule = typeof import('@/app/api/security/csp-report/route');

const savedKey = process.env.PLATFORM_ADMIN_API_KEY;
const savedPrevious = process.env.PLATFORM_ADMIN_API_KEY_PREVIOUS;

/**
 * Load the route against whatever `PLATFORM_ADMIN_API_KEY` is set right now.
 *
 * `@/env` snapshots `process.env` when it is first evaluated, so the key has
 * to be in place BEFORE the require — hence require-in-isolate rather than a
 * top-level import. The isolation is also what makes the round trips below
 * independent: each load gets its own copy of the violation ring buffer, so
 * one test's report cannot satisfy another test's assertion.
 */
function loadRoute(): RouteModule {
    let mod: RouteModule | undefined;
    jest.isolateModules(() => {
        mod = require('@/app/api/security/csp-report/route') as RouteModule;
    });
    if (!mod) throw new Error('csp-report route failed to load');
    return mod;
}

function getRequest(headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(`http://localhost${PATH}`, { method: 'GET', headers });
}

/** A browser's CSP violation report: no cookie, no key, no bearer token. */
function reportRequest(documentUri = TENANT_PAGE): NextRequest {
    return new NextRequest(`http://localhost${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/csp-report' },
        body: JSON.stringify({
            'csp-report': {
                'document-uri': documentUri,
                'violated-directive': 'script-src',
                'blocked-uri': 'https://tracker.example/beacon.js',
                'original-policy': "default-src 'self'; script-src 'self' https://cdn.example",
                'source-file': 'https://app.example/_next/static/chunks/main.js',
            },
        }),
    });
}

beforeEach(() => {
    process.env.PLATFORM_ADMIN_API_KEY = KEY;
    delete process.env.PLATFORM_ADMIN_API_KEY_PREVIOUS;
});

afterAll(() => {
    if (savedKey === undefined) delete process.env.PLATFORM_ADMIN_API_KEY;
    else process.env.PLATFORM_ADMIN_API_KEY = savedKey;
    if (savedPrevious === undefined) delete process.env.PLATFORM_ADMIN_API_KEY_PREVIOUS;
    else process.env.PLATFORM_ADMIN_API_KEY_PREVIOUS = savedPrevious;
});

describe('GET — who gets the violation buffer', () => {
    it('serves it to a caller holding the platform key', async () => {
        // The positive companion for every refusal below. Without it, a
        // handler that returned 401 unconditionally — or one whose store was
        // simply empty — would satisfy the whole rest of this file.
        const route = loadRoute();
        expect((await route.POST(reportRequest())).status).toBe(204);

        const res = await route.GET(getRequest({ [HEADER]: KEY }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.recentViolations).toHaveLength(1);
        expect(body.recentViolations[0].documentUri).toBe(TENANT_PAGE);
        expect(body.totalReceived).toBe(1);
    });

    it('refuses a caller with no credentials, while the buffer is non-empty', async () => {
        const route = loadRoute();
        await route.POST(reportRequest());

        const res = await route.GET(getRequest());

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body).not.toHaveProperty('recentViolations');
        // The disclosure the issue was actually about: the tenant slug.
        expect(JSON.stringify(body)).not.toContain('acme-holdings');
        expect(JSON.stringify(body)).not.toContain('default-src');

        // …and the refusal was a refusal, not an empty store. Same module
        // instance, same buffer, one working credential apart.
        const served = await route.GET(getRequest({ [HEADER]: KEY }));
        expect(served.status).toBe(200);
        expect((await served.json()).recentViolations).toHaveLength(1);
    });

    it('refuses a wrong key rather than falling open', async () => {
        const route = loadRoute();
        await route.POST(reportRequest());

        const res = await route.GET(getRequest({ [HEADER]: WRONG_KEY }));

        expect(res.status).toBe(401);
        expect(await res.json()).not.toHaveProperty('recentViolations');
    });

    it.each([
        ['a READER session', 'reader'],
        ['an ADMIN session', 'admin'],
        ['an OWNER session', 'owner'],
    ])('refuses %s — a tenant role is not the credential for this surface', async (_label, who) => {
        // These are what an authenticated browser request looks like on the
        // wire. The point is not that the handler inspects the cookie and
        // rejects it — it is that holding ANY tenant role, up to OWNER, gets
        // you nothing here, because the buffer spans every tenant on the
        // process and no tenant role can be senior enough to read another
        // tenant's page URLs. Gating on ADMIN would have narrowed the
        // audience from "the internet" to "any admin of any tenant" and left
        // it a cross-tenant read.
        const route = loadRoute();
        await route.POST(reportRequest());

        const res = await route.GET(
            getRequest({
                cookie: `next-auth.session-token=session-for-${who}`,
                authorization: `Bearer token-for-${who}`,
            }),
        );

        expect(res.status).toBe(401);
        expect(JSON.stringify(await res.json())).not.toContain('acme-holdings');
    });

    it('says "not configured" (503) rather than "wrong key" (401) when the deployment has no key', async () => {
        // Distinct failures, distinct operator actions. Collapsing them sends
        // someone to rotate a credential that was never set.
        delete process.env.PLATFORM_ADMIN_API_KEY;
        const route = loadRoute();
        await route.POST(reportRequest());

        const res = await route.GET(getRequest({ [HEADER]: KEY }));

        expect(res.status).toBe(503);
        expect(await res.json()).not.toHaveProperty('recentViolations');
    });
});

describe('POST — the sink stays open, because a gate there means zero reports', () => {
    it('accepts and stores a report carrying no credentials at all', async () => {
        const route = loadRoute();

        const res = await route.POST(reportRequest('https://app.example/login'));

        expect(res.status).toBe(204);

        // 204 alone proves nothing — the handler returns 204 on an
        // unparseable body, on an unrecognised format, and from its
        // catch-all. Read the store back to show the report actually landed.
        const summary = await route.GET(getRequest({ [HEADER]: KEY }));
        const body = await summary.json();
        expect(body.totalReceived).toBe(1);
        expect(body.totalDropped).toBe(0);
        expect(body.recentViolations[0].documentUri).toBe('https://app.example/login');
        expect(body.recentViolations[0].blockedUri).toBe('https://tracker.example/beacon.js');
    });

    it('is still allowed through the edge gate, key or no key', () => {
        // The other half of "reachable": the handler can only accept a
        // credential-less POST if the middleware lets it past. `isPublicPath`
        // is the predicate `src/middleware.ts` consults before it demands a
        // JWT, so removing this path from the allowlist to "fix" the GET
        // would take every CSP report down with it.
        expect(isPublicPath(PATH)).toBe(true);
        expect(isPublicPath('/api/csp-report')).toBe(true);

        // Not vacuous: the predicate says no to things it should say no to.
        expect(isPublicPath('/api/t/acme-holdings/risks')).toBe(false);
        expect(isPublicPath('/api/security/csp-report-admin')).toBe(false);
    });
});
