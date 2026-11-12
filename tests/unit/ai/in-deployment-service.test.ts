/**
 * The in-deployment service rule (`src/lib/ai/in-deployment-service.ts`, G6 as
 * amended by the owner 2026-11-12): an address INSIDE the deployment — RFC
 * 1918, loopback, IPv6 unique-local — and nothing else, judged on every
 * address a name resolves to; and the ONE dial that reaches such a service,
 * pinned, deadline-bounded, byte-capped, following no redirect.
 *
 * This is the inverse of `safeFetch`'s public-address policy. The Docling
 * parser, the NeMo guard provider and the TEI embedder and reranker are held
 * to it; the residency claim it protects is that a tenant's text never reaches
 * an address outside the deployment through one of them.
 *
 * The network is mocked where the module reaches it — `undici`'s fetch and
 * Agent, and `node:dns` — never injected: the dial has no fetch seam.
 */
const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

const mockFetch = jest.fn<Promise<Response>, [string, (RequestInit & { dispatcher?: unknown }) | undefined]>();
const mockAgentOptions = jest.fn();
jest.mock('undici', () => ({
    Agent: class {
        constructor(opts: unknown) {
            mockAgentOptions(opts);
        }
    },
    fetch: (url: string, init?: RequestInit) => mockFetch(url, init),
}));

import {
    IN_DEPLOYMENT_SERVICES,
    checkPerimeterUrl,
    inDeploymentRequest,
    isPerimeterAddress,
    resolvePerimeterAddresses,
} from '@/lib/ai/in-deployment-service';

beforeEach(() => {
    mockLookup.mockReset();
    mockFetch.mockReset();
    mockAgentOptions.mockReset();
});

describe('isPerimeterAddress — inside means the deployment, not merely "private"', () => {
    it.each([
        '10.0.0.1',
        '10.255.255.255',
        '172.16.0.1',
        '172.31.255.254',
        '192.168.1.1',
        '127.0.0.1',
        '127.8.9.10',
        '::1',
        '[::1]',
        'fd00::5',
        'fc12:3456::1',
        '::ffff:10.0.0.1',
        '::ffff:a00:1',
    ])('%s is inside', (address) => {
        expect(isPerimeterAddress(address)).toBe(true);
    });

    it.each([
        ['public IPv4', '93.184.216.34'],
        ['public IPv6', '2606:4700::1111'],
        ['cloud metadata (link-local)', '169.254.169.254'],
        ['IPv6 link-local', 'fe80::1'],
        ['CGNAT', '100.64.0.1'],
        ['this-network', '0.0.0.0'],
        ['the unspecified IPv6 address', '::'],
        ['just past 172.16/12', '172.32.0.1'],
        ['just before 172.16/12', '172.15.255.255'],
        ['a v4-mapped public address', '::ffff:8.8.8.8'],
        ['a v4-mapped metadata address in hex', '::ffff:a9fe:a9fe'],
        ['a hostname, which is judged by what it resolves to', 'tei-embed'],
    ])('%s (%s) is outside', (_label, address) => {
        expect(isPerimeterAddress(address)).toBe(false);
    });
});

describe('checkPerimeterUrl — the structural half, asked when a route is chosen', () => {
    it('a hostname passes structurally and is left to the resolution', () => {
        expect(checkPerimeterUrl('http://tei-embed:8080')).toEqual({ ok: true, host: 'tei-embed' });
    });

    it('a trailing-dot metadata name is still the metadata name', () => {
        expect(checkPerimeterUrl('http://metadata.google.internal./')).toEqual({ ok: false, reason: 'METADATA_HOST' });
    });

    it('the URL parser normalises an obfuscated literal before it is judged', () => {
        // 0xa9.0xfe.0xa9.0xfe is 169.254.169.254.
        expect(checkPerimeterUrl('http://0xa9.0xfe.0xa9.0xfe/')).toEqual({
            ok: false,
            reason: 'ADDRESS_OUTSIDE_PERIMETER',
        });
    });
});

