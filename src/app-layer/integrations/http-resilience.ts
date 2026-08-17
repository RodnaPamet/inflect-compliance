/**
 * Rate-limit handling, and keeping BullMQ from making it worse.
 *
 * ## The amplification
 *
 * There was no 429 or `Retry-After` handling anywhere in the integrations
 * layer, and Okta, Microsoft Graph and Google Workspace all throttle
 * aggressively and all send `Retry-After`. A 429 surfaced as a generic failure,
 * and the queue's defaults (`attempts: 3`, exponential 5 s — `jobs/queue.ts`)
 * then retried the WHOLE sync three times inside ~35 seconds.
 *
 * That is the exact opposite of what being throttled asks for. A soft throttle
 * answered with three full re-enumerations is how you earn a hard block.
 *
 * So this module has two halves, and the second is the one that matters:
 *
 *   1. absorb SHORT throttles in-process, honouring `Retry-After`;
 *   2. make a throttle that outlasts our budget end the job in a way BullMQ
 *      will NOT immediately re-run.
 *
 * Without (2), (1) just moves the amplification one layer down.
 *
 * ## Terminal vs retryable
 *
 * A revoked token retried three times with backoff is wasted work that delays
 * every other tenant behind it in the fan-out. 401/403/404 are terminal: no
 * amount of waiting fixes a credential someone deleted, or a group someone did.
 * 429/502/503/504 and a timeout are transient by nature.
 *
 * But "do not retry" and "the credential is bad" are NOT the same claim, and
 * H1-3 marks a connection as credential-revoked in the UI. So the terminal set
 * is split: 401/403 throw `IntegrationAuthError`, 404 throws the plain
 * `IntegrationTerminalError`. Both stop the retry loop; only the first should
 * ever accuse a credential. Marking a connection revoked because one group went
 * missing is the false alarm that teaches operators to ignore the banner.
 *
 * @see tests/unit/integrations-http-resilience.test.ts
 */
import { logger } from '@/lib/observability/logger';
import { boundedFetch, safeUrl, IntegrationTimeoutError } from './bounded-fetch';

/** How a failure should be treated by the caller and by the queue. */
export type FailureKind = 'retryable' | 'terminal';

/** Longest `Retry-After` we will absorb in-process before giving the tick back. */
export const MAX_ABSORBED_RETRY_AFTER_MS = 60_000;

/** Attempts INSIDE one call, including the first. */
export const MAX_HTTP_ATTEMPTS = 3;

/**
 * Retrying cannot help, but the CREDENTIAL is not implicated.
 *
 * A 404 is the motivating case: a group someone deleted, a drive that moved.
 * Retrying is pointless, so it must not retry — but H1-3 marks a connection as
 * credential-revoked, and doing that because one resource went missing is a
 * false alarm of the kind that teaches operators to ignore the banner.
 */
export class IntegrationTerminalError extends Error {
    readonly status: number;
    readonly kind: FailureKind = 'terminal';

    constructor(status: number, url: string) {
        super(`Integration request failed terminally (${status}): ${url}`);
        this.name = 'IntegrationTerminalError';
        this.status = status;
    }
}

/**
 * The credential is bad. Waiting will not help; the connection needs attention.
 *
 * Deliberately NARROWER than "terminal" — only 401/403. H1-3 keys the
 * connection-revoked state on this class, not on `kind`, so that widening the
 * terminal set later cannot silently start accusing working credentials.
 */
export class IntegrationAuthError extends IntegrationTerminalError {
    constructor(status: number, url: string) {
        super(status, url);
        this.name = 'IntegrationAuthError';
        this.message = `Integration auth failed (${status}): ${url}`;
    }
}

/**
 * Throttled for longer than we are willing to hold a worker.
 *
 * Carries `retryAfterMs` so the job layer can say WHEN rather than just that it
 * failed — and so a metric can show throttle pressure rather than a generic
 * error rate.
 */
export class IntegrationRateLimitedError extends Error {
    readonly retryAfterMs: number | null;
    readonly kind: FailureKind = 'retryable';

    constructor(url: string, retryAfterMs: number | null) {
        super(
            retryAfterMs == null
                ? `Rate limited with no Retry-After: ${url}`
                : `Rate limited for ${retryAfterMs}ms: ${url}`,
        );
        this.name = 'IntegrationRateLimitedError';
        this.retryAfterMs = retryAfterMs;
    }
}

/** Statuses where retrying the same request can plausibly succeed. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/** The credential itself is bad. Narrow on purpose — see IntegrationAuthError. */
const AUTH_STATUS = new Set([401, 403]);
/** Retrying cannot help, but the credential is not implicated. */
const TERMINAL_STATUS = new Set([404]);

/** Classify an HTTP status. `null` means "not a failure". */
export function classifyStatus(status: number): FailureKind | null {
    if (RETRYABLE_STATUS.has(status)) return 'retryable';
    if (AUTH_STATUS.has(status) || TERMINAL_STATUS.has(status)) return 'terminal';
    return status >= 500 ? 'retryable' : null;
}

/** True only for the statuses that mean the credential is bad. */
export function isAuthStatus(status: number): boolean {
    return AUTH_STATUS.has(status);
}

/** Classify a thrown error. Unknown throws are retryable — a network blip is the common case. */
export function classifyError(err: unknown): FailureKind {
    // IntegrationAuthError extends IntegrationTerminalError, so this one check
    // covers both.
    if (err instanceof IntegrationTerminalError) return 'terminal';
    if (err instanceof IntegrationTimeoutError) return 'retryable';
    if (err instanceof IntegrationRateLimitedError) return 'retryable';
    return 'retryable';
}

