/**
 * `useSsrFallback` decides whether server-rendered rows may seed the SWR
 * cache. Getting it wrong shows the server's rows for filters the user has
 * since changed — stale content that looks authoritative, with no spinner
 * to suggest otherwise.
 *
 * It ran as six copies before 2026-08-06, so a subtle divergence in one
 * would have produced stale rows on exactly one page. These cases pin the
 * two that are easy to get wrong: the union key set, and empty-vs-missing.
 *
 * The hook is a `useMemo` over pure inputs, so the decision function is
 * exercised directly rather than through a renderer.
 */

/** The exact rule inside the hook's useMemo — kept in sync by the test below. */
function decide(input: {
    queryKeyFilters: Record<string, string>;
    initialFilters: Record<string, string> | undefined;
    serverHadFilters: boolean;
    hasActive: boolean;
}): boolean {
    const { queryKeyFilters, initialFilters, serverHadFilters, hasActive } = input;
    if (!serverHadFilters) return !hasActive;
    const initial = initialFilters ?? {};
    const keys = new Set([...Object.keys(queryKeyFilters), ...Object.keys(initial)]);
    for (const k of keys) {
        if ((queryKeyFilters[k] ?? '') !== (initial[k] ?? '')) return false;
    }
    return true;
}

describe('useSsrFallback — when SSR rows may seed the cache', () => {
    it('server rendered unfiltered: seed only while the client is also unfiltered', () => {
        expect(decide({ queryKeyFilters: {}, initialFilters: {}, serverHadFilters: false, hasActive: false })).toBe(true);
        expect(decide({ queryKeyFilters: { status: 'ACTIVE' }, initialFilters: {}, serverHadFilters: false, hasActive: true })).toBe(false);
    });

    it('matching filters seed; diverging filters do not', () => {
        const initialFilters = { status: 'ACTIVE' };
        expect(decide({ queryKeyFilters: { status: 'ACTIVE' }, initialFilters, serverHadFilters: true, hasActive: true })).toBe(true);
        expect(decide({ queryKeyFilters: { status: 'RETIRED' }, initialFilters, serverHadFilters: true, hasActive: true })).toBe(false);
    });

    it('uses the UNION of both key sets, not just the client side', () => {
        // The server filtered by status; the client has since cleared it, so
        // `status` is absent client-side. Iterating only the client's keys
        // would find nothing to compare and wrongly seed the server's
        // FILTERED rows into an unfiltered view.
        expect(decide({
            queryKeyFilters: {},
            initialFilters: { status: 'ACTIVE' },
            serverHadFilters: true,
            hasActive: false,
        })).toBe(false);

        // And the mirror: a filter the client added that the server never had.
        expect(decide({
            queryKeyFilters: { type: 'SYSTEM' },
            initialFilters: {},
            serverHadFilters: true,
            hasActive: true,
        })).toBe(false);
    });

    it('treats a cleared filter ("") and an absent one as the same', () => {
        // A cleared filter arrives as '' from the URL but is simply missing
        // from the server's object. Comparing them strictly would refuse a
        // perfectly valid seed on every page load with a touched filter.
        expect(decide({
            queryKeyFilters: { status: '' },
            initialFilters: {},
            serverHadFilters: true,
            hasActive: false,
        })).toBe(true);
        expect(decide({
            queryKeyFilters: {},
            initialFilters: { status: '' },
            serverHadFilters: true,
            hasActive: false,
        })).toBe(true);
    });

    it('tolerates an undefined initialFilters', () => {
        // Three of the six call sites passed `initialFilters!` with a
        // non-null assertion; the hook takes the honest optional type.
        expect(decide({ queryKeyFilters: {}, initialFilters: undefined, serverHadFilters: true, hasActive: false })).toBe(true);
        expect(decide({ queryKeyFilters: { q: 'x' }, initialFilters: undefined, serverHadFilters: true, hasActive: true })).toBe(false);
    });

    it('the hook body still matches this decision function', () => {
        // Guards the one risk of testing a transcribed copy: that the hook
        // and this function drift apart.
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../src/components/ui/hooks/use-ssr-fallback.ts'),
            'utf8',
        );
        expect(src).toContain('if (!serverHadFilters) return !hasActive;');
        expect(src).toContain('const initial = initialFilters ?? {};');
        expect(src).toContain(
            'const keys = new Set([...Object.keys(queryKeyFilters), ...Object.keys(initial)]);',
        );
        expect(src).toContain("if ((queryKeyFilters[k] ?? '') !== (initial[k] ?? '')) return false;");
    });
});
