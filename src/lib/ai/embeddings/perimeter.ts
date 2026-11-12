/**
 * WHERE AN `inflect-local` CALL MAY GO — inside the deployment's perimeter,
 * and nowhere else.
 *
 * ── WHY THIS IS NOT `safeFetch` ─────────────────────────────────────────────
 *
 * `safeFetch` answers "is this a PUBLIC address?" and admits only those: https,
 * no private, loopback or link-local address, `.internal` / `.local` refused
 * (relaxed only by a self-hosted CIDR allowlist, which is inert on hosted
 * Inflect). The `inflect-local` provider id is a RESIDENCY claim — the text
 * stays inside the deployment — and a public address is exactly the one place
 * that claim is false. Behind `safeFetch` the only base URLs this seam could
 * ever reach were off-perimeter ones, so a `LOCAL_ONLY` tenant's passages
 * would have been POSTed outside under the id `inflect-local`. The local AI
 * gateway has the same shape and the same answer
 * (`tests/guards/ssrf-egress-coverage.test.ts`, "THE LOCAL AI GATEWAY"):
 * behind the public-address check, the feature is deleted rather than
 * hardened.
 *
 * So the test is INVERTED, and it is applied the way `safeFetch` applies its
 * own: structurally when the route is chosen, then again at use time against
 * EVERY address the host resolves to, with the connection pinned to those
 * addresses (`http.ts`). A name that resolves anywhere public is refused
 * however local it looks.
 *
 * ── WHAT COUNTS AS INSIDE ───────────────────────────────────────────────────
 *
 *   • IPv4 RFC 1918 (10/8, 172.16/12, 192.168/16) — the Compose network and
 *     the VPC;
 *   • loopback (127/8, ::1) — a service on the same host;
 *   • IPv6 unique-local (fc00::/7).
 *
 * Everything else is OUTSIDE, including three private-looking ranges on
 * purpose: link-local (169.254/16, fe80::/10 — cloud metadata lives there),
 * 0/8 and CGNAT (100.64/10 — a carrier's space, not ours). The metadata
 * hostnames are refused by name before DNS is asked.
 *
 * Both `http:` and `https:` are admitted: on the Compose network the transport
 * is plaintext by design, and the scheme was never the residency question.
 * Credentials in the URL are refused — nothing here sends one, and a URL that
 * carries one would put it in every log line that names the endpoint.
 *
 * The base URL is OPERATOR configuration (`src/env.ts`); no tenant writes it.
 * This module answers the residency question for that operator value, not an
 * SSRF question about a tenant's.
 *
 * @module lib/ai/embeddings/perimeter
 */
import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';

export type PerimeterRefusal =
    /** The base URL does not parse. */
    | 'MALFORMED_URL'
    /** Neither `http:` nor `https:`. */
    | 'SCHEME_NOT_HTTP'
    /** The URL carries a user name or password. */
    | 'CREDENTIALS_IN_URL'
    /** A cloud-metadata hostname, refused by name. */
    | 'METADATA_HOST'
    /** A literal, or a resolved, address outside the perimeter. */
    | 'ADDRESS_OUTSIDE_PERIMETER'
    /** DNS returned nothing, or failed. */
    | 'UNRESOLVABLE';

export type PerimeterUrlVerdict =
    | { readonly ok: true; readonly host: string }
    | { readonly ok: false; readonly reason: PerimeterRefusal };

export type PerimeterResolution =
    | { readonly ok: true; readonly host: string; readonly addresses: readonly { address: string; family: 4 | 6 }[] }
    | { readonly ok: false; readonly reason: PerimeterRefusal };

const METADATA_HOSTNAMES = new Set(['metadata', 'metadata.google.internal']);

function v4Octets(address: string): number[] | null {
    const parts = address.split('.');
    if (parts.length !== 4) return null;
    const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
    return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : null;
}

function v4Inside(address: string): boolean {
    const o = v4Octets(address);
    if (!o) return false;
    const [a, b] = o;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return a === 127;
}

/** `::ffff:a.b.c.d` or `::ffff:hhhh:hhhh` (the form the URL parser writes) → the IPv4 address. */
function v4Mapped(address: string): string | null {
    const m = /^::ffff:(.+)$/.exec(address);
    if (!m) return null;
    const rest = m[1];
    if (rest.includes('.')) return rest;
    const groups = rest.split(':');
    if (groups.length !== 2 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
    const [hi, lo] = groups.map((g) => parseInt(g, 16));
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/**
 * True only for an IP literal inside the perimeter. A hostname is never inside
 * on its own; it is judged by what it resolves to.
 */
export function isPerimeterAddress(raw: string): boolean {
    const address = raw.toLowerCase().replace(/^\[|\]$/g, '');
    const family = isIP(address);
    if (family === 4) return v4Inside(address);
    if (family !== 6) return false;
    if (address === '::1') return true;
    const mapped = v4Mapped(address);
    if (mapped !== null) return v4Inside(mapped);
    const first = address.startsWith('::') ? 0 : parseInt(address.split(':')[0], 16);
    // fc00::/7 — unique-local. fe80::/10 (link-local) is deliberately not here.
    return (first & 0xfe00) === 0xfc00;
}

/** The structural half, asked when a route is chosen. No DNS. */
export function checkPerimeterUrl(rawUrl: string): PerimeterUrlVerdict {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return { ok: false, reason: 'MALFORMED_URL' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'SCHEME_NOT_HTTP' };
    if (url.username !== '' || url.password !== '') return { ok: false, reason: 'CREDENTIALS_IN_URL' };
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (METADATA_HOSTNAMES.has(host)) return { ok: false, reason: 'METADATA_HOST' };
    const bare = host.replace(/^\[|\]$/g, '');
    if (isIP(bare) !== 0 && !isPerimeterAddress(bare)) return { ok: false, reason: 'ADDRESS_OUTSIDE_PERIMETER' };
    return { ok: true, host: bare };
}

/**
 * The use-time half: the structural check, then EVERY address the host
 * resolves to must be inside. The caller pins its connection to the returned
 * addresses, so DNS cannot move between this check and the connect.
 */
export async function resolvePerimeterAddresses(rawUrl: string): Promise<PerimeterResolution> {
    const verdict = checkPerimeterUrl(rawUrl);
    if (!verdict.ok) return verdict;
    let found: { address: string; family: number }[];
    try {
        found = await dnsPromises.lookup(verdict.host, { all: true });
    } catch {
        return { ok: false, reason: 'UNRESOLVABLE' };
    }
    if (found.length === 0) return { ok: false, reason: 'UNRESOLVABLE' };
    if (!found.every((a) => isPerimeterAddress(a.address))) return { ok: false, reason: 'ADDRESS_OUTSIDE_PERIMETER' };
    return {
        ok: true,
        host: verdict.host,
        addresses: found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })),
    };
}
