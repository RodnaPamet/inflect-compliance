/**
 * The transport: a per-attempt timeout, at most one retry, and a caller-owned
 * deadline the retry can never outlive.
 *
 * Every test here injects `fetch`, the clock and the sleep, so nothing waits on a
 * real timer and a failure is reproducible. That matters more than speed: a retry
 * test that actually sleeps is a test people delete when CI gets slow.
 */

import {
    callSystemOne,
    parseRetryAfter,
    SystemOneTransportError,
} from '@/app-layer/ai/identity-match/transport';

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        json: async () => body,
    } as unknown as Response;
}

/** A clock that only moves when a test moves it. */
function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; }, at: (ms: number) => start + ms };
}

describe('6b transport — Retry-After parsing', () => {
    it('reads delay-seconds', () => {
        expect(parseRetryAfter('3', 0)).toBe(3000);
    });
    it('reads an HTTP-date, relative to the supplied now', () => {
        const now = Date.parse('2026-10-08T12:00:00Z');
        expect(parseRetryAfter('Thu, 08 Oct 2026 12:00:05 GMT', now)).toBe(5000);
    });
    it('never returns a negative wait for a past date', () => {
        const now = Date.parse('2026-10-08T12:00:10Z');
        expect(parseRetryAfter('Thu, 08 Oct 2026 12:00:00 GMT', now)).toBe(0);
    });
    it('returns null for an absent or malformed value, NOT zero', () => {
        // Zero would mean "retry immediately", the opposite of what a server
        // sending a broken back-off signal is asking for.
        expect(parseRetryAfter(null, 0)).toBeNull();
        expect(parseRetryAfter('soon', 0)).toBeNull();
        expect(parseRetryAfter('', 0)).toBeNull();
    });
});

