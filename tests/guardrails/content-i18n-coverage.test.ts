/**
 * How much catalogue content still has no Bulgarian text (#5996).
 *
 * `catalogueStrings()` lists every translatable string the shipped catalogues
 * hold, by family. A family's count here is how many of them the Bulgarian
 * dictionaries do not translate. The numbers only go DOWN: translating a
 * family lowers its entry (to 0, then the entry is deleted) in the same diff,
 * and a new English string with no translation raises a count and fails.
 *
 * Exact equality, no allowance: slack would let new untranslated text in
 * behind a translation of something else.
 */
import { catalogueStrings } from '../../scripts/content-i18n/sources';
import { translateContentText } from '@/lib/content-i18n/dictionary';
import baseline from './content-i18n-coverage.baseline.json';

describe('catalogue content without a Bulgarian translation', () => {
    const untranslated: Record<string, number> = {};
    for (const [family, strings] of catalogueStrings()) {
        const missing = strings.filter((s) => translateContentText('bg', s) === null).length;
        if (missing > 0) untranslated[family] = missing;
    }

    it('equals the recorded baseline, family by family', () => {
        expect(untranslated).toEqual(baseline);
    });

    it('the extractor finds the catalogues (the count is not vacuous)', () => {
        const all = [...catalogueStrings().values()].reduce((n, s) => n + s.length, 0);
        expect(all).toBeGreaterThan(30000);
    });
});
