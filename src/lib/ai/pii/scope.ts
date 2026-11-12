/**
 * WHAT THE PII DETECTOR IS FOR — D-L1-1, as code (owner decision, 2026-11-11).
 *
 * Phase 0 of `docs/ai-architecture/presidio.md` wrote it; Phase 1's seam reads
 * it. It is the ONE spelling of the decision: every other module under
 * `src/lib/ai/pii/` imports these constants and none restates them. Widening
 * the scope (LOCATION, ORG, a third locale, the local route) is a reviewed diff
 * to THIS file and an owner decision, never a config value — a scope a
 * deployment or a tenant could widen would also be one it could narrow.
 *
 *   - ROUTES. Text bound for an EXTERNAL model route only (`inflect-external`).
 *     A `LOCAL_ONLY` tenant's local route (`inflect-local`) is not redacted:
 *     nothing leaves the perimeter there. `LOCAL_ROUTE_REDACTED` is that
 *     decision, and it is `false`.
 *   - ENTITY TYPES. Exactly five. LOCATION and ORG were considered and are NOT
 *     in scope: an address or a company name in a fixture is unlabelled
 *     context, and a detector's LOCATION/ORG spans are ignored by the scorer
 *     rather than counted as mistakes, and dropped by the provider.
 *   - LOCALES. EN and BG, the product's two (next-intl parity).
 *
 * The names are Presidio's own entity names, plus `BG_EGN` for the custom
 * ЕГН recogniser, and they are used unchanged EVERYWHERE — the fixture corpus,
 * the evaluation record, the detector's spans, the redaction policy and the
 * placeholders (`<PERSON_1>`, `<EMAIL_ADDRESS_1>`). There is no translation
 * table between the service's names and ours, because a translation table is
 * where a type silently stops being scored.
 *
 * The ACTION per type (replace with a numbered typed placeholder) is the
 * Phase 0 default recorded in
 * `docs/implementation-notes/2026-11-11-pii-redaction-decision.md`, encoded by
 * `./policy.ts`.
 *
 * Leaf module: no imports, so a client surface (a future settings page that
 * lists the types) can hold it without dragging the provider graph along.
 *
 * @module lib/ai/pii/scope
 */

/** The five entity types D-L1-1 puts in scope, in Presidio's spelling. The order also breaks merge ties. */
export const PII_ENTITY_TYPES = [
    'PERSON',
    'EMAIL_ADDRESS',
    'PHONE_NUMBER',
    'IBAN_CODE',
    'BG_EGN',
] as const;
export type PiiEntityType = (typeof PII_ENTITY_TYPES)[number];

/** EN + BG, as Presidio language codes. A type is scored per locale, so a BG gap cannot hide behind EN. */
export const PII_LOCALES = ['en', 'bg'] as const;
export type PiiLocale = (typeof PII_LOCALES)[number];

/** D-L1-1: a LOCAL_ONLY tenant's local route is not redacted. */
export const LOCAL_ROUTE_REDACTED = false as const;

/**
 * The residency routes a model call can take (G1). The ids are the provider
 * ids `flue/model-selection.ts` registers; restated as a type here rather than
 * imported so this leaf does not pull the Flue module graph, and held equal to
 * `FLUE_PROVIDER_IDS` by `tests/unit/ai/pii/pii-scope.test.ts`.
 */
export type PiiEgressRoute = 'inflect-external' | 'inflect-local';

/** D-L1-1: redaction applies to text leaving on an EXTERNAL route, and to the local route only if `LOCAL_ROUTE_REDACTED`. */
export function redactionAppliesToRoute(route: PiiEgressRoute): boolean {
    return route === 'inflect-external' || LOCAL_ROUTE_REDACTED;
}

export function isPiiEntityType(value: unknown): value is PiiEntityType {
    return typeof value === 'string' && (PII_ENTITY_TYPES as readonly string[]).includes(value);
}

export function isPiiLocale(value: unknown): value is PiiLocale {
    return typeof value === 'string' && (PII_LOCALES as readonly string[]).includes(value);
}
