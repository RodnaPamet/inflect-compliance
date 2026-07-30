/**
 * Unit Test: Epic A.3 breached-password check (HIBP k-anonymity).
 *
 * Pins the privacy contract and the fail-open behaviour:
 *   - only the SHA-1 prefix is sent to HIBP (never the password,
 *     never the full hash)
 *   - network errors / timeouts / 5xx → `skipped: true`, never throw
 *   - padded zero-count entries in the response are ignored
 *   - minOccurrences threshold works
 *   - no password/hash material is written to logs
 */

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';
import { logger } from '@/lib/observability/logger';

/** SHA-1 of 'password' is 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8. */
const SHA1_OF_PASSWORD = '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8'; // pragma: allowlist secret — public SHA-1 of the literal string 'password'
const SHA1_PREFIX_OF_PASSWORD = SHA1_OF_PASSWORD.slice(0, 5); // '5BAA6'
const SHA1_SUFFIX_OF_PASSWORD = SHA1_OF_PASSWORD.slice(5);    // '1E4C9B93F3F0682250B6CF8331B7EE68FD8'

/** Build a fake HIBP range response with given (suffix,count) tuples. */
function hibpResponse(entries: Array<[string, number]>): string {
    return entries.map(([s, c]) => `${s}:${c}`).join('\r\n') + '\r\n';
}

