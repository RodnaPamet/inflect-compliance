/**
 * A HOST THE CUSTOMER NAMES — checked when the configuration is read, and
 * re-resolved before every request (#3738, owner decisions 2026-10-19).
 *
 * Every other host the scanner reaches is fixed by its kind: Okta's domains,
 * the public cloud's vaults, LangSmith's two cloud API hosts. A self-hosted
 * LangSmith is the first host nobody can enumerate, because it is the
 * customer's own. The owner's ruling is that such a host is validated like any
 * customer-named host in the application: the `publicOrigin` rule kind
 * (`src/app-layer/integrations/config-schema.ts`), which requires https and runs
 * `checkWebhookUrl` at save time, with `safeFetch` re-resolving at use time.
 * The scanner may not import either (`eslint.config.mjs` holds it to the wire
 * contract), so the same two halves live here:
 *
 *   • AT CONFIGURATION. `customerOriginProblem` refuses anything but a bare
 *     https origin, a literal private, loopback, link-local or metadata
 *     address, the blocked names, and the `.local` / `.internal` suffixes —
 *     `checkWebhookUrl`'s rules.
 *   • AT USE. `assertResolvesReachable` resolves the host again before EACH
 *     request and refuses when any address it resolves to is one of those. A
 *     name that pointed at a public address when the file was written and at
 *     169.254.169.254 tonight is caught tonight, and the request carrying the
 *     API key is never started.
 *
 * THE PRIVATE-RANGE ALLOWLIST (owner decision 2026-10-19). A self-hosted
 * LangSmith usually sits on the customer's own network, at a private address.
 * The application's answer to the same problem is its self-hosted egress
 * allowlist (#3328, `src/lib/security/egress-allowlist.ts`,
 * `EGRESS_PRIVATE_CIDR_ALLOWLIST`), and this mirrors it, named
 * `egressPrivateCidrAllowlist` on the self-hosted endpoint:
 *
 *   • NOT TENANT-CONFIGURABLE. The ranges come from the estate's own scanner
 *     configuration file, which only whoever operates the scanner in that
 *     estate can write. No tenant column, form or route reaches it.
 *   • METADATA, LOOPBACK AND LINK-LOCAL STAY REFUSED INSIDE IT.
 *     `NEVER_ALLOWLISTABLE` is the application's list, checked BEFORE the
 *     allowlist, so `0.0.0.0/0` still cannot reach 169.254.169.254 or
 *     127.0.0.1. The blocked names stay refused too.
 *   • IT WIDENS WHICH ADDRESSES ARE ACCEPTABLE AND REMOVES NO OTHER CHECK.
 *     https only, redirects refused, the origin pinned, and the host resolved
 *     again before every request with EVERY address checked: a name that
 *     resolves outside the listed ranges is refused however it resolved when
 *     the file was written. As in the application, an allowlist relaxes only
 *     the `.local` / `.internal` NAME rule, because with one configured the
 *     question becomes the address rather than the name.
 *
 * The CIDR parser is the application's own (`@/lib/security/cidr`, pure and
 * strict), imported rather than copied. `isPrivateAddress` and
 * `NEVER_ALLOWLISTABLE` are copies — their modules read the environment — and
 * `tests/unit/agent-harness-scanner/langsmith-source.test.ts` holds each copy
 * to the application's answer on every address in its tables.
 *
 * What this does not do, and the application's `safeFetch` does: PIN the
 * connection to the address it checked. That takes an undici dispatcher, which
 * is not a Node built-in. The check therefore runs immediately before each
 * request and the request resolves again, so a resolver that answers
 * differently inside that gap is a residual, recorded in the DPIA (R16).
 */
import { promises as dns } from 'dns';

import { inCidr, isV4Mapped, parseAddress, parseCidr, type Cidr } from '@/lib/security/cidr';

import { httpsOrigin } from './http';
import { SourceReadError } from './source';

const PRIVATE_V4 = [
    /^10\./,
    /^127\./,
    /^0\./,
    /^169\.254\./, // link-local, cloud metadata among it
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./,
    /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // CGNAT 100.64/10
];

