/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for the typed API client.
 * Tests error handling, happy paths, and dev-mode Zod validation.
 */
import { apiGet, apiPost, apiPatch, apiDelete, ApiClientError } from '@/lib/api-client';
import {
    isSessionExpired,
    __resetSessionExpiryForTests,
} from '@/lib/auth/session-expiry';

// ── Mock fetch ──

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

beforeEach(() => {
    mockFetch.mockReset();
});

describe('apiGet', () => {
    it('returns parsed JSON on success', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: '1', name: 'Test Control' }),
        });

        const result = await apiGet<{ id: string; name: string }>('http://localhost/api/controls/1');
        expect(result).toEqual({ id: '1', name: 'Test Control' });
        expect(mockFetch).toHaveBeenCalledWith('http://localhost/api/controls/1', { method: 'GET' });
    });

    it('throws ApiClientError on 404 with standard error body', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
            json: async () => ({
                error: { code: 'NOT_FOUND', message: 'Control not found', requestId: 'req-123' },
            }),
        });

        try {
            await apiGet('http://localhost/api/controls/999');
            fail('Should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ApiClientError);
            const apiErr = err as ApiClientError;
            expect(apiErr.code).toBe('NOT_FOUND');
            expect(apiErr.message).toBe('Control not found');
            expect(apiErr.status).toBe(404);
            expect(apiErr.requestId).toBe('req-123');
        }
    });

    it('throws ApiClientError with fallback on non-JSON error body', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            json: async () => { throw new Error('not JSON'); },
        });

        try {
            await apiGet('http://localhost/api/controls/1');
            fail('Should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ApiClientError);
            const apiErr = err as ApiClientError;
            expect(apiErr.code).toBe('UNKNOWN');
            expect(apiErr.status).toBe(500);
        }
    });
});

describe('apiPost', () => {
    it('sends JSON body and returns parsed response', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: '2', name: 'New Control' }),
        });

        const result = await apiPost<{ id: string; name: string }>(
            'http://localhost/api/controls',
            { name: 'New Control' },
        );
        expect(result).toEqual({ id: '2', name: 'New Control' });
        expect(mockFetch).toHaveBeenCalledWith('http://localhost/api/controls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'New Control' }),
        });
    });

    it('throws ApiClientError on validation error', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: async () => ({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request payload',
                    details: [{ path: ['name'], code: 'too_small', message: 'Name is required' }],
                },
            }),
        });

        try {
            await apiPost('http://localhost/api/controls', {});
            fail('Should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ApiClientError);
            const apiErr = err as ApiClientError;
            expect(apiErr.code).toBe('VALIDATION_ERROR');
            expect(apiErr.status).toBe(400);
            expect(apiErr.details).toEqual([
                { path: ['name'], code: 'too_small', message: 'Name is required' },
            ]);
        }
    });
});

describe('apiPatch', () => {
    it('sends PATCH request with JSON body', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: '1', name: 'Updated' }),
        });

        const result = await apiPatch<{ id: string; name: string }>(
            'http://localhost/api/controls/1',
            { name: 'Updated' },
        );
        expect(result).toEqual({ id: '1', name: 'Updated' });
        expect(mockFetch).toHaveBeenCalledWith('http://localhost/api/controls/1', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Updated' }),
        });
    });
});

describe('apiDelete', () => {
    it('sends DELETE request and returns void', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true });

        await expect(apiDelete('http://localhost/api/controls/1')).resolves.toBeUndefined();
        expect(mockFetch).toHaveBeenCalledWith('http://localhost/api/controls/1', {
            method: 'DELETE',
        });
    });

    it('throws ApiClientError on failed delete', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 403,
            json: async () => ({
                error: { code: 'FORBIDDEN', message: 'Not allowed' },
            }),
        });

        try {
            await apiDelete('http://localhost/api/controls/1');
            fail('Should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ApiClientError);
            const apiErr = err as ApiClientError;
            expect(apiErr.code).toBe('FORBIDDEN');
            expect(apiErr.status).toBe(403);
        }
    });
});

describe('ApiClientError', () => {
    it('has correct name and properties', () => {
        const err = new ApiClientError('test message', 'TEST', 418, { detail: 'x' }, 'req-1');
        expect(err.name).toBe('ApiClientError');
        expect(err.message).toBe('test message');
        expect(err.code).toBe('TEST');
        expect(err.status).toBe(418);
        expect(err.details).toEqual({ detail: 'x' });
        expect(err.requestId).toBe('req-1');
        expect(err).toBeInstanceOf(Error);
    });
});

// ─────────────────────────────────────────────────────────────────────
// Branch coverage for the error-parsing fallbacks and the dev-mode Zod
// validation gate (issue #2214 — `./src/lib/` branch floor).
//
// The suite above exercises the happy paths and the "body is not JSON"
// fallback. What follows covers the branches a regression would take
// silently: a well-formed JSON body that carries NO `error` envelope, an
// `error` envelope missing `code` or `message`, and the three states of
// `validateIfDev` (no schema / dev-validated / production-skipped).
// ─────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * `process.env.NODE_ENV` is declared read-only by @types/node, and this
 * repo augments `NodeJS.ProcessEnv` so NODE_ENV is REQUIRED — a fresh
 * object literal would not satisfy it. Mutating through one narrowed
 * index signature is the deliberate, single cast site for these tests.
 */
