/**
 * Every shipped catalogue string has Bulgarian text (#5996).
 *
 * `catalogueStrings()` lists every translatable string the shipped catalogues
 * hold, by family: headings (names, titles, categories, sections, labels,
 * roles) and long texts (descriptions, guidance, steps, success criteria,
 * testing methodology, owner hints). Each one must have an entry in
 * `src/data/content-i18n/bg/<family>.json`, so a new or reworded English
 * string comes with its Bulgarian text in the same diff.
 *
 * This replaced a per-family baseline that counted down while the long texts
 * were being translated; it reached zero, so there is nothing left to count.
 * Do not reintroduce an allowance: untranslated catalogue text shows as
 * English to a Bulgarian reader, which is the defect #5996 fixed.
 */
import { catalogueHeadings, catalogueStrings } from '../../scripts/content-i18n/sources';
import { translateContentText } from '@/lib/content-i18n/dictionary';

describe('catalogue content without a Bulgarian translation', () => {
    it('leaves no catalogue string untranslated, in any family', () => {
        const untranslated: Record<string, string[]> = {};
        for (const [family, strings] of catalogueStrings()) {
            const missing = strings.filter((s) => translateContentText('bg', s) === null);
            // The first few per family are enough to find the edit that added them.
            if (missing.length > 0) untranslated[family] = missing.slice(0, 5);
        }
        expect(untranslated).toEqual({});
    });

    // Headings are what lists, menus and pickers show; checked on their own so
    // a failure names them first.
    it('leaves no heading untranslated: every name, title, category, section, label and role', () => {
        const headings = catalogueHeadings();
        expect(headings.size).toBeGreaterThan(2000);
        expect([...headings].filter((s) => translateContentText('bg', s) === null).sort()).toEqual([]);
    });

    it('the extractor finds the catalogues (the check is not vacuous)', () => {
        const all = [...catalogueStrings().values()].reduce((n, s) => n + s.length, 0);
        expect(all).toBeGreaterThan(30000);
    });
});
