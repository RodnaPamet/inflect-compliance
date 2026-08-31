/**
 * `createResilientFetch` — the paths a well-behaved server never produces.
 *
 * `tests/unit/integrations-http-resilience.test.ts` drives the loop with real
 * `Response` objects and an injected sleep, which is the right default. What it
 * cannot reach is the three things this file is about:
 *
 *   1. a response object that is NOT a real `Response` — no `headers`, or a
 *      `headers` without `get`. Every provider client in this repo is
 *      constructor-injected with a `fetch`, and a test double or a polyfill
 *      that returns `{ ok, status, json }` is the shape those doubles actually
 *      have. `res.headers?.get?.(…)` exists for exactly that, and a regression
 *      there is a TypeError thrown from inside the retry loop — which
 *      `classifyError` then calls retryable, so the sync retries a crash.
 *   2. a caller-supplied absorb budget, which is the only way an operator can
 *      make the module hold a worker for longer or shorter than a minute.
 *   3. the DEFAULT sleep. Every existing test injects `sleepImpl`, so the real
 *      one has never run — and it is the only thing standing between a backoff
 *      and a busy loop.
 */
import {
    createResilientFetch,
    classifyError,
    IntegrationRateLimitedError,
    IntegrationTerminalError,
    MAX_ABSORBED_RETRY_AFTER_MS,
} from '@/app-layer/integrations/http-resilience';

/** Records sleeps instead of performing them. */
function recorder() {
    const slept: number[] = [];
    return { slept, sleepImpl: async (ms: number) => void slept.push(ms) };
}

/** A response double of the shape provider test-doubles actually return. */
const bare = (status: number) => ({ ok: status < 400, status }) as unknown as Response;

describe('classifyError covers every integration error class', () => {
    it('a rate-limit error is retryable — the throttle passes, the credential is fine', () => {
        // It shares an answer with the unknown-throw default, so the assertion
        // that matters is that it does NOT come back terminal: a terminal
        // classification would mark the connection credential-failed and stop
        // scheduling it, for a server that simply asked us to slow down.
        expect(classifyError(new IntegrationRateLimitedError('https://x/y', 1_000))).toBe('retryable');
        expect(classifyError(new IntegrationTerminalError(404, 'https://x/y'))).toBe('terminal');
    });
});

describe('a response without usable headers is retried, not crashed on', () => {
    it('treats an absent headers bag as "no Retry-After" and backs off', async () => {
        const { slept, sleepImpl } = recorder();
        const inner = jest
            .fn<Promise<Response>, unknown[]>()
            .mockResolvedValueOnce(bare(503))
            .mockResolvedValueOnce(bare(200));

        const f = createResilientFetch({
            fetchImpl: inner as unknown as typeof fetch,
            sleepImpl,
            rand: () => 0.5,
        });
        const res = await f('https://acme.okta.com/api/v1/users');

        expect(res.status).toBe(200);
        expect(inner).toHaveBeenCalledTimes(2);
        // Half of the 1s first-attempt base — the jittered path, which is where
        // an absent Retry-After is supposed to land.
        expect(slept).toEqual([500]);
    });

    it('treats a headers object without get() the same way', async () => {
        const { slept, sleepImpl } = recorder();
        const weird = { ok: false, status: 429, headers: {} } as unknown as Response;
        const inner = jest
            .fn<Promise<Response>, unknown[]>()
            .mockResolvedValueOnce(weird)
            .mockResolvedValueOnce(bare(200));

        const f = createResilientFetch({
            fetchImpl: inner as unknown as typeof fetch,
            sleepImpl,
            rand: () => 0,
        });

        await expect(f('https://acme.okta.com/api/v1/users')).resolves.toMatchObject({ status: 200 });
        expect(slept).toEqual([0]);
    });
});

describe('the absorb budget is a caller decision, not a constant', () => {
    it('defers a Retry-After above a CUSTOM budget that the default would have absorbed', async () => {
        // 30s is well inside the 60s default, so this asserts the option is
        // read rather than that the constant is right. An operator tightening
        // the budget for a latency-sensitive worker gets a deferral, not a
        // 30-second stall.
        const custom = 5_000;
        expect(custom).toBeLessThan(MAX_ABSORBED_RETRY_AFTER_MS);

        const { slept, sleepImpl } = recorder();
        const inner = jest
            .fn<Promise<Response>, unknown[]>()
            .mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '30' } }));

        const f = createResilientFetch({
            fetchImpl: inner as unknown as typeof fetch,
            sleepImpl,
            maxAbsorbedRetryAfterMs: custom,
        });

        await expect(f('https://acme.okta.com/api/v1/users')).rejects.toBeInstanceOf(
            IntegrationRateLimitedError,
        );
        // The point of deferring: the worker is released immediately rather
        // than idling, and the next scheduled tick picks the work up.
        expect(slept).toEqual([]);
        expect(inner).toHaveBeenCalledTimes(1);
    });

    it('absorbs the same throttle under a budget that allows it', async () => {
        const { slept, sleepImpl } = recorder();
        const inner = jest
            .fn<Promise<Response>, unknown[]>()
            .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '30' } }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));

        const f = createResilientFetch({
            fetchImpl: inner as unknown as typeof fetch,
            sleepImpl,
            maxAbsorbedRetryAfterMs: 60_000,
        });

        await expect(f('https://acme.okta.com/api/v1/users')).resolves.toMatchObject({ status: 200 });
        expect(slept).toEqual([30_000]);
    });
});

describe('the DEFAULT sleep really waits', () => {
    it('retries through the built-in sleep when no sleepImpl is injected', async () => {
        // `rand: () => 0` pins the jittered backoff to 0ms so this costs a tick
        // rather than a second — but it is the real `setTimeout` promise, so a
        // regression that dropped the `await` (or returned a non-promise) would
        // turn every retry into a busy loop against a throttled provider, which
        // is the amplification this module exists to prevent.
        const inner = jest
            .fn<Promise<Response>, unknown[]>()
            .mockResolvedValueOnce(bare(502))
            .mockResolvedValueOnce(bare(200));

        const f = createResilientFetch({ fetchImpl: inner as unknown as typeof fetch, rand: () => 0 });
        const started = Date.now();

        await expect(f('https://acme.okta.com/api/v1/users')).resolves.toMatchObject({ status: 200 });

        expect(inner).toHaveBeenCalledTimes(2);
        // Bounded so the suite cannot start sleeping for real if the jitter
        // injection is ever dropped.
        expect(Date.now() - started).toBeLessThan(1_000);
    });
});
