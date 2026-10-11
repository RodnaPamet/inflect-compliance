/**
 * SSRF egress coverage ratchet.
 *
 * The webhook-safety guard (private/loopback/link-local + cloud-metadata block,
 * https-only, DNS-rebinding re-check, IP-pin) must sit in front of EVERY
 * tenant-controlled outbound fetch. Historically it guarded only the automation
 * webhook action; the tenant-controlled audit-stream URL fetched directly — a
 * cloud-metadata SSRF hole. This ratchet:
 *
 *   1. exercises `assertPublicAddress` against literal-private, metadata, and a
 *      DNS-rebinding (public name → private IP) case (mocked resolver);
 *   2. structurally asserts each curated tenant-controlled outbound sink routes
 *      through `safeFetch` and carries no bare `fetch(<tenant url>)`.
 *
 * A new outbound sink on a tenant-derived URL must use `safeFetch` (and be added
 * to SINKS) or this fails CI.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Mock the resolver so the rebinding case is deterministic ───────
const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

import { assertPublicAddress, isPrivateAddress, SsrfBlockedError } from '@/app-layer/automation/webhook-safety';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('SSRF — isPrivateAddress', () => {
    it('flags cloud-metadata, RFC-1918, CGNAT, loopback, and v6 loopback', () => {
        for (const ip of ['169.254.169.254', '10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '::1', '0.0.0.0']) {
            expect(isPrivateAddress(ip)).toBe(true);
        }
    });
    it('allows genuine public addresses', () => {
        for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1']) {
            expect(isPrivateAddress(ip)).toBe(false);
        }
    });
});

describe('SSRF — assertPublicAddress', () => {
    beforeEach(() => mockLookup.mockReset());

    it('rejects non-https', async () => {
        await expect(assertPublicAddress('http://example.com/')).rejects.toBeInstanceOf(SsrfBlockedError);
    });

    it('rejects literal cloud-metadata + RFC-1918 + v6 loopback + localhost (before DNS)', async () => {
        for (const url of ['https://169.254.169.254/latest/meta-data', 'https://10.0.0.1/', 'https://[::1]/', 'https://localhost/']) {
            await expect(assertPublicAddress(url)).rejects.toBeInstanceOf(SsrfBlockedError);
        }
        expect(mockLookup).not.toHaveBeenCalled(); // literal cases short-circuit
    });

    it('rejects a public hostname that RESOLVES to private space (DNS rebinding)', async () => {
        mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
        await expect(assertPublicAddress('https://rebind.example.com/')).rejects.toThrow(/private address 10\.0\.0\.1/);
    });

    it('rejects when ANY resolved address is private (multi-record)', async () => {
        mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]);
        await expect(assertPublicAddress('https://mixed.example.com/')).rejects.toBeInstanceOf(SsrfBlockedError);
    });

    it('accepts a public hostname resolving to public space', async () => {
        mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        const r = await assertPublicAddress('https://good.example.com/');
        expect(r.host).toBe('good.example.com');
        expect(r.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    });
});

// ─── Curated tenant-controlled outbound sinks ──────────────────────
// Each MUST import + use safeFetch and carry no bare tenant-URL fetch.
const SINKS: { file: string; reason: string; noBareFetchOf: string }[] = [
    {
        file: 'src/app-layer/events/audit-stream.ts',
        reason: 'Tenant-controlled auditStreamUrl (was the metadata-SSRF hole).',
        noBareFetchOf: 'fetch(url',
    },
    {
        file: 'src/app-layer/automation/action-executor.ts',
        reason: 'Tenant-authored automation webhook URL.',
        noBareFetchOf: 'fetch(cfg.url',
    },
    {
        file: 'src/lib/mcp/wire-transport.ts',
        reason:
            'Operator-supplied MCP server URL — BOTH outbound dialects now reach ' +
            'the network here and nowhere else (#3303). Somebody types a hostname ' +
            'for a server we do not run, which is textbook SSRF input.',
        // The transport writes an explicit `opts.fetchImpl ? … : safeFetch(…)`
        // branch rather than resolving an alias, so the shape to forbid is a
        // bare call on the caller's URL.
        noBareFetchOf: 'fetch(opts.url',
    },
];

/**
 * The two outbound MCP clients, which must reach the network ONLY through the
 * shared transport above.
 *
 * This replaces a per-file `safeFetch(` literal check on each client, and is
 * strictly stronger than what it replaces. That check asked "does this file
 * mention safeFetch somewhere?", which a file could satisfy while also
 * fetching directly elsewhere. These assert the clients contain NO fetch call
 * of any kind — so the only way either reaches the network is the one branch
 * the registry above covers.
 *
 * Why this list is two entries and not one: the tools client was never in
 * SINKS at all (#3400), so until now, replacing its `safeFetch` with a bare
 * `fetch` would not have failed CI. The omission was invisible precisely
 * because the OTHER MCP client was listed, and a reader checking "is the MCP
 * client covered?" finds yes for one of two and is unlikely to ask which.
 */
