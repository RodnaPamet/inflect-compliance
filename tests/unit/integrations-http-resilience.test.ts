/**
 * Rate-limit handling, and the amplification it exists to stop.
 *
 * The defect was not "429s were unhandled". It was that an unhandled 429
 * reached the queue as a generic failure, and `attempts: 3` with 5s exponential
 * backoff then re-ran the WHOLE sync three times inside ~35 seconds — answering
 * a soft throttle with three more full enumerations, which is how a throttle
 * becomes a block.
 *
 * So the assertions that matter most are the ones about what does NOT happen:
 * no retry on a revoked credential, and no in-process waiting on a throttle
 * longer than we are willing to hold a worker.
 *
 * `sleepImpl` and `rand` are injected so backoff is asserted rather than slept
 * through — a suite that really waited would be deleted the first time someone
 * ran it in a hurry.
 */
import {
    createResilientFetch,
    classifyStatus,
    classifyError,
    isAuthStatus,
    parseRetryAfter,
    IntegrationAuthError,
    IntegrationTerminalError,
    IntegrationRateLimitedError,
    MAX_ABSORBED_RETRY_AFTER_MS,
} from '@/app-layer/integrations/http-resilience';
import { IntegrationTimeoutError } from '@/app-layer/integrations/bounded-fetch';

const res = (status: number, headers: Record<string, string> = {}) =>
    new Response(null, { status, headers });

/** Records sleeps instead of performing them. */
function recorder() {
    const slept: number[] = [];
    return { slept, sleepImpl: async (ms: number) => void slept.push(ms) };
}

describe('classifyStatus', () => {
    it.each([429, 502, 503, 504, 500])('%d is retryable', (s) => {
        expect(classifyStatus(s)).toBe('retryable');
    });

    it.each([401, 403, 404])('%d is terminal — waiting fixes none of them', (s) => {
        expect(classifyStatus(s)).toBe('terminal');
    });

    it('but only 401/403 accuse the credential', () => {
        // "Do not retry" and "the credential is bad" are different claims, and
        // H1-3 acts on the second one. A 404 is a group someone deleted.
        expect(isAuthStatus(401)).toBe(true);
        expect(isAuthStatus(403)).toBe(true);
        expect(isAuthStatus(404)).toBe(false);
    });

    it.each([200, 201, 204, 302])('%d is not a failure', (s) => {
        expect(classifyStatus(s)).toBeNull();
    });

    it('400 is terminal-ish but NOT classified terminal — it is a bad request, not a bad credential', () => {
        // H1-3 marks a connection as credential-revoked on `terminal`. A
        // malformed request must not trip that, or the UI accuses the admin's
        // token of being revoked when our own query was wrong.
        expect(classifyStatus(400)).toBeNull();
    });
});

describe('parseRetryAfter', () => {
    it('parses delta-seconds', () => {
        expect(parseRetryAfter('120')).toBe(120_000);
    });

    it('parses the HTTP-date form', () => {
        // RFC 9110 allows BOTH forms. Handling only the integer silently
        // ignores a server that told us exactly when to come back, and falls
        // through to blind backoff — the failure this module exists to avoid.
        const now = Date.parse('2026-08-17T10:00:00Z');
        expect(parseRetryAfter('Mon, 17 Aug 2026 10:00:30 GMT', now)).toBe(30_000);
    });

    it.each([null, '', 'not-a-date'])('returns null for %s', (h) => {
        expect(parseRetryAfter(h as string | null)).toBeNull();
    });

    it('returns null for a date already in the past', () => {
        const now = Date.parse('2026-08-17T10:00:00Z');
        expect(parseRetryAfter('Mon, 17 Aug 2026 09:59:00 GMT', now)).toBeNull();
    });
});

