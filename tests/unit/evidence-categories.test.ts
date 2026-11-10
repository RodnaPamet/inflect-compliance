/**
 * The evidence forms' category choices (#5018): the ten standard categories
 * first, then what the workspace already uses, then the current value, with no
 * blank and no case-insensitive duplicate. Editing a row must never drop the
 * category it has.
 */
import { EVIDENCE_CATEGORY_PRESETS, evidenceCategoryChoices } from '@/lib/evidence-categories';

describe('evidenceCategoryChoices', () => {
    it('offers the ten standard categories, in the owner\'s order, when nothing else is in use', () => {
        expect(evidenceCategoryChoices([])).toEqual([...EVIDENCE_CATEGORY_PRESETS]);
        expect(EVIDENCE_CATEGORY_PRESETS).toHaveLength(10);
        expect(EVIDENCE_CATEGORY_PRESETS[0]).toBe('Policy or procedure');
        expect(EVIDENCE_CATEGORY_PRESETS[9]).toBe('Other');
    });

    it('follows the standard list with the workspace\'s own categories, sorted', () => {
        expect(evidenceCategoryChoices(['integration', 'Access reviews']).slice(10)).toEqual([
            'Access reviews',
            'integration',
        ]);
    });

    it('drops blanks and case-insensitive duplicates of a standard category', () => {
        const out = evidenceCategoryChoices(['', '  ', 'log or report', 'Log or report', null, undefined]);
        expect(out).toEqual([...EVIDENCE_CATEGORY_PRESETS]);
    });

    it('keeps the current value when it is in neither list, so an edit does not drop it', () => {
        expect(evidenceCategoryChoices([], 'Legacy bucket')).toEqual([...EVIDENCE_CATEGORY_PRESETS, 'Legacy bucket']);
        expect(evidenceCategoryChoices([], 'Other')).toEqual([...EVIDENCE_CATEGORY_PRESETS]);
    });
});