describe("resolvePerimeterAddresses — a LOCAL_ONLY tenant's text never reaches an address outside the deployment", () => {
    it('a name resolving inside is admitted, with every address returned for the pin', async () => {
        mockLookup.mockResolvedValue([
            { address: '172.18.0.7', family: 4 },
            { address: 'fd00::7', family: 6 },
        ]);
        expect(await resolvePerimeterAddresses('http://tei-embed:8080')).toEqual({
            ok: true,
            host: 'tei-embed',
            addresses: [
                { address: '172.18.0.7', family: 4 },
                { address: 'fd00::7', family: 6 },
            ],
        });
        expect(mockLookup).toHaveBeenCalledWith('tei-embed', { all: true });
    });

    it('a local-looking name that resolves to a public address is refused', async () => {
        mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        expect(await resolvePerimeterAddresses('https://tei.internal-ops.example.com')).toEqual({
            ok: false,
            reason: 'ADDRESS_OUTSIDE_PERIMETER',
        });
    });

    it('ONE public address among private ones refuses the whole host', async () => {
        mockLookup.mockResolvedValue([
            { address: '10.0.0.7', family: 4 },
            { address: '8.8.8.8', family: 4 },
        ]);
        expect(await resolvePerimeterAddresses('http://tei-embed:8080')).toEqual({
            ok: false,
            reason: 'ADDRESS_OUTSIDE_PERIMETER',
        });
    });

    it('a name that resolves to nothing, or fails, is UNRESOLVABLE', async () => {
        mockLookup.mockResolvedValueOnce([]);
        expect(await resolvePerimeterAddresses('http://tei-embed')).toEqual({ ok: false, reason: 'UNRESOLVABLE' });
        mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
        expect(await resolvePerimeterAddresses('http://tei-embed')).toEqual({ ok: false, reason: 'UNRESOLVABLE' });
    });

    it('a structural refusal asks DNS nothing', async () => {
        expect(await resolvePerimeterAddresses('http://169.254.169.254/')).toEqual({
            ok: false,
            reason: 'ADDRESS_OUTSIDE_PERIMETER',
        });
        expect(mockLookup).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  The dial
// ═══════════════════════════════════════════════════════════════════════════

const INSIDE = [{ address: '172.18.0.9', family: 4 }];
const POST = { method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: '{"q":1}' };
const BOUNDS = { deadlineMs: 2_000, maxResponseBytes: 4_096 };

function ok(body: string, headers: Record<string, string> = { 'content-type': 'application/json' }): Response {
    return new Response(body, { status: 200, headers });
}

describe('the services held to the rule are a closed, named set', () => {
    it('each service names exactly one operator variable', () => {
        expect(IN_DEPLOYMENT_SERVICES).toEqual({
            'doc-parser': 'DOC_PARSER_BASE_URL',
            'ai-guard-nemo': 'AI_GUARD_NEMO_BASE_URL',
            embed: 'AI_EMBED_LOCAL_BASE_URL',
            rerank: 'AI_RERANK_LOCAL_BASE_URL',
            'pii-detector': 'AI_PII_BASE_URL',
        });
    });
});

describe('inDeploymentRequest — a public address is refused before any request', () => {
    it.each([
        ['a public IPv4 literal', 'http://93.184.216.34:5001/v1/convert/source'],
        ['a public IPv6 literal', 'http://[2606:4700::1111]/v1/chat/completions'],
        ['the metadata address', 'http://169.254.169.254/latest/meta-data'],
        ['the metadata hostname', 'http://metadata.google.internal/computeMetadata/v1/'],
    ])('%s: OUTSIDE_DEPLOYMENT, no DNS, no connection, no request', async (_label, url) => {
        const out = await inDeploymentRequest('doc-parser', url, POST, BOUNDS);
        expect(out).toMatchObject({ ok: false, reason: 'OUTSIDE_DEPLOYMENT' });
        expect(mockLookup).not.toHaveBeenCalled();
        expect(mockAgentOptions).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('a scheme other than http(s), and credentials in the URL, are refused the same way', async () => {
        for (const url of ['ftp://docling:21/', 'http://user:pw@docling:5001/']) {
            expect(await inDeploymentRequest('doc-parser', url, POST, BOUNDS)).toMatchObject({
                ok: false,
                reason: 'OUTSIDE_DEPLOYMENT',
            });
        }
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('inDeploymentRequest — DNS that resolves to ANY public address is refused', () => {
    it.each([
        ['only a public address', [{ address: '93.184.216.34', family: 4 }]],
        ['one public address among private ones', [...INSIDE, { address: '8.8.8.8', family: 4 }]],
        ['a link-local (metadata) address', [{ address: '169.254.169.254', family: 4 }]],
        [
            'a public IPv6 address beside a ULA',
            [
                { address: 'fd00::9', family: 6 },
                { address: '2001:db8::1', family: 6 },
            ],
        ],
    ])('a name resolving to %s sends nothing', async (_label, addresses) => {
        mockLookup.mockResolvedValue(addresses);
        const out = await inDeploymentRequest(
            'ai-guard-nemo',
            'http://nemo-guardrails:8000/v1/chat/completions',
            POST,
            BOUNDS,
        );
        expect(out).toEqual({ ok: false, reason: 'OUTSIDE_DEPLOYMENT', refusal: 'ADDRESS_OUTSIDE_PERIMETER' });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('a name that does not resolve is UNRESOLVABLE — the service is not there, nothing was refused', async () => {
        mockLookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND docling'), { code: 'ENOTFOUND' }));
        expect(await inDeploymentRequest('doc-parser', 'http://docling:5001/', POST, BOUNDS)).toEqual({
            ok: false,
            reason: 'UNRESOLVABLE',
            refusal: 'UNRESOLVABLE',
        });
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('inDeploymentRequest — a private address is dialled, pinned to what was checked', () => {
    it('http to a Compose name resolving inside is sent, and the answer is read', async () => {
        mockLookup.mockResolvedValue(INSIDE);
        mockFetch.mockResolvedValue(ok('{"status":"success"}'));
        const out = await inDeploymentRequest('doc-parser', 'http://docling:5001/v1/convert/source', POST, BOUNDS);
        expect(out).toEqual({ ok: true, status: 200, contentType: 'application/json', text: '{"status":"success"}' });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe('http://docling:5001/v1/convert/source');
        expect(init).toMatchObject({ method: 'POST', body: '{"q":1}', redirect: 'manual' });
        expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    });

    it('the connection is pinned: the Agent answers every lookup with the checked addresses only', async () => {
        mockLookup.mockResolvedValue([
            { address: '10.0.3.4', family: 4 },
            { address: 'fd00::4', family: 6 },
        ]);
        mockFetch.mockResolvedValue(ok('{}'));
        await inDeploymentRequest('embed', 'https://tei-embed.internal:8443/v1/embeddings', POST, BOUNDS);
        const opts = mockAgentOptions.mock.calls[0][0] as {
            connect: { lookup: (h: string, o: unknown, cb: (e: unknown, a: unknown) => void) => void };
        };
        const answered = jest.fn();
        // Whatever name the socket asks for, it gets the addresses that passed.
        opts.connect.lookup('attacker.example.com', {}, answered);
        expect(answered).toHaveBeenCalledWith(null, [
            { address: '10.0.3.4', family: 4 },
            { address: 'fd00::4', family: 6 },
        ]);
        expect(mockFetch.mock.calls[0][1]?.dispatcher).toBeDefined();
    });

    it('loopback is inside: a service on the same host is dialled', async () => {
        mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
        mockFetch.mockResolvedValue(ok('{}'));
        const out = await inDeploymentRequest('rerank', 'http://127.0.0.1:8081/info', { method: 'GET' }, BOUNDS);
        expect(out).toMatchObject({ ok: true, status: 200 });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe('inDeploymentRequest — a redirect is refused, never followed', () => {
    it.each([301, 302, 307, 308])('%i is REDIRECT_REFUSED after exactly one request', async (status) => {
        mockLookup.mockResolvedValue(INSIDE);
        mockFetch.mockResolvedValue(new Response(null, { status, headers: { location: 'http://93.184.216.34/' } }));
        const out = await inDeploymentRequest(
            'ai-guard-nemo',
            'http://nemo-guardrails:8000/v1/chat/completions',
            POST,
            BOUNDS,
        );
        expect(out).toEqual({ ok: false, reason: 'REDIRECT_REFUSED', status });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe('inDeploymentRequest — the byte cap aborts the read', () => {
    it('an undeclared, endless body is cancelled once it passes the cap', async () => {
        mockLookup.mockResolvedValue(INSIDE);
        let pulls = 0;
        let cancelled = false;
        const endless = new ReadableStream<Uint8Array>({
            // Yields between chunks so a reader without a cap meets the
            // deadline and fails as TIMEOUT, rather than starving the loop.
            async pull(controller) {
                await new Promise((resolve) => setImmediate(resolve));
                pulls += 1;
                controller.enqueue(new Uint8Array(512));
            },
            cancel() {
                cancelled = true;
            },
        });
        mockFetch.mockResolvedValue(new Response(endless, { status: 200 }));
        const out = await inDeploymentRequest('doc-parser', 'http://docling:5001/', POST, {
            deadlineMs: 5_000,
            maxResponseBytes: 4_096,
        });
        expect(out).toMatchObject({ ok: false, reason: 'RESPONSE_TOO_LARGE' });
        expect(cancelled).toBe(true);
        // 4096 / 512 = 8 chunks reach the cap; a reader that buffered the
        // whole body would never return at all.
        expect(pulls).toBeLessThan(16);
    });

    it('a declared Content-Length over the cap is refused without reading', async () => {
        mockLookup.mockResolvedValue(INSIDE);
        mockFetch.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-length': String(1 << 30) } }));
        expect(await inDeploymentRequest('doc-parser', 'http://docling:5001/', POST, BOUNDS)).toMatchObject({
            ok: false,
            reason: 'RESPONSE_TOO_LARGE',
        });
    });
});

describe('inDeploymentRequest — one deadline over the whole call, and every failure named', () => {
    it('a deadline of zero or less sends nothing', async () => {
        for (const deadlineMs of [0, -5]) {
            expect(
                await inDeploymentRequest('doc-parser', 'http://docling:5001/', POST, { ...BOUNDS, deadlineMs }),
            ).toEqual({ ok: false, reason: 'TIMEOUT' });
        }
        expect(mockLookup).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('a resolver that never answers is a TIMEOUT — DNS is inside the deadline', async () => {
        mockLookup.mockReturnValue(new Promise(() => undefined));
        expect(
            await inDeploymentRequest('doc-parser', 'http://docling:5001/', POST, { ...BOUNDS, deadlineMs: 20 }),
        ).toEqual({ ok: false, reason: 'TIMEOUT' });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('a body that stalls after the head is a TIMEOUT', async () => {
        mockLookup.mockResolvedValue(INSIDE);
        const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
        mockFetch.mockResolvedValue(new Response(stalled, { status: 200 }));
        expect(
            await inDeploymentRequest('doc-parser', 'http://docling:5001/', POST, { ...BOUNDS, deadlineMs: 20 }),
        ).toEqual({ ok: false, reason: 'TIMEOUT' });
    });

    it("the caller's own abort is ABORTED, not TIMEOUT", async () => {
        mockLookup.mockResolvedValue(INSIDE);
        mockFetch.mockReturnValue(new Promise<Response>(() => undefined));
        const caller = new AbortController();
        const pending = inDeploymentRequest('embed', 'http://tei-embed:8080/', POST, {
            ...BOUNDS,
            deadlineMs: 10_000,
            signal: caller.signal,
        });
        caller.abort();
        expect(await pending).toEqual({ ok: false, reason: 'ABORTED' });
    });

    it('a non-2xx answer is HTTP_STATUS with its status', async () => {
        mockLookup.mockResolvedValue(INSIDE);
        mockFetch.mockResolvedValue(new Response('upstream detail', { status: 503 }));
        expect(await inDeploymentRequest('ai-guard-nemo', 'http://nemo-guardrails:8000/', POST, BOUNDS)).toEqual({
            ok: false,
            reason: 'HTTP_STATUS',
            status: 503,
        });
    });

    it('a socket failure is NETWORK_ERROR, and nothing throws', async () => {
        mockLookup.mockResolvedValue(INSIDE);
        mockFetch.mockRejectedValue(new TypeError('fetch failed'));
        expect(await inDeploymentRequest('rerank', 'http://tei-rerank:8080/rerank', POST, BOUNDS)).toEqual({
            ok: false,
            reason: 'NETWORK_ERROR',
        });
    });
});