describe('createResilientFetch', () => {
    it('does NOT retry a 401 — a revoked credential delays every tenant behind it', async () => {
        const fetchImpl = jest.fn(async () => res(401));
        const r = recorder();
        const f = createResilientFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, ...r });

        await expect(f('https://okta.example.com/api/v1/users')).rejects.toBeInstanceOf(
            IntegrationAuthError,
        );
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(r.slept).toEqual([]);
    });

    it('does not retry a 404, and does not blame the credential for it', async () => {
        // The narrowness is the whole point. H1-3 keys the connection-revoked
        // banner on IntegrationAuthError; a deleted group must not raise it.
        const fetchImpl = jest.fn(async () => res(404));
        const r = recorder();
        const f = createResilientFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, ...r });

        const err = await f('https://okta.example.com/api/v1/groups/gone').catch((e) => e);
        expect(err).toBeInstanceOf(IntegrationTerminalError);
        expect(err).not.toBeInstanceOf(IntegrationAuthError);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(r.slept).toEqual([]);
    });

    it.each([401, 403, 404, 429])(
        'never puts the query string in a %d error message',
        async (status) => {
            // These messages are PERSISTED to
            // IntegrationConnection.authFailureReason and rendered in the UI, so
            // a raw URL here writes an access token from the query string into
            // the database and then onto a screen.
            const fetchImpl = jest.fn(async () => res(status, { 'retry-after': '600' }));
            const f = createResilientFetch({
                fetchImpl: fetchImpl as unknown as typeof fetch,
                ...recorder(),
            });

            const err = await f(
                'https://api.example.com/v1/users?access_token=SECRET123&api_key=ALSOSECRET',
            ).catch((e) => e);

            expect(err.message).not.toContain('SECRET123');
            expect(err.message).not.toContain('ALSOSECRET');
            expect(err.message).not.toContain('access_token');
            // Still useful for debugging — host and path survive.
            expect(err.message).toContain('api.example.com/v1/users');
        },
    );

    it('honours Retry-After on a 429 rather than guessing', async () => {
        const fetchImpl = jest
            .fn()
            .mockResolvedValueOnce(res(429, { 'retry-after': '2' }))
            .mockResolvedValueOnce(res(200));
        const r = recorder();
        const f = createResilientFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, ...r });

        const out = await f('https://graph.microsoft.com/v1.0/users');
        expect(out.status).toBe(200);
        expect(r.slept).toEqual([2_000]);
    });

    it('refuses to absorb a throttle longer than the budget', async () => {
        // Holding a worker idle for five minutes starves the fan-out just as
        // effectively as a hung socket. End the tick; the next run retries.
        const fetchImpl = jest.fn(async () => res(429, { 'retry-after': '600' }));
        const r = recorder();
        const f = createResilientFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, ...r });

        const err = await f('https://okta.example.com/x').catch((e) => e);
        expect(err).toBeInstanceOf(IntegrationRateLimitedError);
        expect(err.retryAfterMs).toBe(600_000);
        expect(err.retryAfterMs).toBeGreaterThan(MAX_ABSORBED_RETRY_AFTER_MS);
        // The point: it did not wait, and it did not hammer.
        expect(r.slept).toEqual([]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('backs off with JITTER when the server sends no Retry-After', async () => {
        // Lockstep retries across a fan-out re-create the thundering herd the
        // backoff was meant to prevent.
        const fetchImpl = jest
            .fn()
            .mockResolvedValueOnce(res(503))
            .mockResolvedValueOnce(res(200));
        const r = recorder();
        const f = createResilientFetch({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            rand: () => 0.5,
            ...r,
        });

        await f('https://api.example.com/x');
        expect(r.slept).toHaveLength(1);
        expect(r.slept[0]).toBe(500); // 0.5 * (1000 * 2^0)
    });

    it('gives up after the attempt cap instead of retrying forever', async () => {
        const fetchImpl = jest.fn(async () => res(429));
        const r = recorder();
        const f = createResilientFetch({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            maxAttempts: 3,
            rand: () => 0,
            ...r,
        });

        await expect(f('https://api.example.com/x')).rejects.toBeInstanceOf(
            IntegrationRateLimitedError,
        );
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('retries a timeout, since a slow remote may simply be slow', async () => {
        const fetchImpl = jest
            .fn()
            .mockRejectedValueOnce(new IntegrationTimeoutError('https://api.example.com/x', 30_000))
            .mockResolvedValueOnce(res(200));
        const r = recorder();
        const f = createResilientFetch({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            rand: () => 0,
            ...r,
        });

        expect((await f('https://api.example.com/x')).status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('passes a success straight through without sleeping', async () => {
        const ok = res(200);
        const fetchImpl = jest.fn(async () => ok);
        const r = recorder();
        const f = createResilientFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, ...r });

        expect(await f('https://api.example.com/x')).toBe(ok);
        expect(r.slept).toEqual([]);
    });
});

describe('classifyError', () => {
    it('a terminal auth error stays terminal', () => {
        expect(classifyError(new IntegrationAuthError(403, 'https://x/y'))).toBe('terminal');
    });

    it('a non-auth terminal error is also terminal', () => {
        // Both stop the retry loop; only one accuses the credential.
        expect(classifyError(new IntegrationTerminalError(404, 'https://x/y'))).toBe('terminal');
    });

    it('a timeout is retryable', () => {
        expect(classifyError(new IntegrationTimeoutError('https://x/y', 1))).toBe('retryable');
    });

    it('an unknown throw is retryable — a network blip is the common case', () => {
        expect(classifyError(new TypeError('fetch failed'))).toBe('retryable');
    });
});
