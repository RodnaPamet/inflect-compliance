/**
 * AI Guard — the `nemo` provider: an HTTP client for a NeMo Guardrails server
 * (NeMo Guardrails roadmap, Phase 1.1 and 1.4).
 *
 * The server is ASKED FOR A VERDICT and never for an answer. Each scan is one
 * `POST {base}/v1/chat/completions` naming the repository's rails config
 * (`NEMO_RAILS_CONFIG_ID`) with `options.rails` restricted to the one rail
 * type that applies — `input` for content entering a model, `output` for
 * content leaving — and `options.log.activated_rails` on. The response's
 * generated message is ignored entirely; the only thing read is whether an
 * activated rail of that type STOPPED the exchange. The rails config carries
 * no `models:` entry in Phase 1, so the server makes no model call (D-L1-2:
 * LLM-free rails first).
 *
 * Rules, each held by `tests/unit/ai/guard-nemo-provider.test.ts`:
 *
 *   - **Outage degrades to flag, in both directions, never to allow.**
 *     Every failure — refused egress, timeout, non-2xx, oversized or unparsable
 *     body, a response shape this client does not recognise, content it could
 *     not serialise — returns `providerUnavailable('nemo', kind)` and logs the
 *     reason (never the content). Unrecognised is not clean.
 *   - **The in-deployment rule, not `safeFetch`** (G6 as amended 2026-11-12).
 *     The server is one WE run inside the deployment, so the request goes
 *     through `inDeploymentRequest` (`src/lib/ai/in-deployment-service.ts`):
 *     http or https, every address the host resolves to inside the deployment
 *     (RFC 1918, loopback, IPv6 ULA) with the connection pinned to them, no
 *     redirect followed. A public address is REFUSED before anything is sent
 *     (`EGRESS_REFUSED`) — a guard server outside the deployment would be a
 *     sub-processor receiving tenant text. Behind `safeFetch` the opposite
 *     held: an in-Compose server was refused on every scan.
 *   - **No fetch seam.** This file makes no fetch call and takes no
 *     `fetchImpl`; tests mock `undici` and `node:dns`, so the address rule runs
 *     in every test. `tests/guards/ssrf-egress-coverage.test.ts` holds both.
 *   - **The base URL is operator config** (`AI_GUARD_NEMO_BASE_URL`, read only
 *     by `registry.ts`), never tenant-writable (G6).
 *   - **One deadline over the request AND the body, and a byte cap that ABORTS
 *     the read.** Both are the shared dial's; never `res.json()` then a length
 *     check.
 *   - **Rule ids carry no content.** A rail's name is reduced to `[a-z0-9_]`
 *     and capped before it becomes `rail.<name>` (namespaced `nemo.` by
 *     `compose.ts`).
 */
import { checkPerimeterUrl, inDeploymentRequest, type InDeploymentFailure } from '@/lib/ai/in-deployment-service';
import { logger } from '@/lib/observability/logger';
import type { ScanResult } from '../injection-scanner';
import { providerUnavailable } from './compose';
import type { GuardProvider, GuardProviderContext, GuardScanKind } from './types';

export const NEMO_PROVIDER_ID = 'nemo';

/** The rails config the server serves from `guards/nemo/config/` (repo-reviewed, Phase 1.3). */
export const NEMO_RAILS_CONFIG_ID = 'inflect-llm-free';

/** The NeMo Guardrails server's chat endpoint, which runs the requested rails. */
export const NEMO_CHECK_PATH = '/v1/chat/completions';

/** Request and body together. The guard runs inline on every tool call, so this is short. */
export const NEMO_TIMEOUT_MS = 3_000;

/** Above this the content is not sent, and the scan is unavailable rather than clean. */
export const NEMO_MAX_REQUEST_BYTES = 1_048_576;

/** A verdict response is small; a body past this is refused while it is read. */
export const NEMO_MAX_RESPONSE_BYTES = 65_536;

