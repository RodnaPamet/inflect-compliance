/**
 * Web Bot Auth Phase 2 — the vendor monitor honours robots.txt, and every
 * request it sends is the deployment's bot (D-L1-6).
 *
 * Invariants:
 *   - a robots.txt that disallows the monitor's token is REFUSED with reason
 *     ROBOTS, and the homepage is never requested;
 *   - a missing or "unavailable" (4xx) robots.txt restricts nothing; an
 *     "unreachable" one (5xx, network failure) requests nothing (RFC 9309
 *     §2.3.1.4) and is UNREACHABLE; a challenge on it is REFUSED;
 *   - a redirect to another origin has that origin's robots.txt read too;
 *   - with a key configured, every request — robots.txt and homepage — is
 *     signed and carries the bot's User-Agent; without one, none is signed.
 *
 * The SSRF guard is real; only DNS and the transport under `safeFetch` are stubbed.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

const mockTransport = jest.fn<Promise<Response>, [string, Record<string, unknown> | undefined]>();
jest.mock('undici', () => ({
    ...jest.requireActual('undici'),
    fetch: (url: string, init?: Record<string, unknown>) => mockTransport(url, init),
}));

import { HeaderGradeTlsProvider } from '@/app-layer/services/vendor-monitoring/tls-provider';
import { resetDeploymentBotSignerForTests, VENDOR_MONITOR_BOT_TOKEN } from '@/lib/web-bot-auth/bot-fetch';

// Fixture seed, not a credential.
const SEED = '4f3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e'; // pragma: allowlist secret

const DNS: Record<string, string> = { 'acme.example.com': '93.184.216.34', 'www.acme.example.com': '93.184.216.35' };

const ALL_HEADERS = {
    'strict-transport-security': 'max-age=63072000',
    'content-security-policy': "default-src 'self'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=()',
};

type Route = (url: string) => Response | Promise<Response>;
let routes: Record<string, Route>;

function configure(signing: boolean) {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    Object.assign(mockEnv, {
        NODE_ENV: 'production',
        APP_URL: 'https://app.inflect.example',
        DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
        ...(signing ? { WEB_BOT_AUTH_SIGNING_KEY: SEED } : {}),
    });
    resetDeploymentBotSignerForTests();
}

beforeEach(() => {
    configure(false);
    mockLookup.mockReset();
    mockLookup.mockImplementation(async (host: string) => {
        const address = DNS[host];
        if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        return [{ address, family: 4 }];
    });
    routes = {
        'https://acme.example.com/robots.txt': () => new Response(null, { status: 404 }),
        'https://acme.example.com/': () => new Response('home', { status: 200, headers: ALL_HEADERS }),
    };
    mockTransport.mockReset();
    mockTransport.mockImplementation(async (url: string) => {
        const route = routes[url];
        if (!route) throw new Error(`unexpected request to ${url}`);
        return route(url);
    });
});

const grade = () => new HeaderGradeTlsProvider({ retryDelayMs: 0 }).grade('acme.example.com');
const requested = () => mockTransport.mock.calls.map((c) => c[0]);
const headersOf = (i: number) => (mockTransport.mock.calls[i][1]?.headers ?? {}) as Record<string, string>;
const robots = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });

describe('a robots.txt that disallows the monitor is honoured', () => {
    it('records REFUSED with reason ROBOTS and never requests the homepage', async () => {
        routes['https://acme.example.com/robots.txt'] = robots(`User-agent: ${VENDOR_MONITOR_BOT_TOKEN}\nDisallow: /\n`);
        const s = await grade();
        expect(s).toMatchObject({ outcome: 'REFUSED', refusalReason: 'ROBOTS', grade: null });
        expect(requested()).toEqual(['https://acme.example.com/robots.txt']);
    });

    it('honours a `*` disallow when no group names the monitor', async () => {
        routes['https://acme.example.com/robots.txt'] = robots('User-agent: *\nDisallow: /\n');
        expect((await grade()).refusalReason).toBe('ROBOTS');
    });

    it('grades as before when robots.txt allows the homepage', async () => {
        routes['https://acme.example.com/robots.txt'] = robots('User-agent: *\nDisallow: /private\n');
        const s = await grade();
        expect(s.outcome).toBe('GRADED');
        expect(s.refusalReason).toBeUndefined();
        expect(requested()).toEqual(['https://acme.example.com/robots.txt', 'https://acme.example.com/']);
    });
});

describe('a robots.txt that cannot be read is judged by RFC 9309', () => {
    it('a 404 restricts nothing', async () => {
        expect((await grade()).outcome).toBe('GRADED');
    });

    it('a 5xx means complete disallow: UNREACHABLE, homepage not requested', async () => {
        routes['https://acme.example.com/robots.txt'] = () => new Response(null, { status: 503 });
        expect((await grade()).outcome).toBe('UNREACHABLE');
        expect(requested()).toEqual(['https://acme.example.com/robots.txt']);
    });

    it('a network failure means complete disallow too', async () => {
        routes['https://acme.example.com/robots.txt'] = () => {
            throw new TypeError('fetch failed');
        };
        expect((await grade()).outcome).toBe('UNREACHABLE');
        expect(requested()).toEqual(['https://acme.example.com/robots.txt']);
    });

    it('a challenge on robots.txt is REFUSED, not ROBOTS', async () => {
        routes['https://acme.example.com/robots.txt'] = () => new Response(null, { status: 403, headers: { 'cf-mitigated': 'challenge' } });
        const s = await grade();
        expect(s.outcome).toBe('REFUSED');
        expect(s.refusalReason).toBeUndefined();
    });
});

describe('a redirect to another origin has that origin judged by its own robots.txt', () => {
    it('reads the target origin robots.txt before following the redirect', async () => {
        routes['https://acme.example.com/'] = () => new Response(null, { status: 301, headers: { location: 'https://www.acme.example.com/' } });
        routes['https://www.acme.example.com/robots.txt'] = robots('User-agent: *\nDisallow: /\n');
        const s = await grade();
        expect(s.refusalReason).toBe('ROBOTS');
        expect(requested()).toEqual([
            'https://acme.example.com/robots.txt',
            'https://acme.example.com/',
            'https://www.acme.example.com/robots.txt',
        ]);
    });
});

describe('every request is the deployment bot', () => {
    it('signs robots.txt and the homepage, each on its own, when a key is configured', async () => {
        configure(true);
        await grade();
        expect(requested()).toHaveLength(2);
        for (const i of [0, 1]) {
            expect(headersOf(i)['User-Agent']).toMatch(new RegExp(`^${VENDOR_MONITOR_BOT_TOKEN}/`));
            expect(headersOf(i)['Signature-Input']).toContain('tag="web-bot-auth"');
            expect(headersOf(i)['Signature-Agent']).toBe('"https://app.inflect.example/.well-known/http-message-signatures-directory"');
        }
        expect(headersOf(0).Signature).not.toBe(headersOf(1).Signature);
    });

    it('signs nothing, and still grades, when no key is configured', async () => {
        const s = await grade();
        expect(s.outcome).toBe('GRADED');
        for (const i of [0, 1]) {
            expect(headersOf(i)).not.toHaveProperty('Signature');
            expect(headersOf(i)['User-Agent']).toMatch(new RegExp(`^${VENDOR_MONITOR_BOT_TOKEN}/`));
        }
    });
});
