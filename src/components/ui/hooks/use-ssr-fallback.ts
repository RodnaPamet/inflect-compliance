'use client';

import { useMemo } from 'react';

/**
 * May the server-rendered rows be used as SWR `fallbackData`?
 *
 * A list page is server-rendered for one specific filter combination. The
 * client then owns the filters, so the SSR payload is only a valid seed
 * while the active filters still describe the same query. Diverge, and
 * `fallbackData` would show the server's rows for filters the user has
 * since changed — stale content that looks authoritative, with no spinner
 * to suggest otherwise.
 *
 * The rule, in the two cases that matter:
 *
 *   - The server rendered WITHOUT filters (`serverHadFilters` false): the
 *     payload is the unfiltered list, so it is a valid seed exactly while
 *     the client has no active filters either.
 *   - The server rendered WITH filters: every key present on either side
 *     must match. Comparing only the client's keys would let a filter the
 *     server applied — and the client has since cleared — pass unnoticed,
 *     which is why the key set is the union rather than one side's.
 *
 * Missing and empty-string are treated as the same thing (`?? ''`), because
 * a cleared filter reaches here as `''` from the URL but is simply absent
 * from the server's object.
 *
 * This ran as six copies — assets, controls, policies, risks, tasks,
 * vendors — identical apart from formatting and a couple of non-null
 * assertions. Getting it subtly wrong in one file would produce stale rows
 * on one page only, which is close to the hardest kind of bug to notice.
 */
export function useSsrFallback(input: {
    /** Filters encoded in the current SWR cache key. */
    queryKeyFilters: Record<string, string>;
    /** Filters the server rendered with. */
    initialFilters: Record<string, string> | undefined;
    /** Did the server render a FILTERED view? */
    serverHadFilters: boolean;
    /** Does the client currently have any active filter? */
    hasActive: boolean;
}): boolean {
    const { queryKeyFilters, initialFilters, serverHadFilters, hasActive } = input;
    return useMemo(() => {
        if (!serverHadFilters) return !hasActive;
        const initial = initialFilters ?? {};
        const keys = new Set([...Object.keys(queryKeyFilters), ...Object.keys(initial)]);
        for (const k of keys) {
            if ((queryKeyFilters[k] ?? '') !== (initial[k] ?? '')) return false;
        }
        return true;
    }, [queryKeyFilters, initialFilters, serverHadFilters, hasActive]);
}
