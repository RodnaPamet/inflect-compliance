/**
 * `usePublishDisplayedOrder` + `useEntityListIds` — the two halves of the
 * prev/next stepper's id source.
 *
 * The headline regression (#107) is an ORDER bug, so the tests that matter
 * are the round-trip ones: a "list page" publishes the order it rendered, a
 * "detail page" reads it, and the assertion is that the read answers with the
 * DISPLAYED order rather than the server order sitting in the list cache.
 * Those two orders are deliberately different in every fixture below — a read
 * that ignored the published entry would return the server order and fail.
 *
 * Both hooks also fail SILENTLY when wrong (the nav renders nothing rather
 * than throwing), so the older invariants are kept alongside:
 *
 *   1. **Shape tolerance.** The list routes disagree — a bare array
 *      (`incidents`), the plain `{ rows, truncated }` envelope (`assets`,
 *      `tasks`), and the envelope spread with extra keys (`risks`,
 *      `controls`, `policies`, `vendors` all add `kpiCounts`). A hand-rolled
 *      `Array.isArray` guard yielded `[]` for the envelope and hid the arrows
 *      for two weeks (#2032).
 *   2. **Memo identity.** The returned array must keep its reference while
 *      the ids are unchanged, or `EntityPrevNextNav` sees a new `ids` prop
 *      every render.
 *
 * SWR itself is REAL here, not mocked: the publish → navigate → read handoff
 * IS the SWR cache, and mocking it away would leave the round trip untested.
 * Only the list-endpoint read (`useTenantSWR`) is stubbed, so a fixture can
 * pin the server order the fallback would produce.
 */

import * as React from 'react';
import { renderHook } from '@testing-library/react';
import { SWRConfig } from 'swr';

let currentSlug: string | undefined = 'acme';
jest.mock('next/navigation', () => ({
    useParams: () => (currentSlug === undefined ? {} : { tenantSlug: currentSlug }),
}));

const mockUseTenantSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockUseTenantSWR(...args),
}));

import {
    useEntityListIds,
    usePublishDisplayedOrder,
} from '@/lib/hooks/use-entity-list-ids';

beforeEach(() => {
    currentSlug = 'acme';
    mockUseTenantSWR.mockReset();
    withListData(undefined);
});

/**
 * Point the stubbed list-endpoint read at a fixed cache value.
 *
 * The stub honours SWR's null-key idiom — a null key yields no data — because
 * "the hook skipped the fetch" is exactly what several tests below assert,
 * and a stub that answered with rows regardless of key would hide a reader
 * that passed the list key when it should not have.
 */
function withListData(data: unknown) {
    mockUseTenantSWR.mockImplementation((key: unknown) => ({
        data: key == null ? undefined : data,
    }));
}

/**
 * One SWR cache shared by every hook mounted through the returned wrapper —
 * the list page and the detail page are separate mounts, exactly as they are
 * in the app, but they see the same cache.
 */
function sharedCache() {
    const cache = new Map();
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return <SWRConfig value={{ provider: () => cache }}>{children}</SWRConfig>;
    };
}

interface Row {
    id: string;
    key?: string;
}
const row = (id: string): Row => ({ id });

