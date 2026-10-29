/**
 * Every integration provider the Integrations page can name has a translated
 * name in both locales, and none of them says "MCP" (#4466).
 *
 * The page used to render a provider's server-side `displayName`: English under
 * the Bulgarian UI, and "MCP server (external)" / "Legacy application (MCP)"
 * in front of every admin. It now renders `admin.integrations.providerLabels.<id>`
 * for an id `LABELLED_PROVIDERS` names. These pin that set against the
 * registry and against both catalogues, so a new provider fails here rather
 * than reaching a reader as an English string or an id.
 */
import '@/app-layer/integrations/bootstrap';
import { registry } from '@/app-layer/integrations/registry';
import { LABELLED_PROVIDERS } from '@/lib/integrations/provider-labels';
import en from '../../../messages/en.json';
import bg from '../../../messages/bg.json';

type Catalogue = { admin: { integrations: { providerLabels: Record<string, string> } } };
const CATALOGUES: Array<[string, Catalogue]> = [
    ['en', en as unknown as Catalogue],
    ['bg', bg as unknown as Catalogue],
];

describe('integration provider labels', () => {
    it('labels every registered provider', () => {
        const ids = registry.listProviders().map((p) => p.id);
        // The positive control: the registry is populated, so the filter below
        // cannot pass on an empty list.
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.filter((id) => !LABELLED_PROVIDERS.has(id))).toEqual([]);
    });

    it.each(CATALOGUES)('has a non-empty %s name for every labelled provider', (_lang, catalogue) => {
        const labels = catalogue.admin.integrations.providerLabels;
        expect([...LABELLED_PROVIDERS].filter((id) => !labels[id]?.trim())).toEqual([]);
    });

    it.each(CATALOGUES)('carries in %s no name the set does not list', (_lang, catalogue) => {
        expect(Object.keys(catalogue.admin.integrations.providerLabels).sort())
            .toEqual([...LABELLED_PROVIDERS].sort());
    });

    it.each(CATALOGUES)('never says "MCP" in %s', (_lang, catalogue) => {
        const offenders = Object.entries(catalogue.admin.integrations.providerLabels)
            .filter(([, name]) => /mcp/i.test(name));
        expect(offenders).toEqual([]);
    });
});