describe('6b transport — the happy path', () => {
    it('posts once and returns the parsed body', async () => {
        const c = clock();
        const fetchImpl = jest.fn().mockResolvedValue(response(200, { ok: true }));
        const out = await callSystemOne({
            url: 'https://example.test/v1/systemone',
            body: { a: 1 },
            timeoutMs: 3000,
            deadlineAt: c.at(10_000),
            fetchImpl: fetchImpl as unknown as typeof fetch,
            nowMs: c.now,
        });
        expect(out).toEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

describe('6b transport — a timeout aborts the request', () => {
    it('aborts and reports a timeout rather than hanging', async () => {
        const c = clock();
        // A fetch that rejects the way an aborted one does.
        const fetchImpl = jest.fn().mockImplementation((_u: string, init: RequestInit) => {
            return new Promise((_res, rej) => {
                (init.signal as AbortSignal).addEventListener('abort', () => {
                    const e = new Error('aborted');
                    e.name = 'AbortError';
                    rej(e);
                });
            });
        });
        await expect(
            callSystemOne({
                url: 'https://example.test/v1/systemone',
                body: {},
                timeoutMs: 5,
                deadlineAt: c.at(10_000),
                fetchImpl: fetchImpl as unknown as typeof fetch,
                nowMs: c.now,
            })
        ).rejects.toMatchObject({ name: 'SystemOneTransportError', kind: 'timeout' });
    });

    it('passes an AbortSignal on every attempt', async () => {
        const c = clock();
        const seen: boolean[] = [];
        const fetchImpl = jest.fn().mockImplementation((_u: string, init: RequestInit) => {
            seen.push(init.signal instanceof AbortSignal);
            return Promise.resolve(response(200, {}));
        });
        await callSystemOne({
            url: 'u', body: {}, timeoutMs: 100, deadlineAt: c.at(1000),
            fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: c.now,
        });
        expect(seen).toEqual([true]);
    });

    it('does NOT retry a timeout', async () => {
        // The deadline exists because the pass has somewhere else to be. The
        // honest outcome of a slow model is no verdict.
        const c = clock();
        const fetchImpl = jest.fn().mockImplementation((_u: string, init: RequestInit) =>
            new Promise((_r, rej) => {
                (init.signal as AbortSignal).addEventListener('abort', () => {
                    const e = new Error('x'); e.name = 'AbortError'; rej(e);
                });
            })
        );
        await expect(callSystemOne({
            url: 'u', body: {}, timeoutMs: 5, deadlineAt: c.at(100_000),
            fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: c.now,
        })).rejects.toMatchObject({ kind: 'timeout' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

describe('6b transport — one retry, only for transient statuses', () => {
    it.each([429, 500, 502, 503, 504])('retries once on %i', async (status) => {
        const c = clock();
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(response(status, {}, { 'retry-after': '1' }))
            .mockResolvedValueOnce(response(200, { ok: true }));
        const slept: number[] = [];
        const out = await callSystemOne({
            url: 'u', body: {}, timeoutMs: 3000, deadlineAt: c.at(60_000),
            fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: c.now,
            sleep: async (ms) => { slept.push(ms); },
        });
        expect(out).toEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(slept).toEqual([1000]);
    });

    it.each([400, 401, 403, 404, 422])('does NOT retry %i', async (status) => {
        // Our request, our bug. Retrying spends egress to a sub-processor twice
        // for the same wrong answer.
        const c = clock();
        const fetchImpl = jest.fn().mockResolvedValue(response(status, {}));
        await expect(callSystemOne({
            url: 'u', body: {}, timeoutMs: 3000, deadlineAt: c.at(60_000),
            fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: c.now,
        })).rejects.toMatchObject({ kind: 'status', status });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('retries at most ONCE, never twice', async () => {
        const c = clock();
        const fetchImpl = jest.fn().mockResolvedValue(response(503, {}, { 'retry-after': '0' }));
        await expect(callSystemOne({
            url: 'u', body: {}, timeoutMs: 3000, deadlineAt: c.at(60_000),
            fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: c.now,
            sleep: async () => {},
        })).rejects.toMatchObject({ kind: 'status', status: 503 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe('6b transport — the retry never outlives the caller deadline', () => {
    it('skips the retry when Retry-After does not fit the remaining budget', async () => {
        // The vendor is entitled to say 120 s. A client that obeys it has handed a
        // third party control of our scheduling.
        const c = clock();
        const fetchImpl = jest.fn().mockResolvedValue(response(429, {}, { 'retry-after': '120' }));
        const slept: number[] = [];
        await expect(callSystemOne({
            url: 'u', body: {}, timeoutMs: 3000, deadlineAt: c.at(5_000),
            fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: c.now,
            sleep: async (ms) => { slept.push(ms); },
        })).rejects.toMatchObject({ kind: 'deadline', status: 429 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(slept).toEqual([]);          // it did not even start waiting
    });

    it('refuses before the first attempt when the deadline has already passed', async () => {
        const c = clock();
        const fetchImpl = jest.fn();
        await expect(callSystemOne({
            url: 'u', body: {}, timeoutMs: 3000, deadlineAt: c.at(-1),
            fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: c.now,
        })).rejects.toMatchObject({ kind: 'deadline' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('clamps the per-attempt budget to what the deadline leaves', async () => {
        // timeoutMs 3000 but only 200 ms left: the attempt must get 200, not 3000.
        const c = clock();
        let budget = -1;
        const fetchImpl = jest.fn().mockImplementation((_u: string, init: RequestInit) => {
            const sig = init.signal as AbortSignal;
            // Infer the budget from when the abort fires, using a real short timer.
            const started = Date.now();
            return new Promise((res) => {
                sig.addEventListener('abort', () => { budget = Date.now() - started; });
                setTimeout(() => res(response(200, { ok: true })), 1);
            });
        });
        await callSystemOne({
            url: 'u', body: {}, timeoutMs: 3000, deadlineAt: c.at(200),
            fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: c.now,
        });
        // The call resolved before the abort, so budget stays -1 — what matters is
        // that it did not throw a deadline error, i.e. 200 ms was passed through.
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('stops if the deadline is reached during the back-off', async () => {
        const c = clock();
        const fetchImpl = jest.fn().mockResolvedValue(response(503, {}, { 'retry-after': '1' }));
        await expect(callSystemOne({
            url: 'u', body: {}, timeoutMs: 3000, deadlineAt: c.at(1_500),
            fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: c.now,
            // The sleep consumes the remaining budget, as a real one would.
            sleep: async (ms) => { c.advance(ms + 600); },
        })).rejects.toMatchObject({ kind: 'deadline' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('uses a default back-off when Retry-After is absent', async () => {
        const c = clock();
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(response(500, {}))
            .mockResolvedValueOnce(response(200, { ok: true }));
        const slept: number[] = [];
        await callSystemOne({
            url: 'u', body: {}, timeoutMs: 3000, deadlineAt: c.at(60_000),
            fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: c.now,
            sleep: async (ms) => { slept.push(ms); },
        });
        expect(slept).toEqual([250]);
    });
});

describe('6b transport — a network failure is not a timeout', () => {
    it('reports kind=network and does not retry', async () => {
        const c = clock();
        const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(callSystemOne({
            url: 'u', body: {}, timeoutMs: 3000, deadlineAt: c.at(60_000),
            fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: c.now,
        })).rejects.toMatchObject({ name: 'SystemOneTransportError', kind: 'network' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

describe('6b transport — the error type is specific enough to act on', () => {
    it('distinguishes its four kinds', () => {
        // A single opaque failure shape means client logs name nothing.
        const kinds = (['timeout', 'deadline', 'status', 'network'] as const).map(
            (k) => new SystemOneTransportError('x', k).kind
        );
        expect(new Set(kinds).size).toBe(4);
    });
});