export type NemoScanFailure =
    | 'CONFIG_INVALID'
    | 'SCHEME_REFUSED'
    | 'REQUEST_UNSERIALISABLE'
    | 'REQUEST_TOO_LARGE'
    /** The URL, or an address it resolves to, is outside the deployment; or a redirect. Nothing scanned. */
    | 'EGRESS_REFUSED'
    /** The host did not resolve, or the socket failed: nothing answered. */
    | 'UNREACHABLE'
    | 'TIMEOUT'
    | 'HTTP_ERROR'
    | 'TOO_LARGE'
    | 'NOT_JSON'
    | 'UNRECOGNISED_RESPONSE';

export interface NemoProviderOptions {
    /** The server's base URL inside the deployment, e.g. `http://nemo-guardrails:8000`. */
    readonly baseUrl: string;
    readonly timeoutMs?: number;
}

/** What the NeMo rail type for each direction is called. */
const RAIL_TYPE: Record<GuardScanKind, 'input' | 'output'> = { input: 'input', egress: 'output' };

type Outcome = { readonly ok: true; readonly scan: ScanResult } | { readonly ok: false; readonly reason: NemoScanFailure };

/** The endpoint for a base URL, or the reason it cannot be one. */
export function nemoEndpoint(baseUrl: string): { ok: true; url: string } | { ok: false; reason: NemoScanFailure } {
    let parsed: URL;
    try {
        parsed = new URL(baseUrl.trim());
    } catch {
        return { ok: false, reason: 'CONFIG_INVALID' };
    }
    // Credentials in the URL would be logged by any tool that prints it; the
    // server is reached on the network boundary, not by an embedded secret.
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        return { ok: false, reason: 'CONFIG_INVALID' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'SCHEME_REFUSED' };
    // The structural half of the in-deployment rule, asked once here: a public
    // literal or a metadata host is refused as configuration, before any
    // content is prepared. A NAME is judged by what it resolves to, at the dial.
    if (!checkPerimeterUrl(parsed.href).ok) return { ok: false, reason: 'EGRESS_REFUSED' };
    const base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    return { ok: true, url: `${base}${NEMO_CHECK_PATH}` };
}

/** The text to scan, `null` when there is nothing to scan, or a failure. */
function textOf(kind: GuardScanKind, content: unknown): { text: string | null } | { reason: NemoScanFailure } {
    if (typeof content === 'string') return { text: content.length > 0 ? content : null };
    // Input is text or nothing — the patterns provider treats a non-string the same way.
    if (kind === 'input' || content === null || content === undefined) return { text: null };
    try {
        const serialised: unknown = JSON.stringify(content);
        return { text: typeof serialised === 'string' && serialised.length > 0 ? serialised : null };
    } catch {
        return { reason: 'REQUEST_UNSERIALISABLE' };
    }
}

function requestBody(kind: GuardScanKind, text: string): string {
    const messages =
        kind === 'input'
            ? [{ role: 'user', content: text }]
            : [
                  { role: 'user', content: '' },
                  { role: 'assistant', content: text },
              ];
    return JSON.stringify({
        config_id: NEMO_RAILS_CONFIG_ID,
        messages,
        options: { rails: [RAIL_TYPE[kind]], log: { activated_rails: true } },
    });
}

/** `rail.<name>` with the name reduced to a safe, bounded token. */
export function railRuleId(name: string): string {
    const token = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
    return `rail.${token || 'unnamed'}`;
}

/**
 * Read the verdict out of a NeMo Guardrails response. Strict: anything that is
 * not an object with `log.activated_rails` as an array of `{ type, name }`
 * entries is unrecognised, and unrecognised fails closed.
 */
