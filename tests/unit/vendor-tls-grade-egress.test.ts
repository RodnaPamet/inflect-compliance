/**
 * The vendor monitor's TLS grade requests a tenant-entered domain only through
 * the SSRF guard.
 *
 * Anybody who can edit a vendor types its domain, and the nightly sweep
 * requests `https://<domain>` from inside the deployment. That request went
 * through `fetchWithRetry`, the plain global `fetch`, so a domain naming cloud
 * metadata, a loopback port or a name resolving into private space was
 * requested like any other, and redirects were followed wherever they led.
 *
 * The guard itself is NOT mocked here; only DNS and the transport are. The
 * transport stub sits on `undici`, which is what `safeFetch` calls, and the
 * global `fetch` throws: a request that reached it went around the guard.
 */
const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

const mockTransport = jest.fn<Promise<Response>, [string, Record<string, unknown> | undefined]>();
jest.mock('undici', () => ({
    ...jest.requireActual('undici'),
    fetch: (url: string, init?: Record<string, unknown>) => mockTransport(url, init),
}));

import {
    HOMEPAGE_FETCH_LIMITS,
    HeaderGradeTlsProvider,
    vendorHomepageUrl,
} from '@/app-layer/services/vendor-monitoring/tls-provider';

/** Where each host resolves. A host not listed does not resolve. */
let dns: Record<string, string> = {};

const realFetch = global.fetch;
const globalFetch = jest.fn(async (input: unknown): Promise<Response> => {
    throw new Error(`the global fetch was called for ${String(input)}: a request went around the guard`);
});

beforeAll(() => {
    global.fetch = globalFetch as unknown as typeof fetch;
});

afterAll(() => {
    global.fetch = realFetch;
});

beforeEach(() => {
    dns = {
        'acme.example.com': '93.184.216.34',
        'www.acme.example.com': '93.184.216.35',
        'rebind.example.com': '10.0.0.7',
        'internal.example.com': '169.254.169.254',
    };
    mockLookup.mockReset();
    mockLookup.mockImplementation(async (host: string) => {
        const address = dns[host];
        if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        return [{ address, family: 4 }];
    });
    mockTransport.mockReset();
    globalFetch.mockClear();
});

const ALL_HEADERS = {
    'strict-transport-security': 'max-age=63072000',
    'content-security-policy': "default-src 'self'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=()',
};

const page = (headers: Record<string, string> = ALL_HEADERS, status = 200) =>
    new Response('<html></html>', { status, headers });
const redirect = (location: string, status = 301) =>
    new Response(null, { status, headers: { location } });

/** No real waiting between retries. */
const provider = () => new HeaderGradeTlsProvider({ retryDelayMs: 0 });

/** The URLs the transport was asked for, in order. */
const requested = () => mockTransport.mock.calls.map(([url]) => url);

describe('vendorHomepageUrl — a vendor domain is a bare host name or nothing', () => {
    it('builds the https homepage URL from a host name', () => {
        expect(vendorHomepageUrl('acme.example.com')).toBe('https://acme.example.com/');
        expect(vendorHomepageUrl('  ACME.Example.com ')).toBe('https://acme.example.com/');
    });

    it('refuses a value that would let the tenant shape the request', () => {
        for (const value of [
            '',
            '   ',
            'acme.example.com:6379',
            'user@acme.example.com',
            'acme.example.com@169.254.169.254',
            'acme.example.com/admin',
            'acme.example.com?x=1',
            'acme.example.com#frag',
            'https://acme.example.com',
            'acme example.com',
            'acme.example.com%2f..',
            '[::1]',
        ]) {
            expect({ value, url: vendorHomepageUrl(value) }).toEqual({ value, url: null });
        }
    });
});

