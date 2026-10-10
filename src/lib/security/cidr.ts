/**
 * IP address and CIDR parsing. PURE — no environment, no policy, no imports.
 *
 * Split from `egress-allowlist.ts` (#3328) so `src/env.ts` can validate the
 * allowlist's SHAPE at startup without importing anything that reads
 * `process.env.STRIPE_SECRET_KEY`. `env.ts` is reachable from client code, and
 * a client bundle has no business naming a server secret even to find it
 * undefined. The policy — which ranges are never allowlistable, which
 * deployment may use an allowlist at all — stays next to the thing that
 * enforces it.
 *
 * The parsers are deliberately STRICT. `010.1.1.1` and `127.1` are rejected
 * rather than normalised, because a lenient parser is how an address reaches a
 * comparison in a shape the comparison did not expect.
 */

/** A parsed CIDR block: the network bytes plus how many bits are significant. */
export interface Cidr {
    readonly bytes: Uint8Array;
    readonly prefixBits: number;
    /** The text it was parsed from, for diagnostics. */
    readonly source: string;
}

/**
 * Dotted-quad to 4 bytes, or `null`.
 *
 * Strict on purpose: `010.1.1.1` and `1.2.3` are rejected rather than
 * normalised. A lenient parser here is how `127.1` reaches a comparison
 * expecting `127.0.0.1`.
 */
function parseV4(text: string): Uint8Array | null {
    const parts = text.split('.');
    if (parts.length !== 4) return null;
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i += 1) {
        const p = parts[i];
        if (!/^\d{1,3}$/.test(p)) return null;
        if (p.length > 1 && p.startsWith('0')) return null;
        const n = Number(p);
        if (n > 255) return null;
        out[i] = n;
    }
    return out;
}

/** An IPv6 literal to 16 bytes, or `null`. Handles `::` and v4-mapped tails. */
function parseV6(text: string): Uint8Array | null {
    let t = text.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (t === '') return null;
    // A v4-mapped tail (`::ffff:10.0.0.1`) is expanded to two groups first.
    const v4Tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
    if (v4Tail) {
        const v4 = parseV4(v4Tail[1]);
        if (v4 === null) return null;
        const hi = ((v4[0] << 8) | v4[1]).toString(16);
        const lo = ((v4[2] << 8) | v4[3]).toString(16);
        t = `${t.slice(0, v4Tail.index)}:${hi}:${lo}`;
    }
    const halves = t.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] === '' ? [] : halves[0].split(':');
    const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
    const groups: string[] =
        halves.length === 2
            ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
            : head;
    if (groups.length !== 8) return null;
    const out = new Uint8Array(16);
    for (let i = 0; i < 8; i += 1) {
        const g = groups[i];
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        const n = Number.parseInt(g, 16);
        out[i * 2] = n >> 8;
        out[i * 2 + 1] = n & 0xff;
    }
    return out;
}

/** Any address literal to its bytes, or `null` if it is not one. */
export function parseAddress(text: string): Uint8Array | null {
    const bare = text.trim().replace(/^\[|\]$/g, '');
    return bare.includes(':') ? parseV6(bare) : parseV4(bare);
}

/** `10.0.0.0/8` or `fd00::/8` to a `Cidr`, or `null` when unparseable. */
export function parseCidr(text: string): Cidr | null {
    const source = text.trim();
    const slash = source.lastIndexOf('/');
    if (slash <= 0) return null;
    const addr = parseAddress(source.slice(0, slash));
    if (addr === null) return null;
    const bitsText = source.slice(slash + 1);
    if (!/^\d{1,3}$/.test(bitsText)) return null;
    const prefixBits = Number(bitsText);
    if (prefixBits > addr.length * 8) return null;
    return { bytes: addr, prefixBits, source };
}

/** Is `addr` inside `cidr`? Families must match; a v4 is never in a v6 block. */
export function inCidr(addr: Uint8Array, cidr: Cidr): boolean {
    if (addr.length !== cidr.bytes.length) return false;
    const whole = cidr.prefixBits >> 3;
    for (let i = 0; i < whole; i += 1) {
        if (addr[i] !== cidr.bytes[i]) return false;
    }
    const rem = cidr.prefixBits & 7;
    if (rem === 0) return true;
    const mask = 0xff << (8 - rem);
    return (addr[whole] & mask) === (cidr.bytes[whole] & mask);
}

/**
 * Is this a v4-mapped v6 address (`::ffff:10.0.0.1`)?
 *
 * Needed because such an address is the same destination written differently,
 * and a check that only looks at the 16-byte form lets
 * `::ffff:169.254.169.254` past a rule that refuses the v4 spelling.
 */
export function isV4Mapped(addr: Uint8Array): boolean {
    if (addr.length !== 16) return false;
    for (let i = 0; i < 10; i += 1) if (addr[i] !== 0) return false;
    return addr[10] === 0xff && addr[11] === 0xff;
}