describe('displayed order — what the list rendered is what the stepper walks', () => {
    it('steps the SORTED order, not the server order the list cache holds', () => {
        const wrapper = sharedCache();
        // The list endpoint returned a, b, c…
        withListData({ rows: [row('a'), row('b'), row('c')], truncated: false });

        // …but the client sorted them (sortRowsByDisplay returns a NEW array,
        // so the cache entry above still holds server order) and rendered c, a, b.
        renderHook(
            () => usePublishDisplayedOrder('/risks', [row('c'), row('a'), row('b')]),
            { wrapper },
        );

        const { result } = renderHook(() => useEntityListIds('/risks'), { wrapper });
        expect(result.current).toEqual(['c', 'a', 'b']);
    });

    it('steps only the rows that survived the list filters', () => {
        const wrapper = sharedCache();
        // ControlsClient filters client-side under a deliberately stable key,
        // so the cache holds every control the tenant has…
        withListData({ rows: [row('a'), row('b'), row('c')], truncated: false });
        // …while the table rendered one.
        renderHook(() => usePublishDisplayedOrder('/controls', [row('b')]), { wrapper });

        const { result } = renderHook(() => useEntityListIds('/controls'), { wrapper });
        expect(result.current).toEqual(['b']);
    });

    it('re-sorting the list changes what an already-open detail page steps', () => {
        const wrapper = sharedCache();
        withListData({ rows: [row('a'), row('b'), row('c')], truncated: false });

        const publisher = renderHook(
            ({ rows }: { rows: Row[] }) => usePublishDisplayedOrder('/risks', rows),
            { wrapper, initialProps: { rows: [row('a'), row('b'), row('c')] } },
        );
        const reader = renderHook(() => useEntityListIds('/risks'), { wrapper });
        expect(reader.result.current).toEqual(['a', 'b', 'c']);

        publisher.rerender({ rows: [row('c'), row('b'), row('a')] });
        reader.rerender();
        expect(reader.result.current).toEqual(['c', 'b', 'a']);
    });

    it('does not re-fetch the list when an order was already published', () => {
        const wrapper = sharedCache();
        withListData({ rows: [row('a'), row('b')], truncated: false });
        renderHook(() => usePublishDisplayedOrder('/risks', [row('b'), row('a')]), {
            wrapper,
        });

        mockUseTenantSWR.mockClear();
        renderHook(() => useEntityListIds('/risks'), { wrapper });
        expect(mockUseTenantSWR).toHaveBeenCalledWith(null);
        expect(mockUseTenantSWR).not.toHaveBeenCalledWith('/risks');
    });

    it('keeps each tenant on its own order', () => {
        const wrapper = sharedCache();
        withListData({ rows: [row('a'), row('b'), row('c')], truncated: false });
        renderHook(() => usePublishDisplayedOrder('/risks', [row('c'), row('b')]), {
            wrapper,
        });

        // Same cache, different tenant in the route — the published order must
        // NOT leak across, or the arrows would offer ids this tenant cannot open.
        currentSlug = 'globex';
        const { result } = renderHook(() => useEntityListIds('/risks'), { wrapper });
        expect(result.current).toEqual(['a', 'b', 'c']);
    });

    it('publishes nothing for a key of null', () => {
        const wrapper = sharedCache();
        renderHook(() => usePublishDisplayedOrder(null, [row('z')]), { wrapper });
        const { result } = renderHook(() => useEntityListIds('/risks'), { wrapper });
        expect(result.current).toEqual([]);
    });
});

describe('fallback to the list cache when nothing was published', () => {
    it('uses the list endpoint order for a deep link into a detail page', () => {
        const wrapper = sharedCache();
        withListData({ rows: [row('a'), row('b'), row('c')], truncated: false });
        const { result } = renderHook(() => useEntityListIds('/risks'), { wrapper });
        expect(result.current).toEqual(['a', 'b', 'c']);
        expect(mockUseTenantSWR).toHaveBeenCalledWith('/risks');
    });

    it('treats an EMPTY published order as "nothing published"', () => {
        const wrapper = sharedCache();
        withListData({ rows: [row('a'), row('b')], truncated: false });
        // A publisher that mounts before its data lands must not blank the
        // arrows on a detail page that is already open.
        renderHook(() => usePublishDisplayedOrder('/risks', []), { wrapper });
        const { result } = renderHook(() => useEntityListIds('/risks'), { wrapper });
        expect(result.current).toEqual(['a', 'b']);
    });

    it('yields [] when neither side has anything — the nav hides itself', () => {
        const wrapper = sharedCache();
        withListData(undefined);
        const { result } = renderHook(() => useEntityListIds('/risks'), { wrapper });
        expect(result.current).toEqual([]);
    });
});

describe('shape tolerance of the fallback read', () => {
    it('reads the plain { rows } envelope (assets, tasks)', () => {
        withListData({ rows: [row('a'), row('b')], truncated: false });
        const { result } = renderHook(() => useEntityListIds('/assets'));
        expect(result.current).toEqual(['a', 'b']);
    });

    it('reads a bare array (incidents)', () => {
        withListData([row('i1'), row('i2')]);
        const { result } = renderHook(() => useEntityListIds('/incidents'));
        expect(result.current).toEqual(['i1', 'i2']);
    });

    it('reads the envelope spread alongside extra keys (risks, controls, policies, vendors)', () => {
        withListData({ rows: [row('r1')], truncated: false, kpiCounts: { high: 1 } });
        const { result } = renderHook(() => useEntityListIds('/risks'));
        expect(result.current).toEqual(['r1']);
    });

    it('yields [] for a malformed body rather than taking the page down', () => {
        withListData({ error: { code: 'boom' } });
        const { result } = renderHook(() => useEntityListIds('/risks'));
        expect(result.current).toEqual([]);
    });

    it('drops rows with no id', () => {
        withListData({ rows: [row('a'), {}, { id: '' }, row('b')] });
        const { result } = renderHook(() => useEntityListIds('/risks'));
        expect(result.current).toEqual(['a', 'b']);
    });
});

