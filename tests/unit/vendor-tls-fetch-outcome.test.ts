/**
 * A TLS-grade fetch that does not grade says why: it is recorded as REFUSED,
 * UNREACHABLE or BLOCKED, never read as "no change".
 *
 * Every non-2xx outcome used to come back as `grade: null`, which the sweep
 * read as "nothing observed", so a vendor site that began refusing the monitor
 * kept its old grade and looked current. The outcome is what lets the monitor
 * mark that grade stale, and the REFUSED share before signing is the baseline
 * Web Bot Auth Phase 2 is measured against.
 *
 * As in the egress suite, the SSRF guard is real; only DNS and the transport
 * under `safeFetch` are stubbed.
 */
const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

const mockTransport = jest.fn<Promise<Response>, [string, Record<string, unknown> | undefined]>();
// Since Web Bot Auth Phase 2 each origin's robots.txt is read before its
// homepage. It answers 404 here ("unavailable": restricts nothing), so this
// suite counts homepage requests only; robots.txt has its own suite
// (vendor-tls-robots.test.ts).
const mockRobots = jest.fn(async (_url: string) => new Response(null, { status: 404 }));
jest.mock('undici', () => ({
    ...jest.requireActual('undici'),
    fetch: (url: string, init?: Record<string, unknown>) =>
        new URL(url).pathname === '/robots.txt' ? mockRobots(url) : mockTransport(url, init),
}));

import {
    HOMEPAGE_FETCH_LIMITS,
    HeaderGradeTlsProvider,
    TestModeTlsProvider,
    recognisedChallenge,
} from '@/app-layer/services/vendor-monitoring/tls-provider';

const DNS: Record<string, string> = {
    'acme.example.com': '93.184.216.34',
    'internal.example.com': '169.254.169.254',
};

beforeEach(() => {
    mockLookup.mockReset();
    mockLookup.mockImplementation(async (host: string) => {
        const address = DNS[host];
        if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        return [{ address, family: 4 }];
    });
    mockTransport.mockReset();
});

const ALL_HEADERS = {
    'strict-transport-security': 'max-age=63072000',
    'content-security-policy': "default-src 'self'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=()',
};

const answer = (status: number, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : 'body', { status, headers });

const grade = (domain = 'acme.example.com') => new HeaderGradeTlsProvider({ retryDelayMs: 0 }).grade(domain);

/** The outcome and grade together: the pair the sweep reads. */
const verdict = async (domain?: string) => {
    const s = await grade(domain);
    return { outcome: s.outcome, grade: s.grade };
};

describe('a site that answers and declines is REFUSED, not ungraded', () => {
    it('records a 403 as REFUSED and does not retry it', async () => {
        mockTransport.mockResolvedValueOnce(answer(403));

        expect(await verdict()).toEqual({ outcome: 'REFUSED', grade: null });
        expect(mockTransport).toHaveBeenCalledTimes(1);
    });

    it('records a 429 that outlasted the retry as REFUSED', async () => {
        mockTransport.mockImplementation(async () => answer(429));

        expect(await verdict()).toEqual({ outcome: 'REFUSED', grade: null });
        expect(mockTransport).toHaveBeenCalledTimes(HOMEPAGE_FETCH_LIMITS.maxAttempts);
    });

    it('grades a 429 that the retry got past', async () => {
        mockTransport.mockResolvedValueOnce(answer(429)).mockResolvedValueOnce(answer(200, ALL_HEADERS));

        expect(await verdict()).toEqual({ outcome: 'GRADED', grade: 'A' });
    });

    it('records a Cloudflare challenge on a 503 as REFUSED, not as an outage, and does not retry it', async () => {
        mockTransport.mockResolvedValueOnce(answer(503, { 'cf-mitigated': 'challenge' }));

        expect(await verdict()).toEqual({ outcome: 'REFUSED', grade: null });
        expect(mockTransport).toHaveBeenCalledTimes(1);
    });

    it('never grades a challenge page that rides on a 2xx', async () => {
        // AWS WAF answers a challenge with a 202. Graded, its headers would be
        // reported as the vendor's homepage posture.
        mockTransport.mockResolvedValueOnce(answer(202, { ...ALL_HEADERS, 'x-amzn-waf-action': 'challenge' }));

        expect(await verdict()).toEqual({ outcome: 'REFUSED', grade: null });
    });

    it('records any other 4xx as REFUSED', async () => {
        mockTransport.mockResolvedValueOnce(answer(404));

        expect(await verdict()).toEqual({ outcome: 'REFUSED', grade: null });
    });
});

