/**
 * `useEntityListIds` — the single reader behind every detail page's
 * prev/next stepper.
 *
 * Both of its jobs have already been got wrong once in this repo, and
 * both fail SILENTLY (the nav renders nothing rather than throwing), so
 * each gets a test that goes red on the actual regression:
 *
 *   1. **Shape tolerance.** The list routes disagree — a bare array
 *      (`incidents`), the plain `{ rows, truncated }` envelope
 *      (`assets`, `tasks`), and the envelope spread with extra keys
 *      (`risks`, `controls`, `policies`, `vendors` all add `kpiCounts`).
 *      A hand-rolled `Array.isArray` guard yielded `[]` for the
 *      envelope and hid the arrows for two weeks (#2032).
 *   2. **Memo identity.** The memo must key on the RAW cache value.
 *      Keying it on `idsFromCappedList(...)` — which returns a fresh
 *      array every call — defeats the memo and hands the nav a new
 *      array identity on every render.
 */

import { renderHook } from '@testing-library/react';

import { useEntityListIds } from '@/lib/hooks/use-entity-list-ids';

const mockUseTenantSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockUseTenantSWR(...args),
}));

beforeEach(() => {
    mockUseTenantSWR.mockReset();
});

/** Point the mocked SWR read at a fixed cache value. */
function withData(data: unknown) {
    mockUseTenantSWR.mockReturnValue({ data });
}

describe('useEntityListIds — shape tolerance', () => {
    it('reads the plain { rows } envelope (assets, tasks)', () => {
        withData({ rows: [{ id: 'a' }, { id: 'b' }], truncated: false });
        const { result } = renderHook(() => useEntityListIds('/assets'));
        expect(result.current).toEqual(['a', 'b']);
    });

    it('reads a bare array (incidents)', () => {
        withData([{ id: 'i1' }, { id: 'i2' }]);
        const { result } = renderHook(() => useEntityListIds('/incidents'));
        expect(result.current).toEqual(['i1', 'i2']);
    });

    it('reads the envelope spread alongside extra keys (risks, controls, policies, vendors)', () => {
        // `{ ...result, kpiCounts }` — the shape that broke the isArray guard.
        withData({ rows: [{ id: 'r1' }], truncated: false, kpiCounts: { high: 1 } });
        const { result } = renderHook(() => useEntityListIds('/risks'));
        expect(result.current).toEqual(['r1']);
    });

    it('preserves list order — stepping walks the sequence the user saw', () => {
        withData({ rows: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] });
        const { result } = renderHook(() => useEntityListIds('/risks'));
        expect(result.current).toEqual(['c', 'a', 'b']);
    });

    it('yields [] for an unloaded cache, so the nav hides instead of pointing nowhere', () => {
        withData(undefined);
        const { result } = renderHook(() => useEntityListIds('/risks'));
        expect(result.current).toEqual([]);
    });

    it('yields [] for a malformed body rather than taking the page down', () => {
        withData({ error: { code: 'boom' } });
        const { result } = renderHook(() => useEntityListIds('/risks'));
        expect(result.current).toEqual([]);
    });

    it('drops rows with no id', () => {
        withData({ rows: [{ id: 'a' }, {}, { id: '' }, { id: 'b' }] });
        const { result } = renderHook(() => useEntityListIds('/risks'));
        expect(result.current).toEqual(['a', 'b']);
    });
});

describe('useEntityListIds — memo identity', () => {
    it('returns a STABLE array reference while the cache value is unchanged', () => {
        // The regression this catches: keying the memo on the helper's
        // return value instead of on `data`. The ids would be equal but
        // the reference new on every render, so `EntityPrevNextNav` would
        // see a changed `ids` prop each pass.
        const data = { rows: [{ id: 'a' }, { id: 'b' }] };
        withData(data);

        const { result, rerender } = renderHook(() => useEntityListIds('/risks'));
        const first = result.current;
        rerender();
        rerender();

        expect(result.current).toBe(first);
    });

    it('returns a NEW reference once the cache value actually changes', () => {
        withData({ rows: [{ id: 'a' }] });
        const { result, rerender } = renderHook(() => useEntityListIds('/risks'));
        const first = result.current;

        withData({ rows: [{ id: 'a' }, { id: 'b' }] });
        rerender();

        expect(result.current).not.toBe(first);
        expect(result.current).toEqual(['a', 'b']);
    });
});

describe('useEntityListIds — conditional read', () => {
    it('passes the list key straight through to the SWR read', () => {
        withData({ rows: [] });
        renderHook(() => useEntityListIds('/risks'));
        expect(mockUseTenantSWR).toHaveBeenCalledWith('/risks');
    });

    it('passes null through so a caller can skip the fetch entirely', () => {
        withData(undefined);
        const { result } = renderHook(() => useEntityListIds(null));
        expect(mockUseTenantSWR).toHaveBeenCalledWith(null);
        expect(result.current).toEqual([]);
    });
});