/** A raw IP literal (v4 or v6) that is private, loopback or link-local. The application's rule, copied. */
export function isPrivateAddress(host: string): boolean {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
    if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
    if (h.startsWith('::ffff:')) return isPrivateAddress(h.slice(7));
    return PRIVATE_V4.some((re) => re.test(h));
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal']);

/**
 * Ranges no allowlist may admit, whatever it says: the application's list
 * (`NEVER_ALLOWLISTABLE` in `src/lib/security/egress-allowlist.ts`), copied.
 *
 *   127/8, ::1   loopback — the scanner host's own services
 *   0/8, ::      "this host", an alias for loopback
 *   169.254/16   link-local: 169.254.169.254 is cloud metadata
 *   fe80::/10    v6 link-local
 */
const NEVER_ALLOWLISTABLE: readonly Cidr[] = [
    '127.0.0.0/8',
    '0.0.0.0/8',
    '169.254.0.0/16',
    '::1/128',
    '::/128',
    'fe80::/10',
].map((c) => {
    const parsed = parseCidr(c);
    // A literal that did not parse would silently shrink the set; fail at load.
    if (parsed === null) throw new Error(`customer-host: bad built-in CIDR ${c}`);
    return parsed;
});

/** The ranges an estate's configuration lists, parsed. Empty is "no allowlist". */
export type PrivateCidrAllowlist = readonly Cidr[];

/** Parse an estate's `egressPrivateCidrAllowlist`; null when any entry is not a CIDR. */
export function parsePrivateCidrAllowlist(entries: readonly string[]): Cidr[] | null {
    const out: Cidr[] = [];
    for (const entry of entries) {
        const parsed = parseCidr(entry);
        if (parsed === null) return null;
        out.push(parsed);
    }
    return out;
}

function inAny(address: string, ranges: readonly Cidr[]): boolean {
    const addr = parseAddress(address);
    if (addr === null) return false;
    // A v4-mapped v6 is the same destination written differently.
    if (addr.length === 16 && isV4Mapped(addr)) {
        const v4 = new Uint8Array(addr.slice(12));
        if (ranges.some((c) => inCidr(v4, c))) return true;
    }
    return ranges.some((c) => inCidr(addr, c));
}

/** True when no allowlist may admit this address: metadata, loopback, link-local. */
export function isNeverAllowlistable(address: string): boolean {
    return inAny(address, NEVER_ALLOWLISTABLE);
}

/**
 * May the scanner reach `address`, given the estate's allowlist? A public
 * address, yes. A private one only when it is NOT never-allowlistable AND it
 * falls inside a listed range. Every other answer, including an address that
 * does not parse, is no.
 */
export function addressReachable(address: string, allowlist: PrivateCidrAllowlist): boolean {
    if (isNeverAllowlistable(address)) return false;
    if (!isPrivateAddress(address)) return true;
    return allowlist.length > 0 && inAny(address, allowlist);
}

/**
 * Why `value` is not a customer origin the scanner may send a credential to, or
 * null when it is one. Names the rule, never echoes the value.
 */
export function customerOriginProblem(value: string, allowlist: PrivateCidrAllowlist = []): string | null {
    const origin = httpsOrigin(value);
    if (origin === null) return 'must be a bare https origin: no path, query or credentials';
    const host = new URL(origin).hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host)) return 'names a blocked host';
    // The NAME rule is a proxy for "probably internal". With an allowlist the
    // question becomes the address, which is checked before every request.
    if (allowlist.length === 0 && (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost'))) {
        return 'names a host that is internal by its suffix';
    }
    if (isIpLiteral(host) && !addressReachable(host.replace(/^\[|\]$/g, ''), allowlist)) {
        return 'is a private, loopback or link-local address outside the allowlist';
    }
    return null;
}

function isIpLiteral(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, '');
    return /^[\d.]+$/.test(h) || h.includes(':');
}

/** Resolve a hostname to every address it has. The CLI's is DNS; tests pass their own. */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

export const resolveWithDns: ResolveHost = async (hostname) =>
    (await dns.lookup(hostname, { all: true })).map((a) => a.address);

/**
 * Resolve `hostname` now and refuse unless EVERY address is one the scanner may
 * reach: public, or private inside the estate's allowlist and never metadata,
 * loopback or link-local. Throws the contract's UNREACHABLE: the host could not
 * be reached as the configuration names it, which is what both a failed lookup
 * and a refused answer mean.
 */
export async function assertResolvesReachable(
    hostname: string,
    resolve: ResolveHost,
    allowlist: PrivateCidrAllowlist = [],
): Promise<void> {
    const literal = hostname.replace(/^\[|\]$/g, '');
    let addresses: readonly string[];
    if (isIpLiteral(literal)) {
        addresses = [literal];
    } else {
        try {
            addresses = await resolve(hostname);
        } catch {
            throw new SourceReadError('UNREACHABLE', 'the configured host did not resolve');
        }
    }
    if (addresses.length === 0) throw new SourceReadError('UNREACHABLE', 'the configured host resolved to nothing');
    if (!addresses.every((a) => addressReachable(a, allowlist))) {
        throw new SourceReadError('UNREACHABLE', 'the configured host resolved to an address the scanner may not reach');
    }
}
