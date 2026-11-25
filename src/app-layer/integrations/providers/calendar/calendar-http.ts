/**
 * The HTTP seam both calendar writers share (#5937 step 2).
 *
 * ═══ WHAT IT DECIDES ═══
 *
 * 1. EVERY REQUEST GOES THROUGH `createResilientFetch`, over the bounded fetch.
 *    That is what turns 401/403 into `IntegrationAuthError` and an exhausted
 *    429 into `IntegrationRateLimitedError` — the two errors the sweep treats as
 *    the CONNECTION's problem rather than one event's
 *    (`calendar-reconcile-sweep.ts::isConnectionLevel`), and the two
 *    `runUserPushGuarded` turns into "revoked" and "throttled".
 *
 * 2. THE BUDGET IS SMALL ON PURPOSE. Two attempts, and a `Retry-After` longer
 *    than five seconds is not waited out. One person's writes are sequential and
 *    a tenant's people are visited in one job, so a long in-process wait holds
 *    every later person behind it. The design's rule: no retry inside a run
 *    honours a provider's `Retry-After` beyond the job's own budget; the next
 *    nightly run resumes from the mapping table.
 *
 * 3. A 401 IS RETRIED ONCE, WITH A FRESHLY REFRESHED TOKEN. An access token
 *    that is valid by its recorded expiry can still be refused (clock skew, a
 *    token the provider rotated out). Revoking the connection on that first 401
 *    would make the person reconnect for nothing. A 401 AFTER a fresh refresh
 *    is the provider's real answer and propagates as `IntegrationAuthError`. A
 *    403 is not retried: it names a permission, not a stale token.
 *
 * The hosts are fixed vendor hosts named in each writer, never configuration,
 * so this is not a tenant-controlled egress sink and needs no `safeFetch`
 * (`tests/guards/ssrf-egress-coverage.test.ts` is about URLs a tenant can
 * write). It is bounded and throttle-aware like every other provider.
 *
 * @module integrations/providers/calendar/calendar-http
 */
import { createHash } from 'node:crypto';
import { boundedFetch } from '../../bounded-fetch';
import { createResilientFetch, IntegrationAuthError } from '../../http-resilience';

/** Attempts inside one call, including the first. */
export const CALENDAR_HTTP_ATTEMPTS = 2;

/** The longest `Retry-After` absorbed in-process before the person's run stops. */
export const CALENDAR_MAX_ABSORBED_RETRY_AFTER_MS = 5_000;

/** Where a writer gets its bearer token. Both go through `resolveCalendarAccessToken`. */
export interface CalendarAccessTokens {
    /** A token valid now — refreshed and persisted first when inside the expiry skew. */
    current(): Promise<string>;
    /** A token refreshed NOW, whatever its recorded expiry. Persisted before it is returned. */
    refresh(): Promise<string>;
}

/** Test seams. Production passes none of these. */
export interface CalendarHttpDeps {
    /** The transport under the resilient layer. Defaults to the bounded fetch. */
    fetchImpl?: typeof fetch;
    /** So a backoff can be asserted without sleeping. */
    sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * A write the provider refused for THIS event — a 400, a 409 we could not
 * resolve, a body with no id. Per-event, so the sweep records the row FAILED
 * and carries on with the person's other events.
 *
 * The message carries the operation and the status only. A provider's error
 * body can quote the request back, and the request carries a deadline's title;
 * `UserCalendarEventMapping.lastError` is operator-facing and kept plain.
 */
export class CalendarWriteError extends Error {
    readonly status: number;

    constructor(operation: string, status: number) {
        super(`Calendar ${operation} failed (HTTP ${status})`);
        this.name = 'CalendarWriteError';
        this.status = status;
    }
}

export type CalendarSend = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
) => Promise<Response>;

/**
 * Build the `send` a writer uses: JSON in, the raw `Response` out, the bearer
 * token from `tokens`, every request through the resilient layer.
 *
 * `wrapTransport` lets a provider re-read a response BEFORE the resilient layer
 * classifies it — Google answers a quota breach as `403 rateLimitExceeded`,
 * which the layer would otherwise treat as a lost credential.
 */
export function createCalendarSend(opts: {
    tokens: CalendarAccessTokens;
    /**
     * The bearer header (and anything a provider must send with it). Graph's
     * writer passes `graphHeaders`, which also sets a real `Accept-Language`
     * (#3458). Default: `Authorization: Bearer <token>`.
     */
    authHeaders?: (token: string) => Record<string, string>;
    wrapTransport?: (inner: typeof fetch) => typeof fetch;
    deps?: CalendarHttpDeps;
}): CalendarSend {
    const inner = opts.deps?.fetchImpl ?? boundedFetch;
    const doFetch = createResilientFetch({
        maxAttempts: CALENDAR_HTTP_ATTEMPTS,
        maxAbsorbedRetryAfterMs: CALENDAR_MAX_ABSORBED_RETRY_AFTER_MS,
        fetchImpl: opts.wrapTransport ? opts.wrapTransport(inner) : inner,
        sleepImpl: opts.deps?.sleepImpl,
    });

    const attempt = (method: string, url: string, body: unknown, token: string) =>
        doFetch(url, {
            method,
            headers: {
                Accept: 'application/json',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(opts.authHeaders ? opts.authHeaders(token) : { Authorization: `Bearer ${token}` }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    return async (method, url, body) => {
        try {
            return await attempt(method, url, body, await opts.tokens.current());
        } catch (err) {
            if (err instanceof IntegrationAuthError && err.status === 401) {
                // Once. A second 401 propagates and the connection is revoked.
                return attempt(method, url, body, await opts.tokens.refresh());
            }
            throw err;
        }
    };
}

/**
 * The all-day span for a deadline: its own UTC date, and the next day as the
 * exclusive end both providers require.
 *
 * A deadline is a DATE. The aggregation stores day-resolution deadlines at UTC
 * midnight and the calendar page draws them on `date.slice(0, 10)`; a timed
 * event would move across a timezone boundary in the person's calendar.
 */
export function allDaySpan(startsAt: string): { date: string; nextDate: string } {
    const date = startsAt.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('calendar event has no date');
    const next = new Date(`${date}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return { date, nextDate: next.toISOString().slice(0, 10) };
}

/**
 * The id used when an event the person deleted by hand is created again.
 *
 * DETERMINISTIC from the id it replaces, so a retry of the re-creation is a
 * duplicate the provider recognises rather than a second event — the same
 * property `calendarClientEventId` gives the first creation. Lowercase hex, so
 * Google's base32hex alphabet accepts it as an event id.
 */
export function recreatedClientEventId(previousRemoteEventId: string): string {
    return createHash('sha256').update(`recreate:${previousRemoteEventId}`).digest('hex').slice(0, 40);
}

/** Read `{ id }` out of a provider's JSON answer, or refuse. */
export async function readEventId(res: Response, operation: string): Promise<string> {
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (!body || typeof body.id !== 'string' || body.id.length === 0) {
        throw new CalendarWriteError(`${operation} (no event id in the answer)`, res.status);
    }
    return body.id;
}

/** A resilient-layer 404 arrives THROWN; a 410 arrives as a response. Both mean gone. */
export function isGoneStatus(status: number): boolean {
    return status === 404 || status === 410;
}
