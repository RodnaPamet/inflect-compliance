/**
 * The one HTTP path to a System One endpoint: a per-call timeout, at most one
 * retry, and a caller-owned deadline that the retry can never outlive.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE DEADLINE BELONGS TO THE CALLER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Adjudication runs INLINE, before the review queue opens, over every residue
 * account in a pass. So the budget that matters is not this call's — it is the
 * whole pass's, and only the caller knows how much of it is left.
 *
 * A retry that honours `Retry-After` without reference to that deadline is how one
 * slow account stalls a pass: the vendor is entitled to say `Retry-After: 120`,
 * and a client that obeys it has handed a third party control of our scheduling.
 * So `deadlineAt` is a parameter, the sleep is clamped to what remains, and a
 * `Retry-After` longer than the remaining budget means we do not retry at all
 * rather than retry late.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE RETRY, AND ONLY FOR TRANSIENT STATUSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 429 and 5xx only. A 4xx that is not 429 is a request we built wrong, and
 * retrying it just sends the same wrong request again — twice the egress to a
 * sub-processor for the same answer. A timeout is NOT retried either: the deadline
 * exists because the pass has somewhere else to be, and the honest outcome of a
 * slow model is no verdict, which leaves the account with a person.
 *
 * @module app-layer/ai/identity-match/transport
 */

/** Statuses worth sending the same request again for. */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface SystemOneCallOptions {
    readonly url: string;
    readonly body: unknown;
    /** Per-attempt abort budget. Jev 3000, Laya 2000. */
    readonly timeoutMs: number;
    /**
     * Absolute epoch-ms ceiling for the whole call, retry included. Supplied by
     * the caller because the caller owns the pass's budget.
     */
    readonly deadlineAt: number;
    readonly headers?: Readonly<Record<string, string>>;
    /** Injected for testing. Defaults to global fetch. */
    readonly fetchImpl?: typeof fetch;
    /** Injected for testing. Defaults to Date.now. */
    readonly nowMs?: () => number;
    /** Injected for testing. Defaults to a real timer. */
    readonly sleep?: (ms: number) => Promise<void>;
}

export class SystemOneTransportError extends Error {
    constructor(
        message: string,
        readonly kind: 'timeout' | 'deadline' | 'status' | 'network',
        readonly status?: number
    ) {
        super(message);
        this.name = 'SystemOneTransportError';
    }
}

/**
 * `Retry-After` in milliseconds, or null when absent or unusable.
 *
 * Both documented forms: delay-seconds, and an HTTP-date. A malformed value is
 * null rather than zero — zero would mean "retry immediately", which is the
 * opposite of what a server sending a broken back-off signal wants.
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
    if (!header) return null;
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) {
        const secs = Number(trimmed);
        return Number.isFinite(secs) ? secs * 1000 : null;
    }
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    return Math.max(0, at - nowMs);
}

async function attempt(
    opts: SystemOneCallOptions,
    budgetMs: number
): Promise<{ ok: true; json: unknown } | { ok: false; status: number; retryAfterMs: number | null }> {
    const doFetch = opts.fetchImpl ?? fetch;
    const now = opts.nowMs ?? Date.now;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
        const res = await doFetch(opts.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
            body: JSON.stringify(opts.body),
            signal: controller.signal,
        });
        if (!res.ok) {
            const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now());
            return { ok: false, status: res.status, retryAfterMs };
        }
        return { ok: true, json: await res.json() };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * POST once, retry at most once, never past `deadlineAt`.
 */
export async function callSystemOne(opts: SystemOneCallOptions): Promise<unknown> {
    const now = opts.nowMs ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    const remaining = () => opts.deadlineAt - now();

    if (remaining() <= 0) {
        throw new SystemOneTransportError('deadline already passed before the first attempt', 'deadline');
    }

    // The per-attempt budget never exceeds what the deadline leaves.
    const firstBudget = Math.min(opts.timeoutMs, remaining());

    let first: Awaited<ReturnType<typeof attempt>>;
    try {
        first = await attempt(opts, firstBudget);
    } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        throw new SystemOneTransportError(
            aborted ? `aborted after ${firstBudget}ms` : `network failure`,
            aborted ? 'timeout' : 'network'
        );
    }

    if (first.ok) return first.json;

    if (!TRANSIENT_STATUSES.has(first.status)) {
        // Our request, our bug. Sending it again buys nothing and spends egress.
        throw new SystemOneTransportError(`non-retryable status ${first.status}`, 'status', first.status);
    }

    // One retry, and only if the deadline can actually hold it: the back-off AND
    // an attempt must both fit, or we are choosing to blow the caller's budget.
    const backoffMs = first.retryAfterMs ?? 250;
    const left = remaining();
    if (backoffMs + 1 >= left) {
        throw new SystemOneTransportError(
            `status ${first.status}; retry skipped — back-off ${backoffMs}ms does not fit the ${left}ms left`,
            'deadline',
            first.status
        );
    }

    await sleep(backoffMs);

    const secondBudget = Math.min(opts.timeoutMs, remaining());
    if (secondBudget <= 0) {
        throw new SystemOneTransportError('deadline reached during back-off', 'deadline', first.status);
    }

    let second: Awaited<ReturnType<typeof attempt>>;
    try {
        second = await attempt(opts, secondBudget);
    } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        throw new SystemOneTransportError(
            aborted ? `aborted after ${secondBudget}ms on retry` : `network failure on retry`,
            aborted ? 'timeout' : 'network'
        );
    }

    if (second.ok) return second.json;
    throw new SystemOneTransportError(
        `status ${second.status} after one retry`,
        'status',
        second.status
    );
}
