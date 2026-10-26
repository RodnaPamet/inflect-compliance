/**
 * @jest-environment jsdom
 */
/**
 * Behavioural coverage for the generic data-fetching hooks in
 * `src/lib/hooks/use-api.ts` — `useApi` (SWR-style GET + Zod-validate
 * via `apiGet`) and `useMutation` (loading/error wrapper around an
 * async mutation fn).
 *
 * These hooks were genuinely 0% — not loaded by any test. Each case
 * below exercises one branch of the hook body:
 *   - useApi: happy GET, null-url skip, refetch, error-capture.
 *   - useMutation: happy resolve, reject → error-state + rethrow.
 *
 * `globalThis.fetch` is stubbed (apiGet/apiPost/etc. all funnel
 * through fetch). The file lives under the node project but opts into
 * jsdom via the docblock so `renderHook` has a DOM + real React
 * lifecycle.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { z } from 'zod';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { ApiClientError } from '@/lib/api-client';

const originalFetch = globalThis.fetch;

function mockFetchJson(payload: unknown) {
    globalThis.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => payload,
    })) as unknown as typeof fetch;
}

function mockFetchError(status = 500) {
    globalThis.fetch = jest.fn(async () => ({
        ok: false,
        status,
        json: async () => ({ error: { code: 'BOOM', message: 'kaboom' } }),
    })) as unknown as typeof fetch;
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
});

describe('useApi', () => {
    const Schema = z.array(z.object({ id: z.string() }));

    it('fetches on mount, validates, and exposes data with loading=false', async () => {
        mockFetchJson([{ id: 'a' }, { id: 'b' }]);

        const { result } = renderHook(() =>
            useApi('/api/t/acme/things', Schema),
        );

        // Initial render: loading reflects the truthy url.
        expect(result.current.loading).toBe(true);

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toEqual([{ id: 'a' }, { id: 'b' }]);
        expect(result.current.error).toBeNull();
    });

    it('skips fetching when url is null (loading=false, data=null)', async () => {
        const spy = jest.fn();
        globalThis.fetch = spy as unknown as typeof fetch;

        const { result } = renderHook(() => useApi(null, Schema));

        expect(result.current.loading).toBe(false);
        expect(result.current.data).toBeNull();
        // Give any stray effect a tick — must NOT fetch.
        await act(async () => {
            await Promise.resolve();
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('refetch re-runs the request and refreshes data', async () => {
        mockFetchJson([{ id: 'first' }]);

        const { result } = renderHook(() => useApi('/api/t/acme/things', Schema));
        await waitFor(() => expect(result.current.data).toEqual([{ id: 'first' }]));

        mockFetchJson([{ id: 'second' }]);
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.data).toEqual([{ id: 'second' }]);
    });

    it('captures an ApiClientError on a non-2xx response', async () => {
        mockFetchError(500);

        const { result } = renderHook(() => useApi('/api/t/acme/things', Schema));
        await waitFor(() => expect(result.current.loading).toBe(false));

        expect(result.current.error).toBeInstanceOf(ApiClientError);
        expect(result.current.data).toBeNull();
    });
});

describe('useMutation', () => {
    it('resolves the mutation and toggles loading false afterwards', async () => {
        const fn = jest.fn(async (input: { name: string }) => ({ ok: input.name }));
        const { result } = renderHook(() => useMutation(fn));

        expect(result.current.loading).toBe(false);

        let returned: { ok: string } | undefined;
        await act(async () => {
            returned = await result.current.mutate({ name: 'x' });
        });

        expect(returned).toEqual({ ok: 'x' });
        expect(fn).toHaveBeenCalledWith({ name: 'x' });
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('sets error state and rethrows when the mutation rejects', async () => {
        const boom = new Error('mutation failed');
        const fn = jest.fn(async () => {
            throw boom;
        });
        const { result } = renderHook(() => useMutation(fn));

        await act(async () => {
            await expect(result.current.mutate(undefined)).rejects.toThrow(
                'mutation failed',
            );
        });

        expect(result.current.error).toBe(boom);
        expect(result.current.loading).toBe(false);
    });

    it('wraps a non-Error throw into an Error before surfacing it', async () => {
        const fn = jest.fn(async () => {
            throw 'plain string failure';
        });
        const { result } = renderHook(() => useMutation(fn));

        await act(async () => {
            await expect(result.current.mutate(undefined)).rejects.toThrow(
                'plain string failure',
            );
        });

        expect(result.current.error).toBeInstanceOf(Error);
    });
});
