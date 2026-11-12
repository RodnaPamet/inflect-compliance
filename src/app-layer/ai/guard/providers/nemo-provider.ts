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
 *   - **`safeFetch` in an EXPLICIT branch**, never `fetchImpl ?? safeFetch`, so
 *     `tests/guards/ssrf-egress-coverage.test.ts` has a literal call to find
 *     and exactly one path reaches the network unprotected: the test seam. No
 *     file under `src/` passes `fetchImpl`; `registry.ts` passes the base URL
 *     alone.
 *   - **https or nothing, decided here from the URL, above the test seam.**
 *     The base URL is operator config (`AI_GUARD_NEMO_BASE_URL`, read only by
 *     `registry.ts`), never tenant-writable (G6). `safeFetch` also refuses a
 *     private address unless the self-hosted egress allowlist admits it — see
 *     the implementation note for what that means for an in-Compose server.
 *   - **One deadline over the request AND the body, and a byte cap that ABORTS
 *     the read.** Never `res.json()` then a length check.
 *   - **Rule ids carry no content.** A rail's name is reduced to `[a-z0-9_]`
 *     and capped before it becomes `rail.<name>` (namespaced `nemo.` by
 *     `compose.ts`).
 */
import { safeFetch } from '@/app-layer/automation/webhook-safety';
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
    | 'EGRESS_REFUSED'
    | 'TIMEOUT'
    | 'HTTP_ERROR'
    | 'TOO_LARGE'
    | 'NOT_JSON'
    | 'UNRECOGNISED_RESPONSE';

export interface NemoProviderOptions {
    /** The server's base URL, e.g. `https://nemo-guardrails.internal:8000`. */
    readonly baseUrl: string;
    readonly timeoutMs?: number;
    /** Test seam. The ONLY path that reaches the network unprotected. No caller under `src/` passes one. */
    readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/** What the NeMo rail type for each direction is called. */
const RAIL_TYPE: Record<GuardScanKind, 'input' | 'output'> = { input: 'input', egress: 'output' };

class CapExceeded extends Error {}

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
    if (parsed.protocol !== 'https:') return { ok: false, reason: 'SCHEME_REFUSED' };
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

async function readCapped(res: Response, controller: AbortController): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > NEMO_MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new CapExceeded();
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
        if (total > NEMO_MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => undefined);
            controller.abort();
            throw new CapExceeded();
        }
        out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
}

async function ask(opts: NemoProviderOptions, kind: GuardScanKind, content: unknown): Promise<Outcome> {
    const endpoint = nemoEndpoint(opts.baseUrl);
    if (!endpoint.ok) return endpoint;

    const subject = textOf(kind, content);
    if ('reason' in subject) return { ok: false, reason: subject.reason };
    // Nothing to scan is clean here exactly as it is for the patterns provider.
    if (subject.text === null) return { ok: true, scan: { verdict: 'clean', ruleIds: [] } };

    const body = requestBody(kind, subject.text);
    if (Buffer.byteLength(body, 'utf8') > NEMO_MAX_REQUEST_BYTES) return { ok: false, reason: 'REQUEST_TOO_LARGE' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? NEMO_TIMEOUT_MS);
    try {
        const init: RequestInit = {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body,
            signal: controller.signal,
        };
        let res: Response;
        try {
            res = opts.fetchImpl ? await opts.fetchImpl(endpoint.url, init) : await safeFetch(endpoint.url, init);
        } catch {
            return { ok: false, reason: controller.signal.aborted ? 'TIMEOUT' : 'EGRESS_REFUSED' };
        }
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            return { ok: false, reason: 'HTTP_ERROR' };
        }
        let text: string;
        try {
            text = await readCapped(res, controller);
        } catch (e) {
            if (e instanceof CapExceeded) return { ok: false, reason: 'TOO_LARGE' };
            return { ok: false, reason: controller.signal.aborted ? 'TIMEOUT' : 'EGRESS_REFUSED' };
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return { ok: false, reason: 'NOT_JSON' };
        }
        return parseNemoVerdict(kind, parsed);
    } finally {
        clearTimeout(timer);
    }
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
                outcome = { ok: false, reason: 'EGRESS_REFUSED' };
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
