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
 * So the bound goes where the default goes: every provider swaps its `?? fetch`
 * for a hardened default, keeps its injection point, and no provider is forced
 * into a class hierarchy it does not use.
 *
 * That default is `resilientFetch`, NOT `boundedFetch` — this file used to say
 * otherwise and the example was wrong. `http-resilience.ts` composes
 * `createResilientFetch` OVER `createBoundedFetch`, so a provider reads:
 *
 *     const doFetch = this.deps.fetchImpl ?? resilientFetch;
 *
 * and gets the deadline here PLUS 429/Retry-After handling. Wiring a provider
 * to `boundedFetch` directly still bounds the request but silently drops the
 * throttle handling, which is why
 * `tests/guards/integrations-bounded-fetch-coverage.test.ts` bans it outright.
 *
 * A test that injects its own fetch bypasses BOTH layers — which is what makes
 * the timeout itself testable, and also why the stress suite injects a composed
 * real stack rather than a bare fake.
 *
 * ## One timeout, deliberately
 *
 * `DEFAULT_TIMEOUT_MS` (30 s) matches the deliberate AD LDAP bound, so a single
 * request has one answer across the layer regardless of transport. It is per
 * REQUEST, not per enumeration — a 50-page enumeration gets 50 separate
 * deadlines, because a per-enumeration budget would make the failure depend on
 * how far through the directory the slow page happened to fall.
 *
 * There used to be a second bound here, `ENUMERATION_TIMEOUT_MS` (120 s), for
 * "a page where the remote is doing real work". It was removed because it never
 * had a consumer: it shipped with this file, and the PR that gave providers
 * their hardened default wired them to `resilientFetch` (30 s) without ever
 * reaching for it. A longer bound that nothing uses is worse than no bound —
 * the prose asserts a two-tier design the code does not implement, and the next
 * reader believes it.
 *
 * Bring it back when there is EVIDENCE rather than a hypothesis: an
 * `IntegrationTimeoutError` naming a page that genuinely needed longer. The
 * error carries the host, path and the budget it blew, so the real number will
 * be observable instead of guessed.
 *
 * @see tests/unit/integrations-bounded-fetch.test.ts
 */
import { logger } from '@/lib/observability/logger';

/** One ordinary API call. Matches the AD LDAP bound so the layer is coherent. */
export const DEFAULT_TIMEOUT_MS = 30_000;


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
 * The default bound.
 *
 * NOT what providers use directly — `http-resilience.ts` wraps this as
 * `resilientFetch`, and that is the provider default. Wiring a provider to
 * `boundedFetch` bounds the request but loses 429/Retry-After handling, which
 * `tests/guards/integrations-bounded-fetch-coverage.test.ts` rejects.
 */
export const boundedFetch: typeof fetch = createBoundedFetch();

