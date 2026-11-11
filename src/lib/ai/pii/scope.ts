/**
 * WHAT THE PII DETECTOR IS FOR — D-L1-1, as code (owner decision, 2026-11-11).
 *
 * Phase 0 of `docs/ai-architecture/presidio.md`. Nothing here detects or
 * redacts anything: it is the scope the later phases read, so the decision has
 * one spelling rather than one per module.
 *
 *   - ROUTES. Text bound for an EXTERNAL model route only (`inflect-external`).
 *     A `LOCAL_ONLY` tenant's local route is not redacted: nothing leaves the
 *     perimeter there. `LOCAL_ROUTE_REDACTED` is that decision, and it is
 *     `false`.
 *   - ENTITY TYPES. Exactly five. LOCATION and ORG were considered and are NOT
 *     in scope: an address or a company name in a fixture is unlabelled
 *     context, and a detector's LOCATION/ORG spans are ignored by the scorer
 *     rather than counted as mistakes.
 *   - LOCALES. EN and BG, the product's two (next-intl parity).
 *
 * The names are Presidio's own entity names, plus `BG_EGN` for the custom
 * ЕГН recogniser, so a record compares the analyzer's output to the fixtures
 * with no translation table in between — a translation table is where a type
 * silently stops being scored.
 *
 * The ACTION per type (replace with a numbered typed placeholder,
 * `<PERSON_1>`) is the Phase 0 default recorded in
 * `docs/implementation-notes/2026-11-11-pii-redaction-decision.md`; Phase 1's
 * `policy.ts` encodes it. It is not here because nothing in Phase 0 redacts.
 *
 * @module lib/ai/pii/scope
 */

/** The five entity types D-L1-1 puts in scope, in Presidio's spelling. */
export const PII_ENTITY_TYPES = [
    'PERSON',
    'EMAIL_ADDRESS',
    'PHONE_NUMBER',
    'IBAN_CODE',
    'BG_EGN',
] as const;
export type PiiEntityType = (typeof PII_ENTITY_TYPES)[number];

/** EN + BG. A type is scored per locale, so a BG gap cannot hide behind EN. */
export const PII_LOCALES = ['en', 'bg'] as const;
export type PiiLocale = (typeof PII_LOCALES)[number];

/** D-L1-1: a LOCAL_ONLY tenant's local route is not redacted. */
export const LOCAL_ROUTE_REDACTED = false as const;

export function isPiiEntityType(value: string): value is PiiEntityType {
    return (PII_ENTITY_TYPES as readonly string[]).includes(value);
}
