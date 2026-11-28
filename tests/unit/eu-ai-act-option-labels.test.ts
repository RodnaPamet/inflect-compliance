/**
 * The EU AI Act classification options read in the reader's language (#5996).
 *
 * The register, the new-AI-system dialog and the classify dialog list the
 * Art. 5 practices, Annex III areas and Art. 50 cases from
 * `src/lib/eu-ai-act/classification.ts`, worded through `euAiActOptions.<id>`.
 * Every option needs a label in both catalogs, and the English one must stay
 * the source's own "<clause> — <label>", so the wording cannot drift from the
 * list the classifier decides on.
 */
import {
    ART5_PROHIBITED_PRACTICES,
    ANNEX_III_AREAS,
    ART50_TRANSPARENCY_CASES,
} from '@/lib/eu-ai-act/classification';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

const OPTIONS = [...ART5_PROHIBITED_PRACTICES, ...ANNEX_III_AREAS, ...ART50_TRANSPARENCY_CASES];
const EN = en.euAiActOptions as Record<string, string>;
const BG = bg.euAiActOptions as Record<string, string>;

describe('EU AI Act option labels', () => {
    it('covers the whole list (not vacuous)', () => {
        expect(OPTIONS.length).toBe(20);
    });

    it('words every option in English exactly as the classifier lists it', () => {
        const drift = OPTIONS.filter((o) => EN[o.id] !== `${o.clause} — ${o.label}`).map((o) => o.id);
        expect(drift).toEqual([]);
    });

    it('words every option in Bulgarian, keeping its clause reference', () => {
        const missing = OPTIONS.filter((o) => !BG[o.id] || !/[Ѐ-ӿ]/.test(BG[o.id])).map((o) => o.id);
        expect(missing).toEqual([]);
        // The reference keeps its numbers: "Art.5(1)(a)" → "чл. 5(1)(a)", "Annex III(1)" → "Приложение III(1)".
        const refs = OPTIONS.filter((o) => {
            const numbers = o.clause.replace(/^(Art\.|Annex )/, '');
            return !BG[o.id].startsWith(o.clause.startsWith('Annex') ? `Приложение ${numbers}` : `чл. ${numbers}`);
        }).map((o) => o.id);
        expect(refs).toEqual([]);
    });
});