function setNodeEnv(value: string | undefined): void {
    const bag = process.env as unknown as Record<string, string | undefined>;
    if (value === undefined) delete bag.NODE_ENV;
    else bag.NODE_ENV = value;
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
    setNodeEnv(ORIGINAL_NODE_ENV);
    jest.restoreAllMocks();
});

describe('handleErrorResponse — error-envelope fallbacks', () => {
    it('uses status-derived defaults when the JSON body has NO `error` envelope', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 502,
            json: async () => ({ message: 'upstream exploded' }),
        });

        await expect(apiGet('http://localhost/api/x')).rejects.toMatchObject({
            code: 'UNKNOWN',
            status: 502,
            message: 'Request failed with status 502',
        });
    });

    // NOTE — this pins the OUTCOME for a null body, not the `body?.error`
    // optional chain. Those two implementations are behaviourally
    // indistinguishable from outside: with the chain, `if` is false and the
    // function falls through to the throw; without it, `null.error` throws a
    // TypeError that the very same `catch` swallows, reaching the same throw
    // with the same defaults. Verified by mutation — dropping the `?.` leaves
    // this whole file green. Do not read this test as protecting that guard.
    it('uses status-derived defaults when the JSON body is literally null', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 503,
            json: async () => null,
        });

        const err = await apiGet('http://localhost/api/x').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiClientError);
        expect((err as ApiClientError).code).toBe('UNKNOWN');
        expect((err as ApiClientError).message).toBe('Request failed with status 503');
        expect((err as ApiClientError).details).toBeUndefined();
        expect((err as ApiClientError).requestId).toBeUndefined();
    });

    it('falls back to UNKNOWN when the envelope carries a message but no code', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 422,
            json: async () => ({ error: { message: 'Unprocessable' } }),
        });

        const err = (await apiGet('http://localhost/api/x').catch(
            (e: unknown) => e,
        )) as ApiClientError;
        expect(err.code).toBe('UNKNOWN');
        // The server-supplied message must still win over the default.
        expect(err.message).toBe('Unprocessable');
        expect(err.status).toBe(422);
    });

    it('falls back to the status message when the envelope has a code but no message', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 409,
            json: async () => ({ error: { code: 'CONFLICT' } }),
        });

        const err = (await apiGet('http://localhost/api/x').catch(
            (e: unknown) => e,
        )) as ApiClientError;
        expect(err.code).toBe('CONFLICT');
        expect(err.message).toBe('Request failed with status 409');
    });

    it('treats an empty-string code/message as absent (|| fallback, not ??)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: async () => ({ error: { code: '', message: '' } }),
        });

        const err = (await apiGet('http://localhost/api/x').catch(
            (e: unknown) => e,
        )) as ApiClientError;
        expect(err.code).toBe('UNKNOWN');
        expect(err.message).toBe('Request failed with status 400');
    });

    it('propagates the same fallbacks through apiPost / apiPatch / apiDelete', async () => {
        for (const call of [
            () => apiPost('http://localhost/api/x', {}),
            () => apiPatch('http://localhost/api/x', {}),
            () => apiDelete('http://localhost/api/x'),
        ]) {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                json: async () => ({ notAnError: true }),
            });
            await expect(call()).rejects.toMatchObject({
                code: 'UNKNOWN',
                status: 500,
                message: 'Request failed with status 500',
            });
        }
    });
});

