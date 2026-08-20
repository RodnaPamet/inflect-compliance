'use client';

import { useMemo } from 'react';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { idsFromCappedList, type CappedList } from '@/lib/list-backfill-cap';
import type { CacheKey } from '@/lib/swr-keys';

/**
 * Ordered entity ids for a detail page's prev/next stepper
 * (`EntityDetailLayout`'s `prevNext` prop).
 *
 * Reads the LIST endpoint's SWR cache and returns its ids in list order,
 * so stepping walks the same sequence the user just saw. The read is a
 * normal `useTenantSWR`, so a warm cache (the usual case — the user
 * clicked through from the list) resolves without a network round-trip,
 * and a cold one (deep link, refresh) fetches once and the arrows appear
 * when it lands.
 *
 * ## Why a hook and not two lines per page
 *
 * The two lines are a `useTenantSWR` read plus a `useMemo` through
 * `idsFromCappedList`, and BOTH have already been got wrong once:
 *
 *   - The asset page hand-rolled `Array.isArray(data) ? … : []` instead of
 *     the helper. `/assets` later moved to the `{ rows, truncated }`
 *     envelope, that guard silently yielded `[]`, and the arrows vanished
 *     for two weeks looking like a deleted feature (#2032).
 *   - The memo must key on the RAW cache value. `idsFromCappedList`
 *     returns a fresh array every call, so `useMemo(…, [ids])` defeats
 *     itself and hands `EntityPrevNextNav` a new array identity on every
 *     render.
 *
 * Both are invisible when wrong — the nav renders nothing rather than
 * throwing. Twelve more pages are due to mount this; this hook is the one
 * place either mistake can be made.
 *
 * @param listKey The resource's list cache key — `CACHE_KEYS.risks.list()`.
 *   Pass `null` to skip the read (the nav then hides itself).
 */
export function useEntityListIds(listKey: CacheKey | null | undefined): string[] {
    const { data } = useTenantSWR<
        CappedList<{ id?: string }> | Array<{ id?: string }>
    >(listKey ?? null);

    // Keyed on `data`, the raw cache value — see the docstring.
    return useMemo(() => idsFromCappedList(data), [data]);
}
