/**
 * Webhook URL safety (SSRF guard) for automation WEBHOOK actions.
 *
 * A rule's webhook URL is operator-supplied, so without a guard any tenant
 * admin who can author a rule gets a server-side request-forgery primitive
 * against the host's internal network (cloud metadata, Redis, RFC-1918, …).
 *
 * Policy: https only, and the resolved host must be a public address. The
 * literal-host check below blocks the obvious cases synchronously; callers
 * should use `safeFetch` (or `assertPublicAddress`) which additionally
 * resolve DNS and re-check EVERY resolved address to defeat hostnames that
 * point at private space (DNS rebinding).
 */

import { promises as dnsPromises } from 'node:dns';
// `fetch` is imported from undici alongside `Agent` deliberately — see the
// version-coupling note on `safeFetch`. Using the global `fetch` here pairs an
// npm-undici dispatcher with Node's BUNDLED undici, and the two are only
// compatible while their dispatcher-handler interfaces happen to match.
import { Agent, fetch as undiciFetch } from 'undici';

const PRIVATE_V4 = [
    /^10\./,
    /^127\./,
    /^0\./,
    /^169\.254\./, // link-local incl. cloud metadata 169.254.169.254
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./, // 172.16/12
    /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // CGNAT 100.64/10
];

/** True for a raw IP literal (v4/v6) that is private / loopback / link-local. */
export function isPrivateAddress(host: string): boolean {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
    if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // v6 link-local + ULA
    if (h.startsWith('::ffff:')) return isPrivateAddress(h.slice(7)); // v4-mapped v6
    return PRIVATE_V4.some((re) => re.test(h));
}

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'metadata',
    'metadata.google.internal',
]);

export interface WebhookUrlVerdict {
    ok: boolean;
    reason?: string;
    host?: string;
}

/**
 * Synchronous structural check: scheme + literal-host + obvious-name blocks.
 * Returns the host so the caller can DNS-resolve and re-check.
 */
export function checkWebhookUrl(rawUrl: string): WebhookUrlVerdict {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return { ok: false, reason: 'malformed URL' };
    }
    if (url.protocol !== 'https:') {
        return { ok: false, reason: 'only https webhooks are allowed' };
    }
    const host = url.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
        return { ok: false, reason: `blocked host ${host}`, host };
    }
    if (isPrivateAddress(host)) {
        return { ok: false, reason: `private address ${host}`, host };
    }
    return { ok: true, host };
}

/** Thrown when a tenant-controlled URL fails the SSRF egress guard. */
export class SsrfBlockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SsrfBlockedError';
    }
}

export interface PublicAddressResult {
    url: URL;
    host: string;
    /** Every A/AAAA the host resolved to — all validated public. */
    addresses: { address: string; family: number }[];
}

/**
 * Full async SSRF guard: the synchronous `checkWebhookUrl` structural check
 * PLUS a DNS resolution of the host with EVERY resolved A/AAAA re-checked
 * against `isPrivateAddress`. Defeats DNS rebinding — a public hostname that
 * resolves into private / loopback / link-local / cloud-metadata space is
 * rejected. Throws `SsrfBlockedError` on any failure; returns the resolved
 * addresses so the caller can pin the connection (see `safeFetch`).
 */
export async function assertPublicAddress(rawUrl: string): Promise<PublicAddressResult> {
    const verdict = checkWebhookUrl(rawUrl);
    if (!verdict.ok || !verdict.host) {
        throw new SsrfBlockedError(verdict.reason ?? 'blocked URL');
    }
    const { host } = verdict;
    let addresses: { address: string; family: number }[];
    try {
        addresses = await dnsPromises.lookup(host, { all: true });
    } catch {
        throw new SsrfBlockedError(`cannot resolve ${host}`);
    }
    if (addresses.length === 0) {
        throw new SsrfBlockedError(`no addresses for ${host}`);
    }
    for (const a of addresses) {
        if (isPrivateAddress(a.address)) {
            throw new SsrfBlockedError(`${host} resolves to private address ${a.address}`);
        }
    }
    return { url: new URL(rawUrl), host, addresses };
}

/**
 * Thrown when a guarded request is answered with a redirect.
 *
 * Separate from `SsrfBlockedError` so a caller (and an operator reading logs)
 * can tell "you configured a forbidden destination" apart from "your endpoint
 * redirects, which this client will not follow".
 */
