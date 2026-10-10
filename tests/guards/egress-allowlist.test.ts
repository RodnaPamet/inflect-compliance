/**
 * The self-hosted private-address CIDR allowlist (#3328).
 *
 * This file is the safety argument. The allowlist is a deliberate relaxation
 * of the SSRF guard, authorised because `safeFetch` otherwise makes it
 * impossible to put an MCP server on an internal network at all — so what has
 * to be pinned is not that it works but that it cannot be widened into the
 * thing `safeFetch` exists to stop:
 *
 *   1. it is inert on a hosted deployment, whatever the variable says;
 *   2. cloud metadata and loopback stay refused INSIDE it, so `0.0.0.0/0`
 *      is a wide allowlist and still not a credential-disclosure primitive;
 *   3. every other check survives — https only, DNS re-resolved at use time,
 *      every resolved address tested, redirects refused;
 *   4. with no allowlist configured, nothing changes at all.
 *
 * (4) is the control. Without it the rest could all pass on a guard that had
 * quietly stopped refusing anything.
 */
const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

import { parseAddress, parseCidr, isV4Mapped } from '@/lib/security/cidr';
import {
    egressAllowlistActive,
    isNeverAllowlistable,
    privateEgressAllowed,
    resetEgressAllowlistCacheForTests,
} from '@/lib/security/egress-allowlist';
import { assertPublicAddress, checkWebhookUrl, SsrfBlockedError } from '@/app-layer/automation/webhook-safety';

/** Reconfigure the deployment the way a restart would. */
function configure(opts: { cidrs?: string; hosted?: boolean }): void {
    if (opts.cidrs === undefined) delete process.env.EGRESS_PRIVATE_CIDR_ALLOWLIST;
    else process.env.EGRESS_PRIVATE_CIDR_ALLOWLIST = opts.cidrs;
    resetEgressAllowlistCacheForTests();
    jest.resetModules();
    void opts.hosted;
}

const ORIGINAL = process.env.EGRESS_PRIVATE_CIDR_ALLOWLIST;
afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.EGRESS_PRIVATE_CIDR_ALLOWLIST;
    else process.env.EGRESS_PRIVATE_CIDR_ALLOWLIST = ORIGINAL;
    resetEgressAllowlistCacheForTests();
    mockLookup.mockReset();
});

// ═════════════════════════════════════════════════════════════════════
// 1. PARSING — strict, because lenient is how an address arrives disguised
// ═════════════════════════════════════════════════════════════════════

