'use client';

/**
 * Keeps a facet's options from shrinking to the rows it has just filtered.
 *
 * A list page often builds a facet's options from the rows it has loaded: the
 * owners of the rows on screen, the categories of the rows on screen. Those
 * rows come back from the server already filtered. Pick one owner, the server
 * answers with that owner's rows, and the option list rebuilt from them offers
 * nobody else, so a second owner can never be picked. The pill for a picked
 * value can lose its label the same way.
 *
 * This hook keeps every option a facet has offered while the page is mounted.
 * The options built on this render win, so a label that changed is refreshed.
 * An option that has dropped out of the loaded rows is kept. A value that
 * starts with `__` is a sentinel such as a "none" bucket, and those stay
 * first, where builders put them. The rest sort by label.
 *
 * Pass only the keys whose options are built from rows. Options from an enum
 * never shrink, and a facet whose options should follow another selection must
 * not be listed.
 */

import { useMemo, useState } from 'react';
import type { Filter, FilterOption } from './types';

/** Options kept per facet key, in no particular order. */
export type RetainedFilterOptions = Readonly<Record<string, ReadonlyMap<FilterOption['value'], FilterOption>>>;

const EMPTY: RetainedFilterOptions = Object.freeze({});

const isSentinel = (o: FilterOption) => typeof o.value === 'string' && o.value.startsWith('__');

function sameOption(a: FilterOption, b: FilterOption): boolean {
    return a.label === b.label && a.displayLabel === b.displayLabel && a.icon === b.icon && a.right === b.right;
}

/**
 * Folds this render's options into what has been kept. Returns `retained`
 * itself when nothing is new, so a caller can tell whether to store it.
 */
export function mergeRetainedOptions(
    retained: RetainedFilterOptions,
    filters: ReadonlyArray<Filter>,
    keys: ReadonlyArray<string>,
): RetainedFilterOptions {
    let next: Record<string, ReadonlyMap<FilterOption['value'], FilterOption>> | null = null;
    for (const f of filters) {
        if (!keys.includes(f.key) || !f.options) continue;
        const kept = retained[f.key];
        let merged: Map<FilterOption['value'], FilterOption> | null = null;
        for (const o of f.options) {
            const prior = kept?.get(o.value);
            if (prior && sameOption(prior, o)) continue;
            merged ??= new Map(kept ?? []);
            merged.set(o.value, o);
        }
        if (merged) {
            next ??= { ...retained };
            next[f.key] = merged;
        }
    }
    return next ?? retained;
}

/** The filters with each listed facet's options replaced by what was kept. */
export function withRetainedOptions<F extends Filter>(
    filters: ReadonlyArray<F>,
    retained: RetainedFilterOptions,
    keys: ReadonlyArray<string>,
): F[] {
    return filters.map((f) => {
        const kept = retained[f.key];
        if (!keys.includes(f.key) || !f.options || !kept) return f;
        const all = Array.from(kept.values());
        const options = [
            ...all.filter(isSentinel),
            ...all.filter((o) => !isSentinel(o)).sort((a, b) => a.label.localeCompare(b.label)),
        ];
        return { ...f, options };
    });
}

export function useRetainedFilterOptions<F extends Filter>(
    filters: F[],
    keys: ReadonlyArray<string>,
): F[] {
    const [retained, setRetained] = useState<RetainedFilterOptions>(EMPTY);
    const next = mergeRetainedOptions(retained, filters, keys);
    // Storing derived state during render, guarded so it settles: the second
    // pass merges nothing new and returns `retained` itself.
    if (next !== retained) setRetained(next);
    const keySignature = keys.join('\u0000');
    return useMemo(
        () => withRetainedOptions(filters, next, keySignature.split('\u0000')),
        [filters, next, keySignature],
    );
}