describe('recognisedChallenge reads only documented challenge markers', () => {
    it('names Cloudflare and AWS WAF challenges, in any case', () => {
        expect(recognisedChallenge(new Headers({ 'cf-mitigated': 'Challenge' }))).toBe('cloudflare');
        expect(recognisedChallenge(new Headers({ 'x-amzn-waf-action': 'captcha' }))).toBe('aws-waf');
        expect(recognisedChallenge(new Headers({ 'x-amzn-waf-action': 'challenge' }))).toBe('aws-waf');
    });

    it('does not take an ordinary CDN header for a challenge', () => {
        expect(recognisedChallenge(new Headers({ 'cf-ray': '8a1b2c3d4e5f-AMS', server: 'cloudflare' }))).toBeNull();
        expect(recognisedChallenge(new Headers({ 'x-amzn-waf-action': 'allow' }))).toBeNull();
    });
});

describe('no answer to grade is UNREACHABLE', () => {
    it('records a network failure that outlasted the retry as UNREACHABLE', async () => {
        mockTransport.mockRejectedValue(new TypeError('fetch failed'));

        expect(await verdict()).toEqual({ outcome: 'UNREACHABLE', grade: null });
        expect(mockTransport).toHaveBeenCalledTimes(HOMEPAGE_FETCH_LIMITS.maxAttempts);
    });

    it('records a 5xx that outlasted the retry as UNREACHABLE', async () => {
        mockTransport.mockImplementation(async () => answer(502));

        expect(await verdict()).toEqual({ outcome: 'UNREACHABLE', grade: null });
    });

    it('records a name that does not resolve as UNREACHABLE, not BLOCKED', async () => {
        // DNS saying nothing may be a resolver's bad night; it is not the
        // guard's decision about the destination.
        expect(await verdict('nowhere.example.com')).toEqual({ outcome: 'UNREACHABLE', grade: null });
        expect(mockTransport).not.toHaveBeenCalled();
    });

    it('records a redirect loop as UNREACHABLE', async () => {
        mockTransport.mockImplementation(async () => answer(301, { location: 'https://acme.example.com/' }));

        expect(await verdict()).toEqual({ outcome: 'UNREACHABLE', grade: null });
    });
});

describe('a destination nobody may request is BLOCKED', () => {
    it('records a value that is not a bare host name as BLOCKED, requesting nothing', async () => {
        expect(await verdict('acme.example.com/admin')).toEqual({ outcome: 'BLOCKED', grade: null });
        expect(mockLookup).not.toHaveBeenCalled();
        expect(mockTransport).not.toHaveBeenCalled();
    });

    it('records a private or metadata address as BLOCKED', async () => {
        expect(await verdict('169.254.169.254')).toEqual({ outcome: 'BLOCKED', grade: null });
        expect(await verdict('internal.example.com')).toEqual({ outcome: 'BLOCKED', grade: null });
        expect(mockTransport).not.toHaveBeenCalled();
    });

    it('records a redirect to an address the guard refuses as BLOCKED', async () => {
        mockTransport.mockResolvedValueOnce(answer(302, { location: 'http://169.254.169.254/latest/meta-data/' }));

        expect(await verdict()).toEqual({ outcome: 'BLOCKED', grade: null });
        expect(mockTransport).toHaveBeenCalledTimes(1);
    });
});

describe('a graded fetch says GRADED', () => {
    it('reports GRADED beside the grade, from the real provider and the stub', async () => {
        mockTransport.mockResolvedValueOnce(answer(200, ALL_HEADERS));

        expect(await verdict()).toEqual({ outcome: 'GRADED', grade: 'A' });
        const stub = await new TestModeTlsProvider().grade('acme.example.com');
        expect(stub.outcome).toBe('GRADED');
        expect(stub.grade).not.toBeNull();
    });
});
