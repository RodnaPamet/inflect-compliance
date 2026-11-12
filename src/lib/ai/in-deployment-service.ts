/**
 * THE IN-DEPLOYMENT SERVICE RULE (G6, as amended by the owner 2026-11-12) —
 * one definition of where a model service the OPERATOR runs inside the
 * deployment may be reached, and one dial that reaches it.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * An IN-DEPLOYMENT service is one whose base URL is an operator environment
 * variable, read by exactly ONE module, and never written by a tenant. Such a
 * service:
 *
 *   • must resolve to an address INSIDE the deployment — every address the
 *     host resolves to, not merely the first;
 *   • is dialled pinned to the addresses that were checked, so DNS cannot move
 *     between the check and the connect;
 *   • is dialled with ONE deadline (covering DNS, the response head and the
 *     body read) and a byte cap that ABORTS the read at the cap;
 *   • never has a redirect followed — a hop would leave the pin.
 *
 * `safeFetch` stays the rule for every host OUTSIDE the deployment. The two are
 * inverses: `safeFetch` admits only PUBLIC addresses, and this module admits
 * only the ones `safeFetch` refuses (minus link-local, see below). Running an
 * in-deployment service behind `safeFetch` did not harden it, it deleted it —
 * every Docling parse and every NeMo scan was `EGRESS_REFUSED` until the
 * operator put TLS and a self-hosted CIDR allowlist in front of a container on
 * the Compose network, and the embedding seam once reached only off-perimeter
 * addresses under the residency claim `inflect-local`.
 *
 * Who is held to it (`IN_DEPLOYMENT_SERVICES` below, and the guard
 * `tests/guards/ssrf-egress-coverage.test.ts`, which derives each variable's
 * readers from the tree and requires exactly one):
 *
 *   doc-parser     DOC_PARSER_BASE_URL        src/lib/ai/parsing/index.ts
 *   ai-guard-nemo  AI_GUARD_NEMO_BASE_URL     src/app-layer/ai/guard/providers/registry.ts
 *   embed          AI_EMBED_LOCAL_BASE_URL    src/lib/ai/embeddings/select.ts
 *   rerank         AI_RERANK_LOCAL_BASE_URL   src/lib/ai/embeddings/select.ts
 *   pii-detector   AI_PII_BASE_URL            src/lib/ai/pii/mount.ts
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
 * hostnames are refused by name before DNS is asked. This is the definition
 * the embedding seam's `perimeter.ts` carried before it moved here, unchanged.
 *
 * Both `http:` and `https:` are admitted: on the Compose network the transport
 * is plaintext by design, and the scheme was never the residency question.
 * Credentials in the URL are refused — a URL carrying one would put it in
 * every log line that names the endpoint.
 *
 * ── WHY A NEW MODULE RATHER THAN `local-gateway.ts` ─────────────────────────
 *
 * `local-gateway.ts` answers a different question — which URL a TENANT may
 * nominate for the local model gateway — and answers it upstream of any dial:
 * it has no network code, reads `@/env` and nothing else, and is imported by
 * Flue's model selection. Putting a resolver and an HTTP transport in it would
 * drag `node:dns` and `undici` into that graph for a rule its callers never
 * use, and blur two rules that must be read separately: that one is about a
 * tenant-writable value, this one is about operator values only. What they
 * share is the PRECEDENT — one reader per variable, held by a derived guard —
 * and the guard applies it to both.
 *
 * ── RULES THAT ARE ONE CARELESS EDIT FROM BEING UNDONE ──────────────────────
 *
 *   • There is no injectable `fetchImpl`. A test seam on a production dial is
 *     a path around the address check that reads as dependency injection;
 *     tests mock `undici` and `node:dns` instead.
 *   • `redirect: 'manual'` is applied AFTER the caller's init is spread, so no
 *     caller can opt back into following.
 *   • The body is read through a byte-capped stream that CANCELS at the cap.
 *     `res.json()` / `res.text()` would allocate the whole body before a length
 *     check could run. `Content-Length` is a free early refusal, never the
 *     check.
 *   • Never throws: every failure is a named reason.
 *
 * @module lib/ai/in-deployment-service
 */
import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';

