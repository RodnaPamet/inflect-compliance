/**
 * Every integration check the catalogue can show has a label in both locales
 * (#4466). The Integrations page printed check ids such as `mfa_enforced` on
 * its catalogue cards and in its form; it now prints the label when
 * `LABELLED_CHECKS` names the id, and the id otherwise. These pin that set
 * against the providers that declare checks and against both catalogues, so a
 * new check fails here rather than reaching a reader as a code.
 */
import '@/app-layer/integrations/bootstrap';
import { registry } from '@/app-layer/integrations/registry';
import { LABELLED_CHECKS } from '@/lib/integrations/check-labels';
import en from '../../../messages/en.json';
import bg from '../../../messages/bg.json';

type Catalogue = { admin: { integrations: { checkLabels: Record<string, string> } } };

describe('integration check labels', () => {
    it('labels every check a registered provider declares', () => {
        const declared = new Set(registry.listProviders().flatMap((p) => p.supportedChecks));
        // The positive control: the registry is populated, so an empty
        // `declared` cannot pass the loop below vacuously.
        expect(declared.size).toBeGreaterThan(0);
        const unlabelled = [...declared].filter((id) => !LABELLED_CHECKS.has(id));
        expect(unlabelled).toEqual([]);
    });

    it.each([
        ['en', en as unknown as Catalogue],
        ['bg', bg as unknown as Catalogue],
    ])('has a non-empty %s label for every labelled check', (_lang, catalogue) => {
        const labels = catalogue.admin.integrations.checkLabels;
        const missing = [...LABELLED_CHECKS].filter((id) => !labels[id]?.trim());
        expect(missing).toEqual([]);
    });

    it('carries no label the set does not name', () => {
        // A stale label is harmless to a reader but means the set and the
        // catalogue have drifted, which is the thing this file exists to stop.
        for (const catalogue of [en, bg] as unknown as Catalogue[]) {
            expect(Object.keys(catalogue.admin.integrations.checkLabels).sort())
                .toEqual([...LABELLED_CHECKS].sort());
        }
    });
});
