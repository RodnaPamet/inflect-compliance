/**
 * The canonical risk-category list.
 *
 * Lives in `lib/` rather than beside the UI because both the client form
 * schema (`@/lib/schemas/risk-form`) and the risk pages need it, and a
 * schema module importing from `src/app/t/[tenantSlug]/(app)/...` is a
 * layering inversion — it drags route-level modules (and a `ComboboxOption`
 * type) into the schema's graph for the sake of eight strings.
 *
 * `_shared/risk-options.ts` re-exports this so every existing UI import
 * keeps resolving, and `RISK_CATEGORY_OPTIONS` is still projected from it
 * there. The single-source invariant is unchanged; only the declaration
 * moved down a layer.
 *
 * These values are stored VERBATIM in `Risk.category` and filtered as
 * literal strings, so they are deliberately not localised — translating a
 * label would either break the filter or write a translated value into the
 * column. Display-side localisation would need a separate label map keyed
 * by these values.
 */
export const RISK_CATEGORIES = [
    'Technical',
    'Operational',
    'Compliance',
    'Strategic',
    'Financial',
    'Reputational',
    'Physical',
    'Human Resources',
] as const;

export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/**
 * Each category's key under `risks.categories` (#4692). The stored value
 * stays the English word above; only its DISPLAY is translated, through this
 * map, so the filter and the column are untouched.
 */
export const RISK_CATEGORY_MESSAGE_KEYS: Readonly<Record<RiskCategory, string>> = {
    Technical: 'technical',
    Operational: 'operational',
    Compliance: 'compliance',
    Strategic: 'strategic',
    Financial: 'financial',
    Reputational: 'reputational',
    Physical: 'physical',
    'Human Resources': 'humanResources',
};

/** The message key for a stored category, or null for a value outside the list. */
export function riskCategoryMessageKey(value: string | null | undefined): string | null {
    if (!value) return null;
    return (RISK_CATEGORY_MESSAGE_KEYS as Record<string, string>)[value] ?? null;
}