/**
 * Should the QUEUE skip its own retry for this error?
 *
 * `jobs/queue.ts` retries 3× with exponential 5 s backoff — three full re-syncs
 * inside ~35 seconds. That is the right default for a transient blip and the
 * wrong one for both integration failure modes:
 *
 *   - terminal: a revoked credential will fail identically three more times,
 *     while occupying a worker slot the rest of the fan-out is queued behind;
 *   - rate-limited: we only reach here when the throttle outlasts what we were
 *     willing to absorb in-process, so a 5 s retry is guaranteed-fail work that
 *     also answers a throttle with more load — the amplification, one layer down.
 *
 * Both end the job as FAILED — this suppresses the immediate re-run, not the
 * failure record. The next scheduled tick picks the work up.
 */
export function shouldBypassQueueRetry(err: unknown): boolean {
    return err instanceof IntegrationTerminalError || err instanceof IntegrationRateLimitedError;
}

/**
 * Parse `Retry-After`, which RFC 9110 allows in TWO forms: delta-seconds, or an
 * HTTP-date. Handling only the integer form silently ignores the date form and
 * falls back to blind backoff against a server that told us exactly when to
 * return — which is the failure this module exists to avoid.
 *
 * @returns milliseconds, or null when absent/unparseable/in the past.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
    if (!header) return null;
    const trimmed = header.trim();

    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;

    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    const delta = at - now;
    return delta > 0 ? delta : null;
}

/** Full jitter: uniform in [0, base]. Prevents a fan-out retrying in lockstep. */
function jitteredBackoff(attempt: number, rand: () => number): number {
    const base = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
    return Math.floor(rand() * base);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ResilientFetchOptions {
    maxAttempts?: number;
    maxAbsorbedRetryAfterMs?: number;
    /** Injectable for tests — the module must not reach for Math.random directly. */
    rand?: () => number;
    /** Injectable for tests, so a backoff can be asserted without sleeping. */
    sleepImpl?: (ms: number) => Promise<void>;
    /** The underlying fetch. Defaults to the BOUNDED one — never bare fetch. */
    fetchImpl?: typeof fetch;
}

/**
 * A `fetch` that absorbs short throttles and refuses to absorb long ones.
 *
 * Retries 429/5xx up to `maxAttempts`, honouring `Retry-After` when the server
 * sends one and using jittered exponential backoff when it does not. A
 * `Retry-After` longer than `maxAbsorbedRetryAfterMs` is NOT waited out —
 * holding a worker idle for five minutes starves the fan-out just as
 * effectively as a hung socket. It throws `IntegrationRateLimitedError`
 * instead, so the tick ends and the next scheduled run picks the work up.
 *
 * 401/403/404 throw `IntegrationAuthError` on the FIRST response — retrying a
 * revoked credential is pure delay for every tenant behind it.
 */
export function createResilientFetch(opts: ResilientFetchOptions = {}): typeof fetch {
    const maxAttempts = opts.maxAttempts ?? MAX_HTTP_ATTEMPTS;
    const maxAbsorbed = opts.maxAbsorbedRetryAfterMs ?? MAX_ABSORBED_RETRY_AFTER_MS;
    const rand = opts.rand ?? Math.random;
    const doSleep = opts.sleepImpl ?? sleep;
    const inner = opts.fetchImpl ?? boundedFetch;

    return async function resilientFetchImpl(input, init) {
        // Host + path only. These errors are PERSISTED to
        // IntegrationConnection.authFailureReason and rendered in the UI, so a
        // raw URL here would write an access token from the query string into
        // the database — the exact leak bounded-fetch's safeUrl exists to stop.
        const url = safeUrl(input);
        let lastRetryable: unknown;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            let res: Response;
            try {
                res = await inner(input, init);
            } catch (err) {
                // A timeout is retryable; a caller abort is not, and
                // classifyError deliberately does not claim otherwise.
                if (classifyError(err) === 'terminal' || attempt === maxAttempts) throw err;
                lastRetryable = err;
                await doSleep(jitteredBackoff(attempt, rand));
                continue;
            }

            const kind = res.status ? classifyStatus(res.status) : null;
            if (kind === null) return res;

            if (kind === 'terminal') {
                throw isAuthStatus(res.status)
                    ? new IntegrationAuthError(res.status, url)
                    : new IntegrationTerminalError(res.status, url);
            }

            const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after') ?? null);

            // Longer than we will hold a worker: end the tick cleanly rather
            // than idling. The next scheduled run retries.
            if (retryAfterMs != null && retryAfterMs > maxAbsorbed) {
                logger.warn('integration throttled beyond the absorb budget', {
                    component: 'integrations',
                    status: res.status,
                    retryAfterMs,
                    maxAbsorbed,
                });
                throw new IntegrationRateLimitedError(url, retryAfterMs);
            }

            if (attempt === maxAttempts) {
                throw new IntegrationRateLimitedError(url, retryAfterMs);
            }

            // Honour the server's number when it gave one; otherwise jitter.
            await doSleep(retryAfterMs ?? jitteredBackoff(attempt, rand));
        }

        // Unreachable: the loop either returns or throws. Kept so a future edit
        // to the loop bounds fails loudly rather than returning undefined.
        throw lastRetryable ?? new Error('resilient fetch exhausted attempts');
    };
}

/** The default resilient fetch — bounded, and throttle-aware. */
export const resilientFetch: typeof fetch = createResilientFetch();
