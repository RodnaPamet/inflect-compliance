/**
 * The merge behind `useRetainedFilterOptions`: options a facet built from
 * loaded rows are kept when those rows are filtered (#4275, #4279). The page
 * behaviour is in `tests/rendered/controls-owner-filter-keeps-options.test.tsx`.
 */
import {
    mergeRetainedOptions,
    withRetainedOptions,
    type FilterType,
} from '@/components/ui/filter';

const facet = (key: string, options: Array<{ value: string; label: string }> | null): FilterType =>
    ({ key, label: key, icon: null, options }) as unknown as FilterType;

const valuesOf = (filters: FilterType[], key: string) =>
    filters.find((f) => f.key === key)?.options?.map((o) => o.value);

describe('retained filter options', () => {
    it('keeps an option after it drops out of the loaded rows', () => {
        const before = [facet('owner', [{ value: 'a', label: 'Ana' }, { value: 'b', label: 'Bea' }])];
        const after = [facet('owner', [{ value: 'a', label: 'Ana' }])];

        let kept = mergeRetainedOptions({}, before, ['owner']);
        kept = mergeRetainedOptions(kept, after, ['owner']);

        expect(valuesOf(withRetainedOptions(after, kept, ['owner']), 'owner')).toEqual(['a', 'b']);
    });

    it('returns the same object when nothing is new, so the hook settles', () => {
        const filters = [facet('owner', [{ value: 'a', label: 'Ana' }])];
        const kept = mergeRetainedOptions({}, filters, ['owner']);

        expect(mergeRetainedOptions(kept, filters, ['owner'])).toBe(kept);
        expect(mergeRetainedOptions(kept, [facet('owner', [])], ['owner'])).toBe(kept);
    });

    it('takes the newest label for an option it already holds', () => {
        let kept = mergeRetainedOptions({}, [facet('owner', [{ value: 'a', label: 'Ana' }])], ['owner']);
        kept = mergeRetainedOptions(kept, [facet('owner', [{ value: 'a', label: 'Ana Ader' }])], ['owner']);

        const out = withRetainedOptions([facet('owner', [])], kept, ['owner']);
        expect(out[0].options).toEqual([{ value: 'a', label: 'Ana Ader' }]);
    });

    it('leaves facets that are not listed alone', () => {
        const before = [facet('status', [{ value: 'OPEN', label: 'Open' }, { value: 'DONE', label: 'Done' }])];
        const after = [facet('status', [{ value: 'OPEN', label: 'Open' }])];

        const kept = mergeRetainedOptions(mergeRetainedOptions({}, before, ['owner']), after, ['owner']);

        expect(kept).toEqual({});
        expect(withRetainedOptions(after, kept, ['owner'])).toEqual(after);
    });

    it('puts a sentinel value first and sorts the rest by label', () => {
        let kept = mergeRetainedOptions(
            {},
            [facet('folder', [{ value: '__none__', label: 'No folder' }, { value: 'z', label: 'Zeta' }])],
            ['folder'],
        );
        kept = mergeRetainedOptions(kept, [facet('folder', [{ value: 'a', label: 'Alpha' }])], ['folder']);

        expect(valuesOf(withRetainedOptions([facet('folder', [])], kept, ['folder']), 'folder')).toEqual([
            '__none__',
            'a',
            'z',
        ]);
    });
});