// `fetch` and `Agent` come from the SAME package, as in `safeFetch`: a
// dispatcher from npm undici handed to Node's bundled fetch breaks whenever
// the two versions' handler interfaces disagree.
import { Agent, fetch as undiciFetch } from 'undici';

// ═══════════════════════════════════════════════════════════════════════════
//  The services held to the rule
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every in-deployment service, and the ONE operator variable that names it.
 * A closed set: a new service is a reviewed diff here, and the guard then asks
 * which module reads its variable.
 */
export const IN_DEPLOYMENT_SERVICES = {
    'doc-parser': 'DOC_PARSER_BASE_URL',
    'ai-guard-nemo': 'AI_GUARD_NEMO_BASE_URL',
    embed: 'AI_EMBED_LOCAL_BASE_URL',
    rerank: 'AI_RERANK_LOCAL_BASE_URL',
    'pii-detector': 'AI_PII_BASE_URL',
} as const;

export type InDeploymentService = keyof typeof IN_DEPLOYMENT_SERVICES;

// ═══════════════════════════════════════════════════════════════════════════
//  The address rule
// ═══════════════════════════════════════════════════════════════════════════

export type PerimeterRefusal =
    /** The base URL does not parse. */
    | 'MALFORMED_URL'
    /** Neither `http:` nor `https:`. */
    | 'SCHEME_NOT_HTTP'
    /** The URL carries a user name or password. */
    | 'CREDENTIALS_IN_URL'
    /** A cloud-metadata hostname, refused by name. */
    | 'METADATA_HOST'
    /** A literal, or a resolved, address outside the deployment. */
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
 * True only for an IP literal inside the deployment. A hostname is never
 * inside on its own; it is judged by what it resolves to.
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
 * resolves to must be inside. The dial pins its connection to the returned
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

// ═══════════════════════════════════════════════════════════════════════════
//  The dial
// ═══════════════════════════════════════════════════════════════════════════

export type InDeploymentFailure =
    /** The URL, or an address it resolves to, is not inside the deployment. Nothing was sent. */
    | 'OUTSIDE_DEPLOYMENT'
    /** DNS failed or returned nothing — the service is not there (a stopped container is NXDOMAIN). */
    | 'UNRESOLVABLE'
    /** The service answered 3xx. Not followed. */
    | 'REDIRECT_REFUSED'
    /** The deadline passed before the body was read. */
    | 'TIMEOUT'
    /** The caller's signal aborted the call. */
    | 'ABORTED'
    /** A non-2xx answer; `status` carries it and the body is discarded unread. */
    | 'HTTP_STATUS'
    /** The body passed the byte cap; the read was cancelled there. */
    | 'RESPONSE_TOO_LARGE'
    /** The socket failed. */
    | 'NETWORK_ERROR';

export type InDeploymentResponse =
    | { readonly ok: true; readonly status: number; readonly contentType: string | null; readonly text: string }
    | {
          readonly ok: false;
          readonly reason: InDeploymentFailure;
          readonly status?: number;
          /** For `OUTSIDE_DEPLOYMENT`: which structural or resolution rule refused. */
          readonly refusal?: PerimeterRefusal;
      };

export interface InDeploymentRequest {
    readonly method: 'GET' | 'POST';
    readonly headers?: Readonly<Record<string, string>>;
    /** The request body, for POST only. */
    readonly body?: string;
}

export interface InDeploymentBounds {
    /** One deadline over DNS, the response head and the body read. ≤ 0 sends nothing. */
    readonly deadlineMs: number;
    /** The largest body read; the read is cancelled when it is passed. */
    readonly maxResponseBytes: number;
    /** The caller's own cancellation, combined with the deadline. */
    readonly signal?: AbortSignal;
}

class Stopped extends Error {
    constructor(readonly reason: 'TIMEOUT' | 'ABORTED') {
        super(reason);
    }
}

/** Why {@link pinnedFetch} sent nothing. */
class PerimeterRefused extends Error {
    constructor(readonly refusal: PerimeterRefusal) {
        super(refusal);
    }
}

class RedirectRefused extends Error {
    constructor(readonly status: number) {
        super(`redirect ${status}`);
    }
}