describe('HeaderGradeTlsProvider — every request is a safeFetch', () => {
    it('grades a public homepage, requested with redirects off and the pinned dispatcher', async () => {
        mockTransport.mockResolvedValueOnce(page());

        const signal = await provider().grade('acme.example.com');

        expect(signal.grade).toBe('A');
        expect(requested()).toEqual(['https://acme.example.com/']);
        const init = mockTransport.mock.calls[0][1]!;
        expect(init.redirect).toBe('manual');
        expect(init.dispatcher).toBeDefined();
        expect(init.method).toBe('GET');
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('refuses a literal private or metadata address before resolving or requesting it', async () => {
        for (const domain of ['169.254.169.254', '10.0.0.1', '127.0.0.1', 'localhost', 'metadata.google.internal']) {
            const signal = await provider().grade(domain);
            expect({ domain, grade: signal.grade }).toEqual({ domain, grade: null });
        }
        expect(mockLookup).not.toHaveBeenCalled();
        expect(mockTransport).not.toHaveBeenCalled();
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('refuses a public name that resolves into private space, before any request', async () => {
        const signal = await provider().grade('rebind.example.com');

        expect(signal.grade).toBeNull();
        expect(mockLookup).toHaveBeenCalledWith('rebind.example.com', expect.anything());
        expect(mockTransport).not.toHaveBeenCalled();
    });

    it('leaves an unresolvable domain ungraded without requesting anything', async () => {
        const signal = await provider().grade('nowhere.example.com');

        expect(signal.grade).toBeNull();
        expect(mockTransport).not.toHaveBeenCalled();
    });
});

describe('HeaderGradeTlsProvider — redirects are followed one checked hop at a time', () => {
    it('follows a public redirect and grades the page it lands on, resolving each hop afresh', async () => {
        mockTransport
            .mockResolvedValueOnce(redirect('https://www.acme.example.com/'))
            .mockResolvedValueOnce(page({ 'strict-transport-security': 'max-age=1' }));

        const signal = await provider().grade('acme.example.com');

        expect(requested()).toEqual(['https://acme.example.com/', 'https://www.acme.example.com/']);
        expect(mockLookup.mock.calls.map(([host]) => host)).toEqual(['acme.example.com', 'www.acme.example.com']);
        expect(signal.presentHeaders).toEqual(['strict-transport-security']);
        expect(signal.grade).not.toBeNull();
    });

    it('resolves a relative Location against the URL that answered', async () => {
        mockTransport
            .mockResolvedValueOnce(redirect('/en/'))
            .mockResolvedValueOnce(page());

        await provider().grade('acme.example.com');

        expect(requested()).toEqual(['https://acme.example.com/', 'https://acme.example.com/en/']);
    });

    it('does not follow a redirect to cloud metadata over http', async () => {
        mockTransport.mockResolvedValueOnce(redirect('http://169.254.169.254/latest/meta-data/'));

        const signal = await provider().grade('acme.example.com');

        expect(signal.grade).toBeNull();
        expect(requested()).toEqual(['https://acme.example.com/']);
    });

    it('does not follow a redirect to a public name that resolves to metadata', async () => {
        mockTransport.mockResolvedValueOnce(redirect('https://internal.example.com/'));

        const signal = await provider().grade('acme.example.com');

        expect(signal.grade).toBeNull();
        expect(requested()).toEqual(['https://acme.example.com/']);
        expect(mockLookup.mock.calls.map(([host]) => host)).toEqual(['acme.example.com', 'internal.example.com']);
    });

    it('gives up after the redirect limit rather than following a loop', async () => {
        mockTransport.mockImplementation(async () => redirect('https://acme.example.com/'));

        const signal = await provider().grade('acme.example.com');

        expect(signal.grade).toBeNull();
        expect(mockTransport).toHaveBeenCalledTimes(HOMEPAGE_FETCH_LIMITS.maxRedirects + 1);
    });

    it('gives up on a redirect with no Location', async () => {
        mockTransport.mockResolvedValueOnce(new Response(null, { status: 302 }));

        const signal = await provider().grade('acme.example.com');

        expect(signal.grade).toBeNull();
        expect(mockTransport).toHaveBeenCalledTimes(1);
    });
});

describe('HeaderGradeTlsProvider — what is retried', () => {
    it('retries a 5xx once and grades the second answer', async () => {
        mockTransport
            .mockResolvedValueOnce(page({}, 503))
            .mockResolvedValueOnce(page());

        const signal = await provider().grade('acme.example.com');

        expect(signal.grade).toBe('A');
        expect(mockTransport).toHaveBeenCalledTimes(2);
    });

    it('retries a network failure once', async () => {
        mockTransport
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(page());

        const signal = await provider().grade('acme.example.com');

        expect(signal.grade).toBe('A');
        expect(mockTransport).toHaveBeenCalledTimes(2);
    });

    it('stops at the attempt limit and leaves the vendor ungraded', async () => {
        mockTransport.mockImplementation(async () => page({}, 503));

        const signal = await provider().grade('acme.example.com');

        expect(signal.grade).toBeNull();
        expect(mockTransport).toHaveBeenCalledTimes(HOMEPAGE_FETCH_LIMITS.maxAttempts);
    });

    it('does not retry a refusal', async () => {
        mockTransport.mockResolvedValueOnce(page({}, 403));

        const signal = await provider().grade('acme.example.com');

        expect(signal.grade).toBeNull();
        expect(mockTransport).toHaveBeenCalledTimes(1);
    });

    it('bounds every request with a timeout signal', async () => {
        mockTransport.mockResolvedValueOnce(page());

        await provider().grade('acme.example.com');

        const init = mockTransport.mock.calls[0][1]!;
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });
});
