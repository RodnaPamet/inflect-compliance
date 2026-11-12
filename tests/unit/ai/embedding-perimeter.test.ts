/**
 * The perimeter rule the `inflect-local` route is held to
 * (`src/lib/ai/embeddings/perimeter.ts`): an address INSIDE the deployment —
 * RFC 1918, loopback, IPv6 unique-local — and nothing else, judged on every
 * address a name resolves to.
 *
 * This is the inverse of `safeFetch`'s public-address policy, and the tests
 * are named for the residency claim it protects: a `LOCAL_ONLY` tenant's text
 * never reaches an address outside the deployment.
 */
const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

import { checkPerimeterUrl, isPerimeterAddress, resolvePerimeterAddresses } from '@/lib/ai/embeddings/perimeter';

beforeEach(() => mockLookup.mockReset());

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
