'use client';

import { useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import useSWR, { useSWRConfig, type SWRConfiguration } from 'swr';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { unwrapCappedList, type CappedList } from '@/lib/list-backfill-cap';
import type { CacheKey } from '@/lib/swr-keys';

/**
 * The prev/next stepper's id source — the PUBLISH side and the READ side of
 * one contract.
 *
 * ## The bug this replaces (#107)
 *
 * `useEntityListIds` used to read the list endpoint's SWR cache and hand its
 * ids to `EntityPrevNextNav`, which documents its `ids` prop as "the same
 * order the list page shows them". It was not that order, for two independent
 * reasons, and neither is recoverable from a detail page:
 *
 *   1. **Sorting happens after the read.** Every list client sorts IN MEMORY
 *      — `sortRowsByDisplay(rows, accessors, sortBy, sortOrder)` — and that
 *      helper is decorate-sort-undecorate, so it returns a NEW array and the
 *      cache entry keeps SERVER order. `sortBy` / `sortOrder` are plain
 *      `useState`; they never reach the SWR key. Sort risks by Score desc,
 *      open the top row, press alt+ArrowDown, and you land on the third
 *      visible row.
 *   2. **Filtering happens under a different key.** List clients key their
 *      read on the filtered query string and fall back to the bare key only
 *      when unfiltered; the detail page always read the BARE key.
 *      `ControlsClient` is worse — it deliberately drops `category` from the
 *      query so the SWR key stays stable and filters client-side, so the
 *      stepper walked controls the user had filtered OUT of view.
 *
 * A detail page cannot reconstruct either: `usePreviousPath` persists only the
 * pathname, not the sort state or the filter set.
 *
 * ## The inversion
 *
 * So the list page — the only place that knows what it rendered — PUBLISHES
 * the id order it actually displayed, and the detail page READS it:
 *
 * ```tsx
 * // …ListClient.tsx, immediately after the existing sort memo
 * const sortedRisks = useMemo(
 *     () => sortRowsByDisplay(rawRisks, sortAccessors, sortBy, sortOrder),
 *     [rawRisks, sortAccessors, sortBy, sortOrder],
 * );
 * usePublishDisplayedOrder(CACHE_KEYS.risks.list(), sortedRisks);
 *
 * // …risks/[riskId]/page.tsx
 * const riskIds = useEntityListIds(CACHE_KEYS.risks.list());
 * ```
 *
 * The published order lives in its OWN SWR cache entry (`displayed-order:`
 * prefix, tenant-scoped), written with `revalidate: false` and read with a
 * `null` fetcher — it is client state that happens to live in the SWR cache
 * so it survives the list → detail navigation, never a fetchable resource.
 *
 * A cold cache publishes nothing, the read falls back to the raw list, and if
 * that is cold too the stepper hides itself. Hiding is the correct semantic:
 * stepping "the order the list showed" is meaningless when the user never saw
 * a list.
 *
 * ## Publishing what the list DISPLAYS, not what it fetched
 *
 * Publish the fully filtered + sorted row array — the one handed to
 * `<DataTable data={…}>` — NOT the progressive-disclosure window
 * (`visibleRows`). The window is a rendering budget that grows as the user
 * scrolls; the stepper should walk the whole result set the user filtered
 * down to, exactly as scrolling would.
 *
 * ## Extending this (the contract #97 / #98 / #99 build on)
 *
 * Two axes are deliberately open, because the entities queued behind this
 * need them and retro-fitting either would churn all seven call sites:
 *
 *   - **`getId`** — the order need not be `.id`. Frameworks step by their
 *     `key` slug, so `FrameworksClient` publishes
 *     `usePublishDisplayedOrder(key, rows, frameworkKey)` and the detail page
 *     reads `useEntityListIds(key, { getId: frameworkKey })`. Pass a
 *     MODULE-LEVEL or `useCallback`-stable function: an inline arrow is a new
 *     identity every render and re-walks the list each pass.
 *   - **`orderKey` + a null `listKey`** — the order need not come from a list
 *     PAGE. Audit packs have no list route at all; whichever surface renders
 *     the pack table publishes under an agreed key, and the detail page reads
 *     `useEntityListIds(null, { orderKey: CACHE_KEYS.audits.packs() })`.
 *     A null `listKey` means "published order or nothing" — no fallback
 *     fetch, no arrows until something publishes.
 */

/**
 * Cache-key namespace for published orders. The prefix keeps them from ever
 * colliding with a real endpoint key, and makes them obvious in a cache dump.
 */
const DISPLAYED_ORDER_PREFIX = 'displayed-order:';

/**
 * The published entry is client state, not a resource: no fetcher runs
 * against it, and nothing may revalidate it away.
 */
const PUBLISHED_ORDER_CONFIG: SWRConfiguration = {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateOnMount: false,
    revalidateIfStale: false,
    keepPreviousData: true,
};

/** Ids are joined with NUL, which no id or slug can contain. */
const ID_SEPARATOR = '\u0000';

function isId(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.length > 0;
}

/** Default id extractor — `row.id`, tolerant of any row shape. */
function rowId(row: unknown): string | undefined {
    if (typeof row !== 'object' || row === null) return undefined;
    const candidate = (row as { id?: unknown }).id;
    return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Resolve the tenant-scoped cache key a displayed order is published under.
 *
 * Tenant-scoped for the same reason `useTenantSWR` resolves its key to the
 * absolute URL: without the slug, tenant B's detail page could read the order
 * tenant A's list page published and offer arrows to ids B cannot open. The
 * slug comes from the route rather than `useTenantContext` so the hook never
 * throws outside a `TenantProvider` — a missing slug degrades to an unscoped
 * key rather than taking the page down.
 */
export function useDisplayedOrderKey(
    orderKey: CacheKey | null | undefined,
): string | null {
    const params = useParams();
    const raw = params?.tenantSlug;
    const slug = Array.isArray(raw) ? raw[0] : raw;
    return useMemo(
        () =>
            orderKey == null
                ? null
                : `${DISPLAYED_ORDER_PREFIX}${slug ?? '-'}:${orderKey}`,
        [orderKey, slug],
    );
}

/**
 * PUBLISH side. Call once per list client, immediately after the memo that
 * produces the rows the table renders.
 *
 * @param orderKey  The resource's registry key — `CACHE_KEYS.risks.list()`.
 *   The detail page reads under the same key. `null` skips publishing.
 * @param rows      The filtered + sorted rows the table is rendering.
 * @param getId     Optional id extractor; defaults to `row.id`. Must be
 *   referentially stable (module-level or `useCallback`).
 */
export function usePublishDisplayedOrder<T>(
    orderKey: CacheKey | null | undefined,
    rows: ReadonlyArray<T> | null | undefined,
    getId: (row: T) => string | null | undefined = rowId,
): void {
    const { mutate } = useSWRConfig();
    const cacheKey = useDisplayedOrderKey(orderKey);

    // Keyed on the row array's identity: every list client's sort memo is
    // stable while its inputs are, so this maps the list once per real
    // change rather than once per render.
    const ids = useMemo(
        () => (rows ?? []).map(getId).filter(isId),
        [rows, getId],
    );

    // The EFFECT keys on the joined signature, not on `ids`. A client whose
    // rows array is rebuilt each render (`data?.rows ?? []`) would otherwise
    // write to the cache on every pass, and each write notifies every
    // subscriber — a render loop across the list and any mounted reader.
    const signature = ids.join(ID_SEPARATOR);

    useEffect(() => {
        if (!cacheKey) return;
        void mutate(
            cacheKey,
            signature === '' ? [] : signature.split(ID_SEPARATOR),
            { revalidate: false },
        );
    }, [cacheKey, signature, mutate]);
}

export interface UseEntityListIdsOptions<T> {
    /**
     * Where the order was published, when that differs from the list key —
     * an entity whose order comes from a surface other than its own list
     * route. Defaults to `listKey`.
     */
    orderKey?: CacheKey | null;
    /**
     * Id extractor for the FALLBACK list read; must match the one the
     * publisher used. Defaults to `row.id`.
     */
    getId?: (row: T) => string | null | undefined;
}

/**
 * READ side — ordered entity ids for a detail page's prev/next stepper
 * (`EntityDetailLayout`'s `prevNext` prop).
 *
 * Prefers the order the list page published; falls back to the list
 * endpoint's own cache entry (server order) when nothing has been published,
 * which is the pre-#107 behaviour and still the best available answer for a
 * deep link straight into a detail page.
 *
 * An EMPTY published order counts as "nothing published" and falls through to
 * the list read. A list showing zero rows is not a list you can have clicked
 * a row from, so the distinction is unobservable in practice — but treating
 * empty as authoritative would let a publisher that mounts before its data
 * loads blank the arrows on an already-open detail page.
 *
 * @param listKey The resource's list cache key — `CACHE_KEYS.risks.list()`.
 *   `null` skips the fallback read entirely (published order or nothing).
 */
export function useEntityListIds<T = unknown>(
    listKey: CacheKey | null | undefined,
    options: UseEntityListIdsOptions<T> = {},
): string[] {
    const { orderKey, getId } = options;

    const cacheKey = useDisplayedOrderKey(
        orderKey === undefined ? listKey : orderKey,
    );
    const { data: published } = useSWR<string[]>(
        cacheKey,
        null,
        PUBLISHED_ORDER_CONFIG,
    );
    const hasPublished = Array.isArray(published) && published.length > 0;

    // Skip the network read entirely when the list page already published —
    // the common case (the user clicked through from the list).
    const { data } = useTenantSWR<CappedList<T> | T[]>(
        hasPublished ? null : (listKey ?? null),
    );

    const extract = getId ?? rowId;
    const fallbackIds = useMemo(
        () => unwrapCappedList<T>(data).map(extract).filter(isId),
        [data, extract],
    );

    const ids = hasPublished ? (published as string[]) : fallbackIds;

    // Identity is keyed on CONTENT, not on the array reference. Callers pass
    // `ids` straight to `EntityPrevNextNav`, and the two upstream sources (an
    // SWR cache value, a freshly-mapped array) have different identity
    // stability — content-keying gives one stable answer for both.
    const signature = ids.join(ID_SEPARATOR);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(() => ids, [signature]);
}