const MCP_CLIENTS: readonly string[] = [
    'src/app-layer/integrations/mcp/client.ts',
    'src/lib/mcp/client/index.ts',
];

describe('SSRF — every tenant-controlled sink routes through safeFetch', () => {
    for (const sink of SINKS) {
        it(`${sink.file} uses safeFetch, not a bare fetch (${sink.reason})`, () => {
            const src = read(sink.file);
            expect(src).toMatch(/safeFetch\(/);
            expect(src).toMatch(/from '(\.\/|@\/app-layer\/automation\/)webhook-safety'/);
            // the pre-fix bare fetch on the tenant URL must be gone
            expect(src).not.toContain(`await ${sink.noBareFetchOf}`);
        });
    }
});

/**
 * The findings are COMPUTED here and asserted as values below, rather than
 * written as `expect(read(file)).not.toMatch(…)` per client.
 *
 * That is not a style preference. `Class D` of the needle-uniqueness ratchet
 * counts whole-file assertions it cannot statically follow, and a read whose
 * path comes from a loop variable (`path-not-constant`) or whose content is
 * transformed before matching (`content-transformed`) is one of them — a blind
 * spot where an ambiguous needle could hide. Comment-stripping is required for
 * correctness here, so the read cannot be made analysable; removing the
 * file-read SHAPE is the remedy the ratchet leaves open, and it also gives a
 * failure that names the offending file instead of just reporting a regex miss.
 */
function codeOf(rel: string): string {
    // Comments stripped: prose naming a forbidden pattern is not a call, and a
    // check that cannot tell the difference reports the explanation of a rule
    // as a breach of it.
    return read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const clientsWithTheirOwnFetch = () =>
    MCP_CLIENTS.filter((f) => /\bfetch\(/.test(codeOf(f)) || /\bsafeFetch\b/.test(codeOf(f)));

const clientsNotUsingTheTransport = () =>
    MCP_CLIENTS.filter((f) => !/from '@\/lib\/mcp\/wire-transport'/.test(read(f)));

describe('SSRF — the MCP clients reach the network only through the shared transport', () => {
    it('neither client contains a fetch call of its own', () => {
        expect(clientsWithTheirOwnFetch()).toEqual([]);
    });

    it('both clients import the shared transport', () => {
        // The other half: "no fetch" alone is also satisfied by a client that
        // reaches the network some third way, or has stopped working entirely.
        expect(clientsNotUsingTheTransport()).toEqual([]);
    });

    it('the list covers both dialects, so neither is silently unlisted', () => {
        // #3400 was invisible because the OTHER MCP client was registered: a
        // reader checking "is the MCP client covered?" finds yes for one of two
        // and is unlikely to ask which. Pinning the denominator makes a future
        // omission loud.
        expect(MCP_CLIENTS).toHaveLength(2);
    });
});
