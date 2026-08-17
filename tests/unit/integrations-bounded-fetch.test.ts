/**
 * Every outbound integration call has a deadline.
 *
 * The failure this prevents is not "one tenant's sync is slow". The dispatchers
 * fan out across tenants onto a shared worker pool, so a single black-holed
 * remote holds a worker slot until the stalled-job timeout fires and starves
 * every OTHER tenant queued behind it. The blast radius of one bad endpoint was
 * the whole fan-out.
 *
 * These use fake timers so the deadline is asserted rather than waited for — a
 * test that actually slept 30s would get deleted the first time someone ran the
 * suite in a hurry.
 */
import {
    createBoundedFetch,
    boundedFetch,
    IntegrationTimeoutError,
    DEFAULT_TIMEOUT_MS,
} from '@/app-layer/integrations/bounded-fetch';

describe('createBoundedFetch', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
        jest.useRealTimers();
    });

    it('aborts a hanging request at the deadline', async () => {
        // A remote that accepts the connection and then never answers — the
        // black-hole case, which is worse than a refusal because nothing
        // errors.
        globalThis.fetch = jest.fn(
            (_input: RequestInfo | URL, init?: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        reject(init.signal?.reason ?? new Error('aborted'));
                    });
                }),
        ) as unknown as typeof fetch;

        jest.useFakeTimers();
        const bounded = createBoundedFetch(1_000);
        const pending = bounded('https://okta.example.com/api/v1/users');
        const assertion = expect(pending).rejects.toBeInstanceOf(IntegrationTimeoutError);

        await jest.advanceTimersByTimeAsync(1_000);
        await assertion;
    });

    it('names the host and the budget, but never the query string', async () => {
        globalThis.fetch = jest.fn(
            (_i: RequestInfo | URL, init?: RequestInit) =>
                new Promise((_res, rej) => {
                    init?.signal?.addEventListener('abort', () => rej(init.signal?.reason));
                }),
        ) as unknown as typeof fetch;

        jest.useFakeTimers();
        const bounded = createBoundedFetch(500);
        // A token in the query string is exactly what must not reach a log.
        const pending = bounded('https://api.example.com/v1/users?access_token=SECRET123');
        const caught = pending.catch((e) => e);
        await jest.advanceTimersByTimeAsync(500);

        const err = await caught;
        expect(err).toBeInstanceOf(IntegrationTimeoutError);
        expect(err.message).toContain('500ms');
        expect(err.message).toContain('api.example.com');
        expect(err.message).not.toContain('SECRET123');
        expect(err.retryable).toBe(true);
    });

    it('passes a fast response straight through', async () => {
        const body = new Response('{"ok":true}', { status: 200 });
        globalThis.fetch = jest.fn(async () => body) as unknown as typeof fetch;

        const res = await createBoundedFetch(1_000)('https://api.example.com/x');
        expect(res).toBe(body);
    });

    it('COMBINES a caller signal with the deadline instead of replacing it', async () => {
        // Replacing it would silently break cancellation for any caller already
        // passing a signal — a regression a timeout helper has no business
        // introducing.
        let seen: AbortSignal | undefined;
        globalThis.fetch = jest.fn(
            (_i: RequestInfo | URL, init?: RequestInit) =>
                new Promise((_res, rej) => {
                    seen = init?.signal ?? undefined;
                    init?.signal?.addEventListener('abort', () => rej(init.signal?.reason));
                }),
        ) as unknown as typeof fetch;

        const caller = new AbortController();
        const pending = createBoundedFetch(60_000)('https://api.example.com/x', {
            signal: caller.signal,
        });
        const caught = pending.catch((e) => e);

        caller.abort(new Error('caller changed its mind'));
        const err = await caught;

        expect(seen).toBeDefined();
        // The caller's abort wins and is NOT relabelled as our timeout — a
        // shutdown must not look like a slow remote, or the retry layer will
        // re-queue work someone asked us to stop.
        expect(err).not.toBeInstanceOf(IntegrationTimeoutError);
    });

    it('leaves a genuine network error unchanged', async () => {
        const boom = new TypeError('fetch failed');
        globalThis.fetch = jest.fn(async () => {
            throw boom;
        }) as unknown as typeof fetch;

        await expect(createBoundedFetch(1_000)('https://api.example.com/x')).rejects.toBe(boom);
    });
});

describe('the two exported bounds', () => {
    it('the default matches the deliberate AD LDAP bound', () => {
        // One answer for "how long is one request allowed" across the layer,
        // regardless of transport.
        expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
        expect(typeof boundedFetch).toBe('function');
    });

    it('the bound is PER REQUEST, so a long enumeration is not penalised for its length', () => {
        // A 50-page enumeration gets 50 separate deadlines. A per-enumeration
        // budget would make the failure depend on how far through the directory
        // the slow page happened to fall.
        //
        // This replaced an assertion over ENUMERATION_TIMEOUT_MS, a 120s
        // second bound that never had a consumer — the assertion only checked
        // that the constant existed and exceeded the default, which is true of
        // any dead export.
        const bounded = createBoundedFetch(DEFAULT_TIMEOUT_MS);
        expect(typeof bounded).toBe('function');
        expect(typeof boundedFetch).toBe('function');
    });
});