describe('checkPasswordAgainstHIBP', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('sends ONLY the 5-char SHA-1 prefix to HIBP (k-anonymity)', async () => {
        const fetchImpl = jest.fn(async (url: string) => {
            // The URL must end with exactly the 5-char prefix. No suffix.
            expect(url).toMatch(/\/5BAA6$/);
            return new Response(hibpResponse([[SHA1_SUFFIX_OF_PASSWORD, 12345]]));
        });
        await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as unknown as typeof fetch,
            endpoint: 'https://example/range',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const url = fetchImpl.mock.calls[0][0];
        // Sanity: the full hash is NEVER in the URL.
        expect(url).not.toContain(SHA1_OF_PASSWORD);
        expect(url).not.toContain(SHA1_SUFFIX_OF_PASSWORD);
    });

    it('reports breached=true when the suffix matches with count > 0', async () => {
        const fetchImpl = async () =>
            new Response(hibpResponse([[SHA1_SUFFIX_OF_PASSWORD, 9_999_999]]));
        const result = await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as typeof fetch,
            endpoint: 'https://example/range',
        });
        expect(result.breached).toBe(true);
        if (result.breached) expect(result.occurrences).toBe(9_999_999);
    });

    it('reports breached=false when the suffix is not in the response', async () => {
        const fetchImpl = async () =>
            new Response(hibpResponse([
                ['DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBE', 5],
                ['CAFEBABECAFEBABECAFEBABECAFEBABECAFEBA', 10],
            ]));
        const result = await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as typeof fetch,
            endpoint: 'https://example/range',
        });
        expect(result.breached).toBe(false);
    });

    it('ignores padded zero-count decoy entries (HIBP Add-Padding)', async () => {
        const fetchImpl = async () =>
            new Response(hibpResponse([
                [SHA1_SUFFIX_OF_PASSWORD, 0], // the padded decoy
            ]));
        const result = await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as typeof fetch,
            endpoint: 'https://example/range',
        });
        // Count of 0 means this is padding — NOT a real match.
        expect(result.breached).toBe(false);
    });

    it('respects minOccurrences threshold', async () => {
        const fetchImpl = async () =>
            new Response(hibpResponse([[SHA1_SUFFIX_OF_PASSWORD, 3]]));
        const result = await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as typeof fetch,
            endpoint: 'https://example/range',
            minOccurrences: 10,
        });
        expect(result.breached).toBe(false);
    });

    it('sends Add-Padding header to prevent prefix-size leakage', async () => {
        const fetchImpl = jest.fn(
            (_url: string, _init?: RequestInit) =>
                Promise.resolve(new Response(hibpResponse([]))),
        );
        await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as unknown as typeof fetch,
            endpoint: 'https://example/range',
        });
        const [, init] = fetchImpl.mock.calls[0];
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.['Add-Padding']).toBe('true');
    });

    it('fails open on a 5xx upstream error (breached=false, skipped=true)', async () => {
        const fetchImpl = async () => new Response('boom', { status: 503 });
        const result = await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as typeof fetch,
            endpoint: 'https://example/range',
        });
        expect(result.breached).toBe(false);
        if ('skipped' in result) {
            expect(result.skipped).toBe(true);
            expect(result.reason).toBe('upstream_error');
        } else {
            throw new Error('expected skipped result');
        }
    });

    it('fails open on a fetch throw (network error)', async () => {
        const fetchImpl = async () => {
            throw new TypeError('fetch failed');
        };
        const result = await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as typeof fetch,
            endpoint: 'https://example/range',
        });
        expect(result.breached).toBe(false);
        if ('skipped' in result) {
            expect(result.reason).toBe('network');
        }
    });

    it('fails open on an AbortError (timeout)', async () => {
        const fetchImpl = async () => {
            const err = new Error('timeout');
            err.name = 'AbortError';
            throw err;
        };
        const result = await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as typeof fetch,
            endpoint: 'https://example/range',
        });
        expect(result.breached).toBe(false);
        if ('skipped' in result) expect(result.reason).toBe('timeout');
    });

    it('aborts the request after the configured timeout', async () => {
        let receivedSignal: AbortSignal | undefined;
        const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
            receivedSignal = init?.signal ?? undefined;
            // Emulate a slow endpoint — resolve only after the abort fires.
            await new Promise((resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
                setTimeout(() => resolve(undefined), 500); // longer than timeout
            });
            return new Response('');
        });

        const result = await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as unknown as typeof fetch,
            endpoint: 'https://example/range',
            timeoutMs: 50,
        });

        // Assert the abort WON, unconditionally.
        //
        // This used to read `if ('skipped' in result) expect(reason)…`, which
        // passes silently when the timeout never fires — so the only thing
        // actually proving the abort worked was a wall-clock
        // `expect(elapsed).toBeLessThan(400)`. That made the test both weak
        // and flaky: on a loaded runner the 50 ms abort can land after the
        // 400 ms budget, failing a correct implementation, while a genuinely
        // broken abort could slip through the conditional.
        //
        // `skipped` + reason 'timeout' is only reachable via the abort path
        // (the stub endpoint otherwise resolves a 200 at 500 ms, which would
        // parse as a clean not-breached result with no `skipped` key), so
        // asserting it directly proves what the elapsed check was groping
        // for — with no dependency on how busy the machine is.
        expect(result.breached).toBe(false);
        expect('skipped' in result).toBe(true);
        if ('skipped' in result) expect(result.reason).toBe('timeout');
        expect(receivedSignal).toBeDefined();
    });

    it('never logs the password or the full hash', async () => {
        const fetchImpl = async () => new Response('boom', { status: 503 });
        await checkPasswordAgainstHIBP('hunter2', {
            fetchImpl: fetchImpl as typeof fetch,
            endpoint: 'https://example/range',
        });
        // Every warn call's fields must not contain the plaintext OR
        // the full SHA-1 hash OR even the suffix.
        const sha1OfHunter2 = 'F3BBBD66A63D4BF1747940578EC3D0103530E21D';
        for (const call of (logger.warn as jest.Mock).mock.calls) {
            const serialised = JSON.stringify(call);
            expect(serialised).not.toContain('hunter2');
            expect(serialised).not.toContain(sha1OfHunter2);
            expect(serialised).not.toContain(sha1OfHunter2.slice(5));
        }
    });

    it('handles entries with extra whitespace from HIBP', async () => {
        const body = `${SHA1_SUFFIX_OF_PASSWORD}:7  \r\n`;
        const fetchImpl = async () => new Response(body);
        const result = await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as typeof fetch,
            endpoint: 'https://example/range',
        });
        expect(result.breached).toBe(true);
        if (result.breached) expect(result.occurrences).toBe(7);
    });

    it('handles blank lines and malformed rows gracefully', async () => {
        const body = `\r\nBADROW\r\n${SHA1_SUFFIX_OF_PASSWORD}:2\r\n`;
        const fetchImpl = async () => new Response(body);
        const result = await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as typeof fetch,
            endpoint: 'https://example/range',
        });
        expect(result.breached).toBe(true);
    });

    it('sanity: prefix calculation matches the known-good vector', async () => {
        const fetchImpl = jest.fn(async (url: string) => {
            expect(url).toContain(`/${SHA1_PREFIX_OF_PASSWORD}`);
            return new Response('');
        });
        await checkPasswordAgainstHIBP('password', {
            fetchImpl: fetchImpl as unknown as typeof fetch,
            endpoint: 'https://example/range',
        });
    });
});
