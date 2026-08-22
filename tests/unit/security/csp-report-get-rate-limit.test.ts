/**
 * `GET /api/security/csp-report` is gated on `PLATFORM_ADMIN_API_KEY` (#2103)
 * and was, until this change, gated on nothing else. It is on
 * `MACHINE_CALLER_PREFIXES`, so `src/middleware.ts` early-returned
 * `NextResponse.next()` for the whole path before any check ran;
 * `checkReportRateLimit` lives inside the POST handler only; and
 * `isApiReadRateLimited` answers false for anything outside `/api/t/`. Three
 * limiters, none of them on this path. Measured: 500 consecutive wrong-key
 * GETs, 500 × 401, zero 429.
 *
 * The key is 32+ characters compared in constant time, so this is not about
 * re-closing the disclosure — it is about the cost of an unbounded number of
 * free attempts. What the edge block has to get right is which METHOD it
 * covers, because the two on this path have opposite requirements:
 *
 *   GET  — an operator reading a debug view, single digits per minute.
 *   POST — a browser beacon with no credentials, whose reports are lost
 *          silently if it is ever throttled by an attacker's traffic.
 *
 * So every throttling assertion below is paired with the companion that
 * proves the code got as far as deciding — a request under the budget that
 * still passes, a second IP that is unaffected, a POST that sails past the
 * exhausted GET budget — and the POST's own in-handler limiter is pinned at
 * its existing 30/IP/min so a later "unify the limiters" pass cannot quietly
 * move it.
 *
 * The limiter is NOT mocked here. A mocked limiter is satisfied whether or
 * not the middleware consults it, which is the property under test.
 */

// The enforcement module resolves `RATE_LIMIT_MODE` lazily on first check and
// caches the decision, so memory mode has to be pinned before the module
// graph loads. The three bypass gates are cleared for the same reason: with
// any of them set the limiter returns `{ ok: true }` and every assertion here
// would pass against a limiter that never ran.
const SAVED_ENV = {
    RATE_LIMIT_MODE: process.env.RATE_LIMIT_MODE,
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
    AUTH_TEST_MODE: process.env.AUTH_TEST_MODE,
    NEXT_TEST_MODE: process.env.NEXT_TEST_MODE,
    PLATFORM_ADMIN_API_KEY: process.env.PLATFORM_ADMIN_API_KEY,
};
process.env.RATE_LIMIT_MODE = 'memory';
delete process.env.RATE_LIMIT_ENABLED;
delete process.env.AUTH_TEST_MODE;
delete process.env.NEXT_TEST_MODE;

import { NextRequest } from 'next/server';

jest.mock('next-auth/jwt', () => ({
    // No session cookie: an operator calls this with a header key, and a
    // browser posting a report has no credentials at all. Neither reaches
    // `getToken` — both are decided above it — but the middleware imports it
    // unconditionally, so the mock keeps the module graph off the real JWT
    // verifier.
    getToken: jest.fn(async (_args: unknown) => null),
}));

import middleware from '@/middleware';
import { _clearApiReadRateLimitMemory } from '@/lib/rate-limit/apiReadRateLimit';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { CSP_REPORT_PATH, LEGACY_CSP_REPORT_PATH } from '@/lib/security/csp';

const HEADER = 'x-platform-admin-key';
const KEY = 'k'.repeat(40);
const BUDGET = API_READ_LIMIT.maxAttempts;
const TENANT_PAGE = 'https://app.example/t/acme-holdings/risks/r-17';

function operatorGet(
    ip: string,
    headers: Record<string, string> = { [HEADER]: KEY },
    path = CSP_REPORT_PATH,
    method = 'GET',
): NextRequest {
    return new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-forwarded-for': ip, ...headers },
    });
}

/** A browser's CSP violation report: no cookie, no key, no bearer token. */
function browserPost(ip: string, path = CSP_REPORT_PATH): NextRequest {
    return new NextRequest(`http://localhost${path}`, {
        method: 'POST',
        headers: {
            'x-forwarded-for': ip,
            'content-type': 'application/csp-report',
        },
        body: JSON.stringify({
            'csp-report': {
                'document-uri': TENANT_PAGE,
                'violated-directive': 'script-src',
                'blocked-uri': 'https://tracker.example/beacon.js',
                'original-policy': "default-src 'self'",
                'source-file': 'https://app.example/_next/static/chunks/main.js',
            },
        }),
    });
}

