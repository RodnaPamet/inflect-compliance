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
        file: 'src/lib/mcp/client/index.ts',
        reason:
            'Operator-supplied legacy MCP server URL (Step 1b). Somebody types a ' +
            'hostname for a server we do not run, which is textbook SSRF input.',
        // The client resolves `ctx.fetchImpl ?? safeFetch` into a local `doFetch`,
        // so the shape to forbid is a bare call on the context's URL.
        noBareFetchOf: 'fetch(ctx.url',
    },
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
