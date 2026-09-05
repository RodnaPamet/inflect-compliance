/**
 * Two representations of one framework, reconciled.
 *
 * Every framework in this repo can exist TWICE in `Framework`: the row
 * `prisma/seed.ts` writes, and the row `library-importer.ts` writes from the
 * YAML in `src/data/libraries/`. Their `key` values must differ because
 * `Framework.key` is `@unique`, and a tenant's controls hang off whichever row
 * its database happened to get. Anything that joins a tenant's controls to a
 * cross-framework mapping therefore has to reconcile the two, or it reports a
 * tenant with a full control set as covering nothing — a readout identical to
 * a tenant that has done no work.
 *
 * The two representations can disagree on TWO axes, and they are independent:
 * fixing one alone changes nothing.
 *
 *  1. FRAMEWORK IDENTITY. `sourceUrn` is the tie: the seed writes the
 *     library's urn verbatim. Rows predating that convention have `null`, so
 *     `LEGACY_KEY_FAMILY_URNS` carries the seeded keys known to be a second
 *     representation of a shipped library. It is a fallback for databases
 *     seeded before the urn was written, not a general alias table — a key
 *     with no entry degrades to "this row is its own family", which is a
 *     missing join rather than a wrong one.
 *
 *  2. CODE NAMESPACE. `FrameworkRequirement.code` is the only identifier the
 *     two representations share, and for ISO/IEC 27001:2022 they spell it
 *     differently: `prisma/fixtures/iso27001_2022_annexA.json` numbers the 93
 *     Annex A controls `5.15`, while `src/data/libraries/iso27001-2022.yaml`
 *     numbers them `A.5.15`. Every mapping set is authored against the library
 *     spelling (the importer resolves refs against library keys), so a
 *     code-equality join reaches nothing a seeded tenant holds.
 *
 * WHY THE `A.` STRIP IS SCOPED TO ONE FAMILY RATHER THAN APPLIED EVERYWHERE.
 * It looks like a formatting difference and is not. Inside ISO/IEC 42001:2023
 * BOTH representations carry clause `8.2` (AI risk assessment) AND Annex
 * control `A.8.2` (system documentation) — different obligations, both
 * present, in both representations. A blanket strip merges them and inflates
 * inherited coverage on a route that works today. ISO 27001 is safe for the
 * opposite reason, and it is a property of the data rather than of the rule:
 * its library carries clauses `4`…`10` with no sub-clauses, so no clause code
 * has the `<n>.<n>` shape the strip produces. `tests/unit/framework-representation.test.ts`
 * recomputes that collision check from the shipped YAML and fixtures, so a
 * library that later gains clause `5.1` turns red instead of joining silently.
 */

/** ISO/IEC 27001:2022 — the one family whose two representations differ on code shape. */
export const ISO27001_FAMILY_URN = 'urn:inflect:library:iso27001-2022';

/**
 * Seeded `Framework.key` → the library urn it is a second representation of,
 * for rows written before `prisma/seed.ts` carried `sourceUrn`.
 *
 * ONE entry, deliberately. `ISO27001` is the only seeded key that both lacks
 * the urn today and sits on a mapping edge into an agentic framework. Adding a
 * key here asserts that two rows describe one framework; assert it only where
 * the requirement codes have actually been compared.
 */
export const LEGACY_KEY_FAMILY_URNS: Readonly<Record<string, string>> = {
    ISO27001: ISO27001_FAMILY_URN,
};

/** The minimum a caller must know about a `Framework` row to place it in a family. */
export interface FrameworkIdentity {
    readonly key: string;
    readonly sourceUrn: string | null;
}

/**
 * The identity of a framework ACROSS representations.
 *
 * `sourceUrn` when the row has one, the legacy key map when it does not, and
 * otherwise the key itself — which degrades to "this row is its own family"
 * rather than to a wrong join.
 */
export function frameworkFamilyId(fw: FrameworkIdentity): string {
    return fw.sourceUrn ?? LEGACY_KEY_FAMILY_URNS[fw.key] ?? `key:${fw.key}`;
}

/** `A.5.15` — the library spelling of an ISO 27001 Annex A control. */
const ISO27001_PREFIXED_ANNEX_A = /^A\.(\d+\.\d+)$/;
/** `5.15` — the seeded spelling of the same control. */
const ISO27001_BARE_ANNEX_A = /^\d+\.\d+$/;

/**
 * The join key for a requirement code within its family: one string that both
 * representations' spellings of the same obligation reduce to.
 */
export function canonicalRequirementCode(familyId: string, code: string): string {
    if (familyId !== ISO27001_FAMILY_URN) return code;
    return ISO27001_PREFIXED_ANNEX_A.exec(code)?.[1] ?? code;
}

/**
 * Every spelling of one obligation within a family — what to ask the database
 * for when a query has one representation's code and needs the other's rows.
 *
 * Always includes `code` itself, first.
 */
export function requirementCodeSpellings(familyId: string, code: string): string[] {
    if (familyId !== ISO27001_FAMILY_URN) return [code];

    const bare = ISO27001_PREFIXED_ANNEX_A.exec(code)?.[1];
    if (bare) return [code, bare];
    if (ISO27001_BARE_ANNEX_A.test(code)) return [code, `A.${code}`];
    return [code];
}
