/**
 * `boundedFetch` — every outbound integration call gets a deadline.
 *
 * ## What was wrong
 *
 * Across the whole integrations layer there were exactly two bounded calls: the
 * Powerpipe `execFile` (15 min, 64 MB) and the Active Directory LDAP client
 * (30 s). Every HTTP provider — Okta, Google Workspace, Entra ID, BambooHR,
 * GitHub, SharePoint — issued a plain `fetch` with no `AbortSignal`.
 *
 * A remote that black-holes a connection therefore holds a BullMQ worker slot
 * until the stalled-job timeout fires. That is not a per-tenant problem: the
 * dispatchers fan out across tenants onto a shared worker pool, so ONE hung
 * directory starves every other tenant's sync queued behind it. With
 * `MAX_USERS = 5000` paginated across many requests, a slow remote does not
 * even need to hang — it only needs to be slow enough, often enough.
 *
 * ## Why this is a helper and not a base class
 *
 * The roadmap suggested routing everything through `base-client.ts`. That is
 * not the shared seam: only the GitHub and SharePoint clients extend
 * `BaseIntegrationClient`. The identity and HRIS providers each take an
 * injectable `deps.fetchImpl ?? fetch`, which is a different and perfectly good
 * pattern that exists for testability.
 *
 * So the bound goes where the default goes. Every provider swaps its `?? fetch`
 * for `?? boundedFetch`, keeps its injection point, and no provider is forced
 * into a class hierarchy it does not use. A test that injects its own fetch
 * still bypasses this entirely — which is what makes the timeout itself
 * testable.
 *
 * ## The two timeouts
 *
 * `DEFAULT_TIMEOUT_MS` (30 s) matches the deliberate AD LDAP bound, so a single
 * request has one answer across the layer regardless of transport.
 *
 * `ENUMERATION_TIMEOUT_MS` (120 s) is for a single page of a paginated
 * enumeration, where the remote is doing real work per page. It is per REQUEST,
 * not per enumeration — an enumeration of 50 pages gets 50 separate deadlines,
 * because a per-enumeration budget would make the failure depend on how far
 * through the directory the slow page happened to fall.
 *
 * @see tests/unit/integrations-bounded-fetch.test.ts
 */
import { logger } from '@/lib/observability/logger';

/** One ordinary API call. Matches the AD LDAP bound so the layer is coherent. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** One PAGE of a paginated enumeration — the remote is doing more work. */
export const ENUMERATION_TIMEOUT_MS = 120_000;

/**
 * Thrown when OUR deadline fired, as distinct from the caller aborting or the
 * socket dying.
 *
 * The distinction is load-bearing for the retry layer: a timeout is retryable
 * (the remote may be transiently slow), a caller abort is not (someone asked us
 * to stop), and conflating them would have a shutdown re-queue work.
 */
export class IntegrationTimeoutError extends Error {
    readonly timeoutMs: number;
    readonly url: string;
    /** Marks this as retryable for the classifier, without importing it. */
    readonly retryable = true;

    constructor(url: string, timeoutMs: number) {
        super(`Integration request exceeded ${timeoutMs}ms: ${url}`);
        this.name = 'IntegrationTimeoutError';
        this.timeoutMs = timeoutMs;
        this.url = url;
    }
}

/**
 * Host + path only — a full URL can carry a token in the query string.
 *
 * Exported because every integration error message that names a URL must go
 * through here. `http-resilience.ts` persists its auth-failure message to
 * `IntegrationConnection.authFailureReason` and shows it in the UI, so a raw
 * `input.url` there would write an access token into the database.
 */
export function safeUrl(input: RequestInfo | URL): string {
    try {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const u = new URL(raw);
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return '<unparseable-url>';
    }
}

/**
 * Build a `fetch` that aborts after `timeoutMs`.
 *
 * A caller-supplied `init.signal` is COMBINED with the deadline rather than
 * replaced — dropping it would silently break cancellation for anyone already
 * passing one, which is the kind of regression a timeout helper has no business
 * introducing.
 */
export function createBoundedFetch(timeoutMs: number = DEFAULT_TIMEOUT_MS): typeof fetch {
    return async function boundedFetchImpl(input, init) {
        const deadline = AbortSignal.timeout(timeoutMs);
        const signal = init?.signal
            ? AbortSignal.any([init.signal, deadline])
            : deadline;

        try {
            return await fetch(input, { ...init, signal });
        } catch (err) {
            // `AbortSignal.timeout` rejects with a TimeoutError DOMException.
            // Only OUR deadline produces that; a caller abort surfaces as
            // AbortError and is deliberately left to propagate unchanged.
            //
            // Checked by `.name`, NOT `instanceof Error`: Node's DOMException
            // does not reliably inherit from Error, so an instanceof guard
            // silently lets every timeout through unwrapped — which is how a
            // deadline stops being retryable without anything failing.
            if (
                typeof err === 'object' &&
                err !== null &&
                (err as { name?: unknown }).name === 'TimeoutError'
            ) {
                const url = safeUrl(input);
                logger.warn('integration request timed out', {
                    component: 'integrations',
                    url,
                    timeoutMs,
                });
                throw new IntegrationTimeoutError(url, timeoutMs);
            }
            throw err;
        }
    };
}

/**
 * The default bound. Providers use this in place of bare `fetch`:
 *
 *     const doFetch = this.deps.fetchImpl ?? boundedFetch;
 */
export const boundedFetch: typeof fetch = createBoundedFetch();

/** Per-page bound for paginated enumeration. */
export const enumerationFetch: typeof fetch = createBoundedFetch(ENUMERATION_TIMEOUT_MS);