describe('validateIfDev — dev/test-only Zod response validation', () => {
    const schema = z.object({
        id: z.string(),
        nested: z.object({ deep: z.string() }),
    });

    it('returns data untouched and never warns when the payload is valid', async () => {
        setNodeEnv('test');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const payload = { id: 'a', nested: { deep: 'b' } };
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });

        const result = await apiGet('http://localhost/api/x', schema);
        expect(result).toStrictEqual(payload);
        expect(warn).not.toHaveBeenCalled();
    });

    it('WARNS but does not throw on an invalid payload, and returns the ORIGINAL data', async () => {
        setNodeEnv('test');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        // Two failures, one of them nested, plus an extra key the schema
        // does not declare — asserting the extra key survives proves the
        // client returns the raw body rather than a parsed/stripped copy.
        const payload = { id: 42, nested: { deep: 7 }, extra: 'kept' };
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });

        const result = await apiGet('http://localhost/api/x', schema);
        expect(result).toStrictEqual(payload);

        expect(warn).toHaveBeenCalledTimes(1);
        const [label, detail] = warn.mock.calls[0] as [string, string];
        expect(label).toBe('[api-client] Response validation failed:');
        // Nested paths are dot-joined and multiple issues semicolon-joined.
        expect(detail).toContain('id: ');
        expect(detail).toContain('nested.deep: ');
        expect(detail).toContain('; ');
    });

    it('validates in `development` too, not just `test`', async () => {
        setNodeEnv('development');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 1 }) });

        await apiGet('http://localhost/api/x', schema);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('SKIPS validation entirely outside dev/test — safeParse is never called', async () => {
        setNodeEnv('production');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const safeParse = jest.spyOn(schema, 'safeParse');
        const payload = { totally: 'wrong' };
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });

        const result = await apiGet('http://localhost/api/x', schema);
        expect(result).toStrictEqual(payload);
        // The production posture is "never spend the cycles, never warn".
        expect(safeParse).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    it('skips validation when NODE_ENV is unset', async () => {
        setNodeEnv(undefined);
        const safeParse = jest.spyOn(schema, 'safeParse');
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 1 }) });

        await apiGet('http://localhost/api/x', schema);
        expect(safeParse).not.toHaveBeenCalled();
    });

    it('skips validation when NO schema is supplied, even in test env', async () => {
        setNodeEnv('test');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ anything: true }) });

        const result = await apiGet('http://localhost/api/x');
        expect(result).toStrictEqual({ anything: true });
        expect(warn).not.toHaveBeenCalled();
    });

    it('applies the same gate on apiPost and apiPatch', async () => {
        setNodeEnv('test');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 1 }) });
        await apiPost('http://localhost/api/x', {}, schema);
        expect(warn).toHaveBeenCalledTimes(1);

        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 2 }) });
        await apiPatch('http://localhost/api/x', {}, schema);
        expect(warn).toHaveBeenCalledTimes(2);
    });
});

describe('init overrides', () => {
    it('lets callers add headers/signal without losing the method', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
        const controller = new AbortController();

        await apiGet('http://localhost/api/x', undefined, {
            headers: { 'X-Trace': '1' },
            signal: controller.signal,
        });

        expect(mockFetch).toHaveBeenCalledWith('http://localhost/api/x', {
            method: 'GET',
            headers: { 'X-Trace': '1' },
            signal: controller.signal,
        });
    });

    it('spreads init AFTER the defaults, so a caller-supplied header object replaces the JSON one', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

        await apiPost('http://localhost/api/x', { a: 1 }, undefined, {
            headers: { 'Content-Type': 'text/plain' },
        });

        // Documents the precedence: `{...defaults, ...init}` means the
        // caller wins. Body is still the serialised default.
        expect(mockFetch).toHaveBeenCalledWith('http://localhost/api/x', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ a: 1 }),
        });
    });
});

describe('#2222 — the 401 seam in handleErrorResponse', () => {
    beforeEach(() => {
        __resetSessionExpiryForTests();
    });

    afterEach(() => {
        __resetSessionExpiryForTests();
    });

    it('marks the session expired on a 401 and still throws the typed error', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            url: 'https://app.example.com/api/t/acme/controls',
            json: async () => ({ error: 'Unauthorized' }),
        });

        await expect(
            apiGet('https://app.example.com/api/t/acme/controls'),
        ).rejects.toBeInstanceOf(ApiClientError);
        expect(isSessionExpired()).toBe(true);
    });

    it('covers the NON-SWR verbs too — apiPost is not reachable from SWR onError', async () => {
        // This is the half `SWRConfig`'s `onError` cannot see: `apiGet` is the
        // `useTenantSWR` fetcher, but `apiPost`/`apiPut`/`apiPatch`/`apiDelete`
        // are called directly. Both writers exist because they cover disjoint
        // halves of the call graph.
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            url: 'https://app.example.com/api/t/acme/risks',
            json: async () => ({ error: 'Unauthorized' }),
        });

        await expect(
            apiPost('https://app.example.com/api/t/acme/risks', { a: 1 }),
        ).rejects.toBeInstanceOf(ApiClientError);
        expect(isSessionExpired()).toBe(true);
    });

    it('does NOT mark on a 403 — a permission denial is not a session verdict', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 403,
            url: 'https://app.example.com/api/t/acme/admin/scim',
            json: async () => ({
                error: { code: 'FORBIDDEN', message: 'Permission denied' },
            }),
        });

        await expect(
            apiGet('https://app.example.com/api/t/acme/admin/scim'),
        ).rejects.toBeInstanceOf(ApiClientError);
        // An EDITOR hitting an admin endpoint is correctly signed in. Signing
        // them out would also render a hash-chained AUTHZ_DENIED as an auth
        // failure.
        expect(isSessionExpired()).toBe(false);
    });

    it.each([404, 429, 500, 503])(
        'does NOT mark on %i — a blip must not kill every poller',
        async (status) => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status,
                url: 'https://app.example.com/api/t/acme/controls',
                json: async () => ({}),
            });

            await expect(
                apiGet('https://app.example.com/api/t/acme/controls'),
            ).rejects.toBeInstanceOf(ApiClientError);
            expect(isSessionExpired()).toBe(false);
        },
    );
});
