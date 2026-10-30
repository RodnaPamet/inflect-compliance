/**
 * Every registered provider's own words are in both catalogues, and the English
 * entries are the provider's own text (#4581).
 *
 * The Integrations page used to print each provider's description, setup guide
 * and field labels and help as the server-side class wrote them: English under
 * the Bulgarian UI. It now reads them from `admin.integrations.providerText`.
 * The English entries duplicate the provider source, so this file is what stops
 * the two drifting: change a provider's wording and the build fails until the
 * catalogue (both languages) says the same.
 *
 * Placeholders are example values and are deliberately not catalogued.
 */
import '@/app-layer/integrations/bootstrap';
import { registry } from '@/app-layer/integrations/registry';
import { LABELLED_PROVIDERS } from '@/lib/integrations/provider-labels';
import en from '../../../messages/en.json';
import bg from '../../../messages/bg.json';

type FieldText = { label: string; description?: string };
type ProviderText = { description?: string; setupGuide?: string; fields?: Record<string, FieldText> };
type Catalogue = { admin: { integrations: { providerText: Record<string, ProviderText> } } };
const EN = (en as unknown as Catalogue).admin.integrations.providerText;
const BG = (bg as unknown as Catalogue).admin.integrations.providerText;

const providers = registry.listProviders();

/** What the catalogue must hold for `p`, built from the provider itself. */
function expectedText(p: (typeof providers)[number]): ProviderText {
    const out: ProviderText = {};
    if (p.description) out.description = p.description;
    if (p.setupGuide) out.setupGuide = p.setupGuide;
    const fields = [...p.configSchema.configFields, ...p.configSchema.secretFields];
    if (fields.length > 0) {
        out.fields = Object.fromEntries(
            fields.map((f) => [f.key, f.description ? { label: f.label, description: f.description } : { label: f.label }]),
        );
    }
    return out;
}

/** The same shape with every string replaced by whether it is non-empty. */
function shapeOf(text: ProviderText | undefined): unknown {
    return JSON.parse(JSON.stringify(text ?? null), (_k, v) => (typeof v === 'string' ? v.trim().length > 0 : v));
}

describe('provider text in the catalogues', () => {
    test('there are providers to check, and every one is labelled', () => {
        expect(providers.length).toBeGreaterThan(0);
        expect(providers.filter((p) => !LABELLED_PROVIDERS.has(p.id)).map((p) => p.id)).toEqual([]);
    });

    test.each(providers.map((p) => [p.id, p] as const))('%s: the English entry is the provider\'s own text', (_id, p) => {
        expect(EN[p.id]).toEqual(expectedText(p));
    });

    test.each(providers.map((p) => [p.id, p] as const))('%s: the Bulgarian entry has every part, non-empty', (_id, p) => {
        expect(shapeOf(BG[p.id])).toEqual(shapeOf(expectedText(p)));
    });

    test.each(providers.map((p) => [p.id, p] as const))('%s: the Bulgarian entry is translated, not copied', (_id, p) => {
        const en = expectedText(p);
        const copied: string[] = [];
        if (en.description && BG[p.id]?.description === en.description) copied.push('description');
        if (en.setupGuide && BG[p.id]?.setupGuide === en.setupGuide) copied.push('setupGuide');
        expect(copied).toEqual([]);
    });

    test('neither catalogue carries text for a provider the registry does not have', () => {
        const ids = providers.map((p) => p.id).sort();
        expect(Object.keys(EN).sort()).toEqual(ids);
        expect(Object.keys(BG).sort()).toEqual(ids);
    });
});