export function parseNemoVerdict(kind: GuardScanKind, body: unknown): Outcome {
    if (!body || typeof body !== 'object') return { ok: false, reason: 'UNRECOGNISED_RESPONSE' };
    const log = (body as { log?: unknown }).log;
    if (!log || typeof log !== 'object') return { ok: false, reason: 'UNRECOGNISED_RESPONSE' };
    const rails = (log as { activated_rails?: unknown }).activated_rails;
    if (!Array.isArray(rails)) return { ok: false, reason: 'UNRECOGNISED_RESPONSE' };

    const ruleIds: string[] = [];
    for (const rail of rails) {
        if (!rail || typeof rail !== 'object') return { ok: false, reason: 'UNRECOGNISED_RESPONSE' };
        const { type, name, stop } = rail as { type?: unknown; name?: unknown; stop?: unknown };
        if (typeof type !== 'string' || typeof name !== 'string') {
            return { ok: false, reason: 'UNRECOGNISED_RESPONSE' };
        }
        if (stop !== undefined && typeof stop !== 'boolean') return { ok: false, reason: 'UNRECOGNISED_RESPONSE' };
        if (type === RAIL_TYPE[kind] && stop === true) {
            const id = railRuleId(name);
            if (!ruleIds.includes(id)) ruleIds.push(id);
        }
    }
    if (ruleIds.length === 0) return { ok: true, scan: { verdict: 'clean', ruleIds: [] } };
    return { ok: true, scan: { verdict: 'malicious', ruleIds, maxSeverity: 'high' } };
}

/** The dial's failure → this provider's reason. Every one of them fails closed. */
const DIAL_FAILURE: Record<InDeploymentFailure, NemoScanFailure> = {
    OUTSIDE_DEPLOYMENT: 'EGRESS_REFUSED',
    REDIRECT_REFUSED: 'EGRESS_REFUSED',
    UNRESOLVABLE: 'UNREACHABLE',
    NETWORK_ERROR: 'UNREACHABLE',
    TIMEOUT: 'TIMEOUT',
    ABORTED: 'TIMEOUT',
    HTTP_STATUS: 'HTTP_ERROR',
    RESPONSE_TOO_LARGE: 'TOO_LARGE',
};

async function ask(opts: NemoProviderOptions, kind: GuardScanKind, content: unknown): Promise<Outcome> {
    const endpoint = nemoEndpoint(opts.baseUrl);
    if (!endpoint.ok) return endpoint;

    const subject = textOf(kind, content);
    if ('reason' in subject) return { ok: false, reason: subject.reason };
    // Nothing to scan is clean here exactly as it is for the patterns provider.
    if (subject.text === null) return { ok: true, scan: { verdict: 'clean', ruleIds: [] } };

    const body = requestBody(kind, subject.text);
    if (Buffer.byteLength(body, 'utf8') > NEMO_MAX_REQUEST_BYTES) return { ok: false, reason: 'REQUEST_TOO_LARGE' };

    const res = await inDeploymentRequest(
        'ai-guard-nemo',
        endpoint.url,
        { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body },
        { deadlineMs: opts.timeoutMs ?? NEMO_TIMEOUT_MS, maxResponseBytes: NEMO_MAX_RESPONSE_BYTES },
    );
    if (!res.ok) return { ok: false, reason: DIAL_FAILURE[res.reason] };
    let parsed: unknown;
    try {
        parsed = JSON.parse(res.text);
    } catch {
        return { ok: false, reason: 'NOT_JSON' };
    }
    return parseNemoVerdict(kind, parsed);
}

/**
 * Build the `nemo` provider. Called only by `registry.ts`, and only when
 * `AI_GUARD_NEMO_BASE_URL` is set — absent config constructs nothing (G9).
 */
export function createNemoGuardProvider(opts: NemoProviderOptions): GuardProvider {
    return {
        id: NEMO_PROVIDER_ID,
        remote: true,
        async scan(kind, content, ctx: GuardProviderContext) {
            let outcome: Outcome;
            try {
                outcome = await ask(opts, kind, content);
            } catch {
                // The dial never throws; anything here is a defect, and a defect fails closed.
                outcome = { ok: false, reason: 'UNREACHABLE' };
            }
            if (outcome.ok) return outcome.scan;
            // The reason only — never the content, never the URL.
            logger.warn('ai-guard: nemo provider unavailable, failing closed', {
                requestId: ctx.requestId,
                tenantId: ctx.tenantId,
                direction: kind,
                reason: outcome.reason,
            });
            return providerUnavailable(NEMO_PROVIDER_ID, kind);
        },
    };
}
