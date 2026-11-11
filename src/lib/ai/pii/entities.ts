/**
 * THE PII SCOPE — D-L1-1, written once (owner decision, 2026-11-11).
 *
 *   - entity types: PERSON, EMAIL, PHONE, IBAN, EGN (the Bulgarian ЕГН);
 *   - locales: EN and BG, the product's two;
 *   - paths: EXTERNAL routes only (`inflect-external`);
 *   - LOCAL_ONLY: off — the local route (`inflect-local`) is never redacted,
 *     because nothing on it leaves the perimeter.
 *
 * Every other module under `src/lib/ai/pii/` reads these constants and none
 * restates them. Widening the scope (LOCATION, ORG, a third locale, the local
 * route) is a reviewed diff to THIS file and an owner decision, never a config
 * value: a scope that a deployment or a tenant could widen would also be one it
 * could narrow.
 *
 * The Presidio recognisers that produce these types are Phase 0's (built in
 * the service image, `guards/presidio/`). Their wire names are mapped in
 * {@link PRESIDIO_ENTITY_NAME}; that map is the one place a rename on the
 * service side has to be followed here.
 *
 * Leaf module: no imports, so a client surface (a future settings page that
 * lists the types) can hold it without dragging the provider graph along.
 */

/** D-L1-1's entity types, in a fixed order that also breaks merge ties. */
export const PII_ENTITY_TYPES = ['PERSON', 'EMAIL', 'PHONE', 'IBAN', 'EGN'] as const;
export type PiiEntityType = (typeof PII_ENTITY_TYPES)[number];

/** D-L1-1's locales, as Presidio language codes. */
export const PII_LOCALES = ['en', 'bg'] as const;
export type PiiLocale = (typeof PII_LOCALES)[number];

/**
 * The residency routes a model call can take (G1). The ids are the provider
 * ids `flue/model-selection.ts` registers; restated as a type here rather than
 * imported so this leaf does not pull the Flue module graph, and held equal to
 * `FLUE_PROVIDER_IDS` by `tests/unit/ai/pii/pii-scope.test.ts`.
 */
export type PiiEgressRoute = 'inflect-external' | 'inflect-local';

/** D-L1-1: redaction applies to text leaving on an EXTERNAL route, and only there. */
export function redactionAppliesToRoute(route: PiiEgressRoute): boolean {
    return route === 'inflect-external';
}

/**
 * Presidio's name for each type. The first four are recognisers Presidio
 * ships; `BG_EGN` is the custom ЕГН recogniser (checksum) Phase 0 writes. A
 * `Record` keyed on the union, so a type added above without a wire name fails
 * `tsc`.
 */
export const PRESIDIO_ENTITY_NAME: Readonly<Record<PiiEntityType, string>> = {
    PERSON: 'PERSON',
    EMAIL: 'EMAIL_ADDRESS',
    PHONE: 'PHONE_NUMBER',
    IBAN: 'IBAN_CODE',
    EGN: 'BG_EGN',
};

const FROM_PRESIDIO: ReadonlyMap<string, PiiEntityType> = new Map(
    PII_ENTITY_TYPES.map((t) => [PRESIDIO_ENTITY_NAME[t], t] as const),
);

/** Our type for a Presidio entity name, or null for a type outside D-L1-1. */
export function entityTypeFromPresidio(name: string): PiiEntityType | null {
    return FROM_PRESIDIO.get(name) ?? null;
}

export function isPiiEntityType(v: unknown): v is PiiEntityType {
    return typeof v === 'string' && (PII_ENTITY_TYPES as readonly string[]).includes(v);
}

export function isPiiLocale(v: unknown): v is PiiLocale {
    return typeof v === 'string' && (PII_LOCALES as readonly string[]).includes(v);
}