/** The default operator GET fixture: correct key, one IP. */
function middlewareReq(
    ip: string,
    headers: Record<string, string> = { [HEADER]: KEY },
): NextRequest {
    return operatorGet(ip, headers);
}

/** Drive the edge `n` times from one IP and return the last response. */
async function drain(n: number, make: (i: number) => NextRequest) {
    let last = await middleware(make(0));
    for (let i = 1; i < n; i++) {
        last = await middleware(make(i));
    }
    return last;
}

beforeEach(() => {
    _clearApiReadRateLimitMemory();
    process.env.PLATFORM_ADMIN_API_KEY = KEY;
});

afterAll(() => {
    for (const [name, value] of Object.entries(SAVED_ENV)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    _clearApiReadRateLimitMemory();
});

describe('the operator GET is metered at the edge', () => {
    it('passes requests up to the budget and refuses the one after it', async () => {
        const ip = '198.51.100.7';

        // The positive companion, and the whole reason the budget is 120
        // rather than something tight: an operator refreshing a debug view
        // never reaches it. Assert the LAST allowed request specifically —
        // an off-by-one that throttles at 119 is the regression that would
        // start dropping legitimate calls.
        const allowed = await drain(BUDGET, () => middlewareReq(ip));
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get('location')).toBeNull();

        const blocked = await middleware(middlewareReq(ip));
        expect(blocked.status).toBe(429);
    });

    it('stamps the 429 with the retry + budget headers a client can act on', async () => {
        const ip = '198.51.100.8';
        await drain(BUDGET, () => middlewareReq(ip));

        const blocked = await middleware(middlewareReq(ip));

        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);
        expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(blocked.headers.get('x-ratelimit-limit')).toBe(String(BUDGET));
        expect(blocked.headers.get('x-ratelimit-remaining')).toBe('0');
        expect(blocked.headers.get('x-ratelimit-reset')).toMatch(/^\d+$/);
        // The middleware's own correlation header survives the short-circuit,
        // which is how an operator ties a 429 back to a log line.
        expect(blocked.headers.get('x-request-id')).toBeTruthy();
    });

    it('the 429 body carries the rate-limit envelope and nothing else', async () => {
        const ip = '198.51.100.9';
        const req = middlewareReq(ip);
        // The search terms below are only meaningful if they were in the
        // request to begin with.
        expect(req.headers.get(HEADER)).toBe(KEY);
        expect(req.headers.get('x-forwarded-for')).toBe(ip);

        await drain(BUDGET, () => middlewareReq(ip));
        const blocked = await middleware(req);

        expect(blocked.status).toBe(429);
        const raw = await blocked.text();
        expect(raw).not.toContain(KEY);
        expect(raw).not.toContain(ip);
        // No violation data can reach here — the edge never opens the ring
        // buffer — so assert the shape exhaustively rather than guessing at
        // field names: anything added to this body later has to be looked at.
        const body = JSON.parse(raw);
        expect(Object.keys(body)).toEqual(['error']);
        expect(Object.keys(body.error).sort()).toEqual([
            'code',
            'message',
            'retryAfterSeconds',
            'scope',
        ]);
        expect(body.error.code).toBe('RATE_LIMITED');
    });

    it('meters HEAD as well, since Next runs the GET handler for it', async () => {
        const ip = '198.51.100.10';
        const head = () => operatorGet(ip, { [HEADER]: KEY }, CSP_REPORT_PATH, 'HEAD');

        const allowed = await drain(BUDGET, head);
        expect(allowed.status).toBe(200);

        expect((await middleware(head())).status).toBe(429);
    });

    it('meters the legacy alias on the same allowlist entry', async () => {
        const ip = '198.51.100.11';
        const legacy = () => operatorGet(ip, { [HEADER]: KEY }, LEGACY_CSP_REPORT_PATH);

        const allowed = await drain(BUDGET, legacy);
        expect(allowed.status).toBe(200);

        expect((await middleware(legacy())).status).toBe(429);
    });
});