describe('memo identity', () => {
    it('returns a STABLE array reference while the ids are unchanged', () => {
        // Note the fixture: a NEW cache object holding the SAME ids each
        // render. Keying identity on `data` alone would go red here.
        const { result, rerender } = renderHook(() => {
            withListData({ rows: [row('a'), row('b')] });
            return useEntityListIds('/risks');
        });
        const first = result.current;
        rerender();
        rerender();
        expect(result.current).toBe(first);
    });

    it('returns a NEW reference once the ids actually change', () => {
        withListData({ rows: [row('a')] });
        const { result, rerender } = renderHook(() => useEntityListIds('/risks'));
        const first = result.current;

        withListData({ rows: [row('a'), row('b')] });
        rerender();

        expect(result.current).not.toBe(first);
        expect(result.current).toEqual(['a', 'b']);
    });

    it('keeps a published order referentially stable across rerenders', () => {
        const wrapper = sharedCache();
        renderHook(() => usePublishDisplayedOrder('/risks', [row('b'), row('a')]), {
            wrapper,
        });
        const { result, rerender } = renderHook(() => useEntityListIds('/risks'), {
            wrapper,
        });
        const first = result.current;
        rerender();
        expect(result.current).toBe(first);
    });
});

// ─── The publish API the queued steppers (#97 / #98 / #99) build on ───

const frameworkKey = (r: Row) => r.key;

describe('publish API — orderings this hook must be able to express', () => {
    it('steps by a slug rather than .id (frameworks)', () => {
        const wrapper = sharedCache();
        const rows: Row[] = [
            { id: 'fw_1', key: 'iso-27001' },
            { id: 'fw_2', key: 'nis2' },
        ];
        renderHook(
            () => usePublishDisplayedOrder('/frameworks', rows, frameworkKey),
            { wrapper },
        );
        const { result } = renderHook(
            () => useEntityListIds<Row>('/frameworks', { getId: frameworkKey }),
            { wrapper },
        );
        expect(result.current).toEqual(['iso-27001', 'nis2']);
    });

    it('applies the same getId to the fallback read', () => {
        withListData({
            rows: [
                { id: 'fw_1', key: 'iso-27001' },
                { id: 'fw_2', key: 'nis2' },
            ],
        });
        const { result } = renderHook(() =>
            useEntityListIds<Row>('/frameworks', { getId: frameworkKey }),
        );
        expect(result.current).toEqual(['iso-27001', 'nis2']);
    });

    it('reads an order published from a surface that is not a list page (audit packs)', () => {
        const wrapper = sharedCache();
        renderHook(
            () =>
                usePublishDisplayedOrder('/audits/packs', [
                    row('pack_2'),
                    row('pack_1'),
                ]),
            { wrapper },
        );

        // Audit packs have no list route at all, so the detail page passes a
        // null listKey: published order or nothing, and never a fetch.
        const { result } = renderHook(
            () => useEntityListIds(null, { orderKey: '/audits/packs' }),
            { wrapper },
        );
        expect(result.current).toEqual(['pack_2', 'pack_1']);
        expect(mockUseTenantSWR).toHaveBeenCalledWith(null);
        expect(mockUseTenantSWR).not.toHaveBeenCalledWith('/audits/packs');
    });

    it('yields [] for a null listKey with nothing published — no fallback fetch', () => {
        const wrapper = sharedCache();
        withListData({ rows: [row('a')] });
        const { result } = renderHook(
            () => useEntityListIds(null, { orderKey: '/audits/packs' }),
            { wrapper },
        );
        expect(result.current).toEqual([]);
        expect(mockUseTenantSWR).not.toHaveBeenCalledWith('/audits/packs');
    });
});
