/**
 * Branch coverage for the canonical outbound-HTTP retry helper.
 *
 * `fetchWithRetry` wraps every outbound call in audit-stream
 * webhook delivery + future SCIM / billing fanout. Its branching
 * is the load-bearing risk: which status codes retry, which throw
 * immediately, when the AbortController fires, and how the final
 * "exhausted retries" error is shaped. All four are pinned here.
 *
 * Time is faked so the linear/quadratic backoff sleeps don't make
 * the suite slow — every `await` between attempts is advanced via
 * fake timers.
 */
import { fetchWithRetry, NonRetryableHttpError } from '@/lib/http/fetch-with-retry';

const realFetch = global.fetch;

/** Build a minimal Response-shaped object the helper inspects. */
function res(init: {
    ok?: boolean;
    status?: number;
    json?: () => Promise<unknown>;
}): Response {
    return {
        ok: init.ok ?? false,
        status: init.status ?? 200,
        json: init.json ?? (async () => ({})),
    } as unknown as Response;
}

/**
 * Run a promise to completion while repeatedly flushing the
 * fake-timer queue — the helper interleaves `await fetch` (a real
 * microtask) with `setTimeout`-based backoff (a fake timer).
 *
 * `jest.runAllTimersAsync()` advances pending timers AND yields to
 * the microtask queue between them, so the next `await fetch` runs
 * before the loop checks for more timers. We attach a no-op catch
 * to the tracking handle so a rejecting `p` never surfaces as an
 * unhandled rejection while we drain.
 */
async function runWithTimers<T>(p: Promise<T>): Promise<T> {
    let settled = false;
    const tracked = p.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    for (let i = 0; i < 50 && !settled; i++) {
        await jest.runAllTimersAsync();
    }
    await tracked;
    return p;
}

describe('fetchWithRetry', () => {
    let mockFetch: jest.Mock;

    beforeEach(() => {
        jest.useFakeTimers();
        mockFetch = jest.fn();
        global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterEach(() => {
        jest.useRealTimers();
        global.fetch = realFetch;
    });

    it('returns the response immediately on a 2xx (no retry)', async () => {
        const ok = res({ ok: true, status: 200 });
        mockFetch.mockResolvedValueOnce(ok);

        const result = await runWithTimers(fetchWithRetry('https://x.test'));

        expect(result).toBe(ok);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('forwards init options and the abort signal to fetch', async () => {
        mockFetch.mockResolvedValueOnce(res({ ok: true, status: 200 }));

        await runWithTimers(
            fetchWithRetry('https://x.test', {
                method: 'POST',
                body: 'payload',
            }),
        );

        const [, init] = mockFetch.mock.calls[0];
        expect(init.method).toBe('POST');
        expect(init.body).toBe('payload');
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('retries on 429 and succeeds on a later attempt', async () => {
        mockFetch
            .mockResolvedValueOnce(res({ ok: false, status: 429 }))
            .mockResolvedValueOnce(res({ ok: false, status: 429 }))
            .mockResolvedValueOnce(res({ ok: true, status: 200 }));

        const result = await runWithTimers(
            fetchWithRetry('https://x.test', undefined, { retryDelay: 10 }),
        );

        expect((result as Response).ok).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('retries on 5xx server errors', async () => {
        mockFetch
            .mockResolvedValueOnce(res({ ok: false, status: 503 }))
            .mockResolvedValueOnce(res({ ok: true, status: 200 }));

        const result = await runWithTimers(
            fetchWithRetry('https://x.test', undefined, { retryDelay: 10 }),
        );

        expect((result as Response).ok).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    // ── Non-retryable status handling ──────────────────────────────
    //
    // A non-2xx answer that is neither 429 nor 5xx is the server
    // refusing the request on its merits. It is surfaced on the FIRST
    // attempt as a NonRetryableHttpError carrying the status — never
    // re-sent, and never wrapped in the exhaustion message (#5316: a
    // revoked NVD key used to burn five paced retries and then read as
    // a transient outage).

    it('throws "Unauthorized" at once on a 403, without retrying', async () => {
        mockFetch.mockResolvedValue(res({ ok: false, status: 403 }));

        const p = runWithTimers(
            fetchWithRetry('https://x.test', undefined, {
                maxRetries: 3,
                retryDelay: 5,
            }),
        );
        await expect(p).rejects.toBeInstanceOf(NonRetryableHttpError);
        await expect(p).rejects.toThrow(/^Unauthorized$/);
        await expect(p).rejects.toMatchObject({ status: 403 });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws the parsed error body at once on a 4xx, without retrying', async () => {
        mockFetch.mockResolvedValue(
            res({
                ok: false,
                status: 400,
                json: async () => ({ error: 'bad input' }),
            }),
        );

        const p = runWithTimers(
            fetchWithRetry('https://x.test', undefined, {
                maxRetries: 2,
                retryDelay: 5,
            }),
        );
        await expect(p).rejects.toThrow(/^bad input$/);
        await expect(p).rejects.toMatchObject({ status: 400 });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry a 404', async () => {
        mockFetch.mockResolvedValue(res({ ok: false, status: 404 }));

        const p = runWithTimers(
            fetchWithRetry('https://x.test', undefined, {
                maxRetries: 5,
                retryDelay: 5,
            }),
        );
        await expect(p).rejects.toMatchObject({ status: 404 });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('falls back to a generic message when the 4xx body is not JSON', async () => {
        mockFetch.mockResolvedValue(
            res({
                ok: false,
                status: 422,
                json: async () => {
                    throw new Error('not json');
                },
            }),
        );

        await expect(
            runWithTimers(
                fetchWithRetry('https://x.test', undefined, {
                    maxRetries: 2,
                    retryDelay: 5,
                }),
            ),
        ).rejects.toThrow('HTTP error 422');
    });

    it('falls back to a generic message when the 4xx JSON has no error field', async () => {
        mockFetch.mockResolvedValue(
            res({
                ok: false,
                status: 418,
                json: async () => ({ detail: 'teapot' }),
            }),
        );

        await expect(
            runWithTimers(
                fetchWithRetry('https://x.test', undefined, {
                    maxRetries: 2,
                    retryDelay: 5,
                }),
            ),
        ).rejects.toThrow('HTTP error 418');
    });

    it('retries on a thrown network error and surfaces the exhaustion message', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(
            runWithTimers(
                fetchWithRetry('https://x.test', undefined, {
                    maxRetries: 3,
                    retryDelay: 5,
                }),
            ),
        ).rejects.toThrow(
            'Failed after 3 retries. Last error: ECONNREFUSED',
        );
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('coerces a non-Error throw into an Error before reporting', async () => {
        // A bare string rejection — the helper wraps it in `new Error`.
        mockFetch.mockRejectedValue('socket hangup');

        await expect(
            runWithTimers(
                fetchWithRetry('https://x.test', undefined, {
                    maxRetries: 2,
                    retryDelay: 5,
                }),
            ),
        ).rejects.toThrow('Failed after 2 retries. Last error: socket hangup');
    });

    it('stops retrying after maxRetries on persistent 5xx', async () => {
        mockFetch.mockResolvedValue(res({ ok: false, status: 500 }));

        // Persistent 5xx never throws inside the loop (it `continue`s),
        // so the loop falls through to the final guard throw.
        await expect(
            runWithTimers(
                fetchWithRetry('https://x.test', undefined, {
                    maxRetries: 4,
                    retryDelay: 5,
                }),
            ),
        ).rejects.toThrow('Failed after 4 retries');
        expect(mockFetch).toHaveBeenCalledTimes(4);
    });
});