export class RedirectNotAllowedError extends Error {
    constructor(
        readonly status: number,
        readonly location: string | null,
    ) {
        super(
            `Refusing to follow a ${status} redirect` +
                (location ? ` to ${location}` : '') +
                ' — configure the final URL directly.',
        );
        this.name = 'RedirectNotAllowedError';
    }
}

/**
 * SSRF-safe `fetch` for any tenant-controlled URL. Runs `assertPublicAddress`
 * (structural + DNS re-check of every resolved address), then PINS the
 * connection to those pre-validated IPs via an undici dispatcher whose
 * `lookup` returns only them — so DNS cannot change between the check and the
 * connect (TOCTOU). The original hostname is preserved for TLS SNI + cert
 * validation. Throws `SsrfBlockedError` if the URL is unsafe.
 *
 * ── Redirects are REFUSED, not followed ─────────────────────────────
 *
 * Without `redirect: 'manual'`, fetch follows up to 20 redirects while
 * `assertPublicAddress` had validated only the FIRST url — and the IP pin does
 * not survive a hop, because Node's `net.connect` skips `options.lookup` for
 * IP-literal hosts. So an attacker-controlled public endpoint answering
 *
 *     302 Location: http://169.254.169.254/latest/meta-data/
 *
 * reached cloud metadata with the scheme check, the host blocklist and the pin
 * all bypassed on the redirect leg.
 *
 * Refusing outright rather than re-validating each hop, deliberately:
 *
 *   • Re-validating would prove only that the NEXT host is public — not that
 *     it is a host the operator ever configured. This client POSTs signed
 *     audit batches and automation payloads; sending that body to a
 *     destination nobody entered is the thing worth preventing, and a
 *     per-hop public-address check does not prevent it.
 *   • A redirect on a POST endpoint is a misconfiguration signal, not a normal
 *     pattern. Surfacing it as an actionable error is better than silently
 *     re-pointing an integration.
 *
 * The cost is a behaviour change for any endpoint that relied on a redirect;
 * those get a clear `RedirectNotAllowedError` naming the target, so the fix is
 * to configure the final URL.
 */
export async function safeFetch(rawUrl: string, init?: RequestInit): Promise<Response> {
    const { addresses } = await assertPublicAddress(rawUrl);
    const pinned = addresses.map((a) => ({
        address: a.address,
        family: (a.family === 6 ? 6 : 4) as 4 | 6,
    }));
    const dispatcher = new Agent({
        // Short-lived: this Agent serves only this one pinned request.
        keepAliveTimeout: 1,
        keepAliveMaxTimeout: 1,
        connect: {
            // undici calls lookup with `all: true` and expects an address list.
            lookup: (
                _hostname: string,
                _options: unknown,
                cb: (
                    err: NodeJS.ErrnoException | null,
                    addrs: { address: string; family: number }[],
                ) => void,
            ) => {
                cb(null, pinned);
            },
        },
    } as unknown as ConstructorParameters<typeof Agent>[0]);

    // undici's OWN fetch, not the global one. The dispatcher above comes from
    // the npm `undici` package; the global `fetch` is served by the undici
    // BUNDLED inside Node. Handing a dispatcher across that boundary only works
    // while the two versions' handler interfaces agree, and undici 8 changed
    // them — `fetch(url, { dispatcher })` against a v8 Agent on Node 22 throws
    // `TypeError: fetch failed` / `invalid onRequestStart method` for EVERY
    // request. Because this function is the egress path for signed audit-stream
    // batches and every automation webhook, that failure mode is silent at the
    // point of change and total at runtime: SIEM delivery stops and all webhook
    // actions fail. Sourcing both halves from the same package removes the
    // coupling entirely, so an undici major bump can no longer break egress.
    const res = (await undiciFetch(rawUrl, {
        ...init,
        // Callers MUST NOT be able to opt back in — a spread of `init` after
        // this would let a caller reinstate 'follow' and reopen the hole, so
        // it is applied last.
        redirect: 'manual',
        dispatcher,
    } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as Response;

    if (res.status >= 300 && res.status < 400) {
        throw new RedirectNotAllowedError(res.status, res.headers.get('location'));
    }

    return res;
}