describe('what the bucket is keyed on', () => {
    it('is per-IP — an exhausted caller cannot starve anyone else', async () => {
        const attacker = '203.0.113.5';
        await drain(BUDGET, () => middlewareReq(attacker));
        expect((await middleware(middlewareReq(attacker))).status).toBe(429);

        // The companion that turns the assertion above from "the endpoint is
        // down" into "that caller is out of budget".
        const operator = await middleware(middlewareReq('198.51.100.20'));
        expect(operator.status).toBe(200);
    });

    it('is NOT keyed on the presented key — rotating it buys no fresh budget', async () => {
        // The device-report precedent (middleware section 0c) keys by the
        // bearer token, because a device token is issued and the concern is
        // fairness behind a NAT. Here the credential is the thing an attacker
        // varies, so keying by it would reset the counter on every guess.
        const ip = '203.0.113.9';
        const distinctWrongKey = (i: number) =>
            middlewareReq(ip, { [HEADER]: `w${String(i).padStart(39, '0')}` });

        const allowed = await drain(BUDGET, distinctWrongKey);
        expect(allowed.status).toBe(200);

        const blocked = await middleware(distinctWrongKey(BUDGET));
        expect(blocked.status).toBe(429);
    });
});

describe('the browser POST is untouched', () => {
    it('is not metered at the edge, at any volume', async () => {
        // Four times the GET budget from a single IP. A limiter that covered
        // both methods would have 429'd at 121 and silently lost every report
        // after it.
        const ip = '192.0.2.44';
        for (let i = 0; i < BUDGET * 4; i++) {
            const res = await middleware(browserPost(ip));
            if (res.status === 429) {
                throw new Error(`edge throttled the CSP report POST at attempt ${i + 1}`);
            }
        }
        // Positive companion: the same IP IS metered on the GET, so the run
        // above passed because of the method check and not because the
        // limiter was inert for this whole test.
        await drain(BUDGET, () => middlewareReq(ip));
        expect((await middleware(middlewareReq(ip))).status).toBe(429);
    });

    it('still reaches the handler after the same IP has exhausted the GET budget', async () => {
        const ip = '192.0.2.55';
        await drain(BUDGET, () => middlewareReq(ip));
        expect((await middleware(middlewareReq(ip))).status).toBe(429);

        // The buckets do not overlap: a broken page reporting from an office
        // whose NAT also hosts whoever burned the GET budget keeps reporting.
        const post = await middleware(browserPost(ip));
        expect(post.status).toBe(200);
        expect(post.headers.get('location')).toBeNull();
    });
});

describe("the POST's own in-handler limiter is unchanged", () => {
    type RouteModule = typeof import('@/app/api/security/csp-report/route');

    function loadRoute(): RouteModule {
        // A fresh module registry per load gives each test its own ring
        // buffer AND its own report-limiter Map, so one test's 30 reports
        // cannot spend another's budget.
        let mod: RouteModule | undefined;
        jest.isolateModules(() => {
            mod = require('@/app/api/security/csp-report/route') as RouteModule;
        });
        if (!mod) throw new Error('csp-report route failed to load');
        return mod;
    }

    function report(ip: string): NextRequest {
        return browserPost(ip);
    }

    async function drainPosts(route: RouteModule, ip: string, n: number): Promise<void> {
        for (let i = 0; i < n; i++) {
            await route.POST(report(ip));
        }
    }

    function summaryRequest(): NextRequest {
        return new NextRequest(`http://localhost${CSP_REPORT_PATH}`, {
            method: 'GET',
            headers: { [HEADER]: KEY },
        });
    }

    it('still accepts 30 reports per IP per minute and drops the 31st', async () => {
        const route = loadRoute();
        const ip = '192.0.2.77';

        for (let i = 0; i < 30; i++) {
            expect((await route.POST(report(ip))).status).toBe(204);
        }

        expect((await route.POST(report(ip))).status).toBe(429);

        // 204 is also what an unparseable body and the catch-all return, so
        // read the store back: 30 landed, exactly one was dropped.
        const summary = await (await route.GET(summaryRequest())).json();
        expect(summary.totalReceived).toBe(30);
        expect(summary.totalDropped).toBe(1);
    });

    it('keys that limiter per IP, so one noisy client does not mute another', async () => {
        const route = loadRoute();
        await drainPosts(route, '192.0.2.88', 31);

        // A different office, first report of the window.
        expect((await route.POST(report('192.0.2.99'))).status).toBe(204);
    });
});