/**
 * Resolve, require every address inside the deployment, pin the connection to
 * those addresses, refuse a redirect. The hostname is kept in the URL for TLS
 * SNI and certificate checks when the scheme is https.
 */
async function pinnedFetch(url: string, init: RequestInit): Promise<Response> {
    const resolved = await resolvePerimeterAddresses(url);
    if (!resolved.ok) throw new PerimeterRefused(resolved.reason);
    const pinned = resolved.addresses.map((a) => ({ address: a.address, family: a.family }));
    const dispatcher = new Agent({
        // Short-lived: this Agent serves only this one pinned request.
        keepAliveTimeout: 1,
        keepAliveMaxTimeout: 1,
        connect: {
            lookup: (
                _hostname: string,
                _options: unknown,
                cb: (err: NodeJS.ErrnoException | null, addrs: { address: string; family: number }[]) => void,
            ) => {
                cb(null, pinned);
            },
        },
    } as unknown as ConstructorParameters<typeof Agent>[0]);
    const res = (await undiciFetch(url, {
        ...init,
        // Applied after the spread so no caller can opt back into following.
        redirect: 'manual',
        dispatcher,
    } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        throw new RedirectRefused(res.status);
    }
    return res;
}

/** Resolves to the body text, or `null` when it passed `cap` (reading stops there). */
async function readCapped(res: Response, cap: number): Promise<string | null> {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > cap) {
        await res.body?.cancel().catch(() => undefined);
        return null;
    }
    const stream = res.body;
    if (!stream) return '';
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let out = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
}

/**
 * The ONE dial to an in-deployment service. `service` names which of
 * {@link IN_DEPLOYMENT_SERVICES} is being reached — the URL must be that
 * service's operator value, which is what the guard holds by permitting this
 * call only in the registered client modules, each constructed only by its
 * variable's one reader.
 */
export async function inDeploymentRequest(
    service: InDeploymentService,
    url: string,
    request: InDeploymentRequest,
    bounds: InDeploymentBounds,
): Promise<InDeploymentResponse> {
    void service; // Named at every call site for the reader; the rule is the same for each.
    if (!(bounds.deadlineMs > 0)) return { ok: false, reason: 'TIMEOUT' };
    const deadline = AbortSignal.timeout(bounds.deadlineMs);
    const signal = bounds.signal ? AbortSignal.any([deadline, bounds.signal]) : deadline;
    const why = (): 'TIMEOUT' | 'ABORTED' => (bounds.signal?.aborted && !deadline.aborted ? 'ABORTED' : 'TIMEOUT');

    if (signal.aborted) return { ok: false, reason: why() };
    let rejectStopped: (err: Stopped) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
        rejectStopped = reject;
    });
    const onAbort = () => rejectStopped(new Stopped(why()));
    signal.addEventListener('abort', onAbort, { once: true });
    // `stopped` may reject after the call has finished; that rejection is
    // handled here so it never surfaces as an unhandled one.
    stopped.catch(() => undefined);

    try {
        // DNS cannot be aborted by a signal, so every await races `stopped`:
        // the deadline covers resolution, the response head and the body.
        const res = await Promise.race([
            pinnedFetch(url, {
                method: request.method,
                headers: { ...request.headers },
                body: request.body,
                signal,
            }),
            stopped,
        ]);
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            return { ok: false, reason: 'HTTP_STATUS', status: res.status };
        }
        const text = await Promise.race([readCapped(res, bounds.maxResponseBytes), stopped]);
        if (text === null) return { ok: false, reason: 'RESPONSE_TOO_LARGE', status: res.status };
        return { ok: true, status: res.status, contentType: res.headers.get('content-type'), text };
    } catch (err) {
        if (err instanceof Stopped) return { ok: false, reason: err.reason };
        if (err instanceof PerimeterRefused) {
            return err.refusal === 'UNRESOLVABLE'
                ? { ok: false, reason: 'UNRESOLVABLE', refusal: err.refusal }
                : { ok: false, reason: 'OUTSIDE_DEPLOYMENT', refusal: err.refusal };
        }
        if (err instanceof RedirectRefused) return { ok: false, reason: 'REDIRECT_REFUSED', status: err.status };
        if (signal.aborted) return { ok: false, reason: why() };
        return { ok: false, reason: 'NETWORK_ERROR' };
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}
