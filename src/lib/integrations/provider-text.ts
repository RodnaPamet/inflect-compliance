/**
 * Where a provider's own words live in the message catalogues (#4581).
 *
 * A provider declares its description, its setup guide and each field's label
 * and help in English, in its server-side class, and the Integrations page
 * printed them as they came: English under the Bulgarian UI. The catalogues now
 * carry them under `admin.integrations.providerText.<id>`, and the page reads
 * them there for a provider `LABELLED_PROVIDERS` names, falling back to the
 * server's English for one this build does not know.
 *
 * Only the words a person reads are catalogued. A field's placeholder is an
 * example value (`acme.okta.com`, `ldaps://…`), and stays as the provider
 * wrote it.
 *
 * The English entries must EQUAL the provider's own text:
 * `tests/unit/integrations/provider-text.test.ts` reads every registered
 * provider and fails when a provider's wording changes and the catalogue does
 * not, or when a Bulgarian entry is missing.
 */

/** The catalogue key of a provider's description or setup guide, under `admin`. */
export function providerTextKey(providerId: string, part: 'description' | 'setupGuide'): string {
    return `integrations.providerText.${providerId}.${part}`;
}

/** The catalogue key of one field's label or help, under `admin`. */
export function providerFieldTextKey(providerId: string, fieldKey: string, part: 'label' | 'description'): string {
    return `integrations.providerText.${providerId}.fields.${fieldKey}.${part}`;
}