describe('address parsing is strict', () => {
    const hex = (u: Uint8Array | null) =>
        u === null ? null : Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');

    it.each([
        ['10.0.0.1', '0a000001'],
        ['127.0.0.1', '7f000001'],
        ['::1', '00000000000000000000000000000001'],
        ['::', '00000000000000000000000000000000'],
        ['fe80::1', 'fe800000000000000000000000000001'],
        ['fd00::1', 'fd000000000000000000000000000001'],
        // v4-mapped: the same destination written differently.
        ['::ffff:10.0.0.1', '00000000000000000000ffff0a000001'],
        ['::ffff:169.254.169.254', '00000000000000000000ffffa9fea9fe'],
    ])('parses %s', (text, expected) => {
        expect(hex(parseAddress(text))).toBe(expected);
    });

    it.each([
        ['1.2.3', 'too few octets'],
        ['010.1.1.1', 'octal-looking octet'],
        ['256.1.1.1', 'octet out of range'],
        ['1.2.3.4.5', 'too many octets'],
        ['', 'empty'],
        ['10.0.0.1/8', 'a CIDR is not an address'],
        ['fe80::1::2', 'two :: runs'],
        ['gggg::1', 'non-hex group'],
    ])('refuses %s (%s)', (text) => {
        expect(parseAddress(text)).toBeNull();
    });

    it.each([
        ['10.0.0.0/8', 8],
        ['192.168.0.0/16', 16],
        ['0.0.0.0/0', 0],
        ['fd00::/8', 8],
        ['::1/128', 128],
    ])('parses the CIDR %s', (text, bits) => {
        expect(parseCidr(text)?.prefixBits).toBe(bits);
    });

    it.each([['10.0.0.0/33'], ['fd00::/129'], ['10.0.0.0'], ['bad/8'], ['/8'], ['10.0.0.0/x']])(
        'refuses the CIDR %s',
        (text) => {
            expect(parseCidr(text)).toBeNull();
        },
    );

    it('recognises v4-mapped only at 16 bytes', () => {
        expect(isV4Mapped(parseAddress('::ffff:10.0.0.1')!)).toBe(true);
        expect(isV4Mapped(parseAddress('fd00::1')!)).toBe(false);
        expect(isV4Mapped(parseAddress('10.0.0.1')!)).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. THE RANGES NO ALLOWLIST MAY ADMIT
// ═════════════════════════════════════════════════════════════════════

describe('metadata and loopback are never allowlistable', () => {
    it.each([
        ['127.0.0.1', 'loopback'],
        ['127.255.255.254', 'loopback, far end'],
        ['0.0.0.0', 'unspecified'],
        ['169.254.169.254', 'cloud metadata'],
        ['169.254.0.1', 'link-local'],
        ['::1', 'v6 loopback'],
        ['::', 'v6 unspecified'],
        ['fe80::1', 'v6 link-local'],
        // Written as v6 to dodge a v4-only rule — the case a naive check misses.
        ['::ffff:169.254.169.254', 'v4-mapped metadata'],
        ['::ffff:127.0.0.1', 'v4-mapped loopback'],
    ])('%s (%s)', (address) => {
        expect(isNeverAllowlistable(address)).toBe(true);
    });

    it.each([['10.0.0.1'], ['192.168.1.1'], ['172.16.0.1'], ['fd00::1'], ['8.8.8.8']])(
        '%s is allowlistable in principle',
        (address) => {
            expect(isNeverAllowlistable(address)).toBe(false);
        },
    );

    it('0.0.0.0/0 is a wide allowlist and still not a metadata primitive', () => {
        // The headline property. An operator who allowlists everything gets
        // every private range they asked for and no credential disclosure.
        configure({ cidrs: '0.0.0.0/0,::/0' });
        expect(privateEgressAllowed('10.1.2.3')).toBe(true);
        expect(privateEgressAllowed('192.168.1.1')).toBe(true);
        for (const refused of [
            '127.0.0.1',
            '169.254.169.254',
            '::1',
            'fe80::1',
            '0.0.0.0',
            '::ffff:127.0.0.1',
            '::ffff:169.254.169.254',
        ]) {
            expect(privateEgressAllowed(refused)).toBe(false);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. THE GATES
// ═════════════════════════════════════════════════════════════════════

describe('the allowlist only applies where it is meant to', () => {
    it('is inactive when unset — the control for everything else here', () => {
        configure({ cidrs: undefined });
        expect(egressAllowlistActive()).toBe(false);
        expect(privateEgressAllowed('10.1.2.3')).toBe(false);
    });

    it('admits an address inside a configured range and nothing outside it', () => {
        configure({ cidrs: '10.0.0.0/8,fd00::/8' });
        expect(privateEgressAllowed('10.1.2.3')).toBe(true);
        expect(privateEgressAllowed('fd00::1')).toBe(true);
        // Private, but not in a range the operator named.
        expect(privateEgressAllowed('192.168.1.1')).toBe(false);
        expect(privateEgressAllowed('172.16.0.1')).toBe(false);
    });

    it('matches a v4-mapped address against a v4 range', () => {
        configure({ cidrs: '10.0.0.0/8' });
        expect(privateEgressAllowed('::ffff:10.1.2.3')).toBe(true);
    });

    it('never matches a v4 address against a v6 range, or the reverse', () => {
        configure({ cidrs: 'fd00::/8' });
        expect(privateEgressAllowed('10.1.2.3')).toBe(false);
        configure({ cidrs: '10.0.0.0/8' });
        expect(privateEgressAllowed('fd00::1')).toBe(false);
    });

    it('drops an unparseable entry and keeps the valid ones — failing closed', () => {
        configure({ cidrs: 'not-a-cidr,10.0.0.0/8,10.0.0.0/99' });
        expect(privateEgressAllowed('10.1.2.3')).toBe(true);
        // The garbage widened nothing.
        expect(privateEgressAllowed('192.168.1.1')).toBe(false);
    });

    it('is inert on a hosted deployment, whatever the variable says', () => {
        // The gate that matters most: on hosted Inflect the "internal network"
        // is OURS, and a tenant-adjacent fetch into it is the original threat.
        const original = process.env.STRIPE_SECRET_KEY;
        try {
            process.env.STRIPE_SECRET_KEY = 'sk_test_hosted';
            jest.resetModules();
            // Re-imported so `billing-mode`'s module-load read sees the key.
            const mod = require('@/lib/security/egress-allowlist') as typeof import('@/lib/security/egress-allowlist');
            process.env.EGRESS_PRIVATE_CIDR_ALLOWLIST = '10.0.0.0/8';
            mod.resetEgressAllowlistCacheForTests();
            expect(mod.egressAllowlistActive()).toBe(false);
            expect(mod.privateEgressAllowed('10.1.2.3')).toBe(false);
        } finally {
            if (original === undefined) delete process.env.STRIPE_SECRET_KEY;
            else process.env.STRIPE_SECRET_KEY = original;
            jest.resetModules();
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. THROUGH THE GUARD ITSELF
// ═════════════════════════════════════════════════════════════════════

describe('the guard honours the allowlist without dropping its other checks', () => {
    it('refuses a private literal when no allowlist is configured — the control', () => {
        configure({ cidrs: undefined });
        expect(checkWebhookUrl('https://10.1.2.3/mcp').ok).toBe(false);
    });

    it('admits a private literal inside a configured range', () => {
        configure({ cidrs: '10.0.0.0/8' });
        expect(checkWebhookUrl('https://10.1.2.3/mcp').ok).toBe(true);
    });

    it('still refuses http, allowlist or not', () => {
        configure({ cidrs: '10.0.0.0/8' });
        const v = checkWebhookUrl('http://10.1.2.3/mcp');
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/https/);
    });

    it.each([['https://localhost/mcp'], ['https://metadata/mcp'], ['https://metadata.google.internal/mcp']])(
        'still refuses the named host %s',
        (url) => {
            configure({ cidrs: '0.0.0.0/0' });
            expect(checkWebhookUrl(url).ok).toBe(false);
        },
    );

    it('stops refusing a .internal NAME, and judges its ADDRESS instead', async () => {
        // The point of the relaxation for the legacy case: a customer's server
        // is plausibly `mcp.corp.internal`. The name stops being the verdict;
        // the resolved address becomes it, which is a stronger test.
        configure({ cidrs: '10.0.0.0/8' });
        expect(checkWebhookUrl('https://mcp.corp.internal/x').ok).toBe(true);
        mockLookup.mockResolvedValue([{ address: '10.4.5.6', family: 4 }]);
        await expect(assertPublicAddress('https://mcp.corp.internal/x')).resolves.toMatchObject({
            host: 'mcp.corp.internal',
        });
    });

    it('refuses a .internal name that resolves OUTSIDE the range', async () => {
        configure({ cidrs: '10.0.0.0/8' });
        mockLookup.mockResolvedValue([{ address: '192.168.9.9', family: 4 }]);
        await expect(assertPublicAddress('https://mcp.corp.internal/x')).rejects.toThrow(
            SsrfBlockedError,
        );
    });

    it('still re-resolves at use time, so rebinding into metadata is refused', async () => {
        // DNS rebinding was the reason for the per-address re-check and the
        // allowlist does not remove it: a public NAME resolving to metadata is
        // refused even with everything allowlisted.
        configure({ cidrs: '0.0.0.0/0' });
        mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
        await expect(assertPublicAddress('https://harmless.example.com/x')).rejects.toThrow(
            /private address 169\.254\.169\.254/,
        );
    });

    it('refuses when ANY of several resolved addresses falls outside', async () => {
        // `every` semantics, asserted: one bad address in a round-robin set is
        // enough, or an attacker adds a good one to get the bad one through.
        configure({ cidrs: '10.0.0.0/8' });
        mockLookup.mockResolvedValue([
            { address: '10.1.1.1', family: 4 },
            { address: '192.168.1.1', family: 4 },
        ]);
        await expect(assertPublicAddress('https://mixed.corp.internal/x')).rejects.toThrow(
            SsrfBlockedError,
        );
    });
});
