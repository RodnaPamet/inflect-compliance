/**
 * Universal client-side row sort for list tables.
 *
 * The DataTable primitive is *controlled* — it reports header-arrow clicks
 * via `onSortChange` but never orders `data` itself. Each list page owns
 * the ordering. Historically every page hand-rolled a `switch (sortBy)`
 * comparator, and those comparators drifted from what the column actually
 * displayed: e.g. one page sorted by the raw `row.category` field while the
 * Category cell rendered a *derived* `categorize(row).category`.
 * Sorting by an invisible key makes same-displayed-value rows appear
 * interleaved instead of grouped.
 *
 * `sortRowsByDisplay` fixes that universally: pages pass an `accessors` map
 * keyed by the sortable column id, where each accessor returns the value the
 * column DISPLAYS. The SAME accessor function should be referenced by the
 * column's `accessorFn`, so the sort key and the rendered value can never
 * drift. The sort is stable (equal keys keep input order → contiguous
 * groups), nullish-last, and numeric/locale aware.
 */

export type SortAccessor<T> = (row: T) => unknown;
export type SortAccessors<T> = Record<string, SortAccessor<T>>;

function compareValues(a: unknown, b: unknown): number {
    // Nullish / empty always sorts last (before direction is applied it is
    // treated as "greater" so asc puts real values first; the caller flips
    // sign for desc, which then puts them first — acceptable either way, the
    // point is they stay grouped together at one end).
    const aEmpty = a == null || a === '';
    const bEmpty = b == null || b === '';
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'boolean' && typeof b === 'boolean') {
        return a === b ? 0 : a ? 1 : -1;
    }
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();

    return String(a).localeCompare(String(b), undefined, {
        numeric: true,
        sensitivity: 'base',
    });
}

/**
 * Return a new array of `rows` ordered by the accessor registered for
 * `sortBy`. Returns the input array unchanged when there is no active sort
 * or no accessor is registered for the column. The sort is STABLE, so rows
 * sharing a displayed value stay contiguous (the grouping the user expects).
 */
export function sortRowsByDisplay<T>(
    rows: T[],
    accessors: SortAccessors<T>,
    sortBy: string | undefined,
    sortOrder: 'asc' | 'desc' | undefined,
): T[] {
    if (!sortBy) return rows;
    const accessor = accessors[sortBy];
    if (!accessor) return rows;
    const dir = sortOrder === 'asc' ? 1 : -1;
    // Decorate-sort-undecorate guarantees stability across every JS engine
    // (and lets equal keys fall back to original index → contiguous groups).
    return rows
        .map((row, index) => ({ row, index, key: accessor(row) }))
        .sort((a, b) => {
            const cmp = compareValues(a.key, b.key);
            return cmp !== 0 ? cmp * dir : a.index - b.index;
        })
        .map((d) => d.row);
}
