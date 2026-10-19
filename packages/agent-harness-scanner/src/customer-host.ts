/**
 * A HOST THE CUSTOMER NAMES — checked when the configuration is read, and
 * re-resolved before every request (#3738, owner decision 2026-10-19).
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
 *     `checkWebhookUrl`'s rules, with no allowlist to relax them.
 *   • AT USE. `assertResolvesPublic` resolves the host again before EACH
 *     request and refuses when any address it resolves to is one of those. A
 *     name that pointed at a public address when the file was written and at
 *     169.254.169.254 tonight is caught tonight, and the request carrying the
 *     API key is never started.
 *
 * `isPrivateAddress` is a copy of the application's
 * (`src/app-layer/automation/webhook-safety.ts`), and
 * `tests/unit/agent-harness-scanner/langsmith-source.test.ts` holds the two to
 * the same answer on every address in its table, so the copy cannot drift.
 *
 * What this does not do, and the application's `safeFetch` does: PIN the
 * connection to the address it checked. That takes an undici dispatcher, which
 * is not a Node built-in. The check therefore runs immediately before each
 * request and the request resolves again, so a resolver that answers
 * differently inside that gap is a residual, recorded in the DPIA.
 */
import { promises as dns } from 'dns';

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
 * Why `value` is not a customer origin the scanner may send a credential to, or
 * null when it is one. Names the rule, never echoes the value.
 */
export function customerOriginProblem(value: string): string | null {
    const origin = httpsOrigin(value);
    if (origin === null) return 'must be a bare https origin: no path, query or credentials';
    const host = new URL(origin).hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host)) return 'names a blocked host';
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
        return 'names a host that is internal by its suffix';
    }
    if (isPrivateAddress(host)) return 'is a private, loopback or link-local address';
    return null;
}

/** Resolve a hostname to every address it has. The CLI's is DNS; tests pass their own. */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

export const resolveWithDns: ResolveHost = async (hostname) =>
    (await dns.lookup(hostname, { all: true })).map((a) => a.address);

/**
 * Resolve `hostname` now and refuse unless EVERY address is public. Throws the
 * contract's UNREACHABLE: the host could not be reached as the configuration
 * names it, which is what both a failed lookup and a private answer mean.
 */
export async function assertResolvesPublic(hostname: string, resolve: ResolveHost): Promise<void> {
    const literal = hostname.replace(/^\[|\]$/g, '');
    let addresses: readonly string[];
    if (/^[\d.]+$/.test(literal) || literal.includes(':')) {
        addresses = [literal];
    } else {
        try {
            addresses = await resolve(hostname);
        } catch {
            throw new SourceReadError('UNREACHABLE', 'the configured host did not resolve');
        }
    }
    if (addresses.length === 0) throw new SourceReadError('UNREACHABLE', 'the configured host resolved to nothing');
    if (addresses.some(isPrivateAddress)) {
        throw new SourceReadError('UNREACHABLE', 'the configured host resolved to an address the scanner may not reach');
    }
}
