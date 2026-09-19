/**
 * Which frameworks have a Statement of Applicability — DECLARED, never inferred.
 *
 * ═══ WHY THIS IS A LIST AND NOT A RULE ═══
 *
 * A Statement of Applicability is a specific artifact: a per-control record of
 * whether each control in a standard's control ANNEX is applicable, with a
 * justification for every inclusion and exclusion. Only a standard that HAS
 * such an annex, and mandates the statement, can have one. ISO 27001 clause
 * 6.1.3 d) is the archetype.
 *
 * The gate used to be `framework.kind === 'ISO_STANDARD'` (#2617). That is
 * wrong in both directions and cannot be repaired by choosing a better
 * structural signal, because BOTH available signals were measured against the
 * libraries in this repo and BOTH misclassify a shipped framework:
 *
 *   "it has `A.*` requirement codes"
 *       → ISO27701-2019 has ZERO `A.`-prefixed codes. Its Annex A/B controls
 *         are encoded as `7.x`/`8.x` here. It genuinely extends the SoA.
 *
 *   "it has Annex SL management clauses (4.x / 9.x / 10.x), so it is a
 *    management-system standard rather than a control standard"
 *       → ISO42001-2023 has TWELVE of them (`4`, `4.1`…`4.4`, `9`, `9.1`…`9.3`,
 *         `10`…) AND 47 Annex A codes. It is both, and it mandates an SoA at
 *         clause 6.1.3. This test would strip the SoA from a framework that
 *         requires one.
 *
 * The two tests fail on DIFFERENT frameworks and in OPPOSITE directions, so no
 * combination of them is sound either. Whether a standard mandates an SoA is an
 * editorial fact about the standard, not a shape its requirement tree carries.
 * So it is written down, per framework, and a new framework gets an explicit
 * decision rather than inheriting one.
 *
 * ═══ AND WHY IT FAILS CLOSED ═══
 *
 * `Framework.kind` defaults to `ISO_STANDARD` in the schema, and
 * `library-importer.ts` maps any UNRECOGNISED yaml kind to `ISO_STANDARD` too.
 * Under the old gate, a framework nobody had classified — a typo'd kind, a new
 * library, a tenant's own pack — was therefore offered an Annex A Statement of
 * Applicability BY DEFAULT. The failure mode was silent and it pointed the
 * wrong way: the artifact appears, titled, in the audit-readiness and
 * gap-analysis PDFs and as an `AnnexAKey` CSV column, describing an annex the
 * standard does not have.
 *
 * An unknown key here is FALSE. A framework that should have an SoA and is
 * missing from this list shows coverage and readiness instead — visibly
 * incomplete, and reported by the tenant. A framework that should not have one
 * and silently gets one produces a plausible, authoritative-looking document
 * about a control annex that does not exist, which an auditor may be the first
 * to catch.
 *
 * @module lib/compliance/statement-of-applicability
 */

/**
 * The frameworks whose standards mandate a Statement of Applicability against a
 * control annex.
 *
 * Keyed by `Framework.key`, and the key has THREE authoring paths that do not
 * agree on spelling. Every affected framework is listed under every spelling
 * that reaches a database, on purpose: dropping one silently disables the SoA
 * for every tenant seeded by that path.
 *
 *   prisma/fixtures/*-control-templates.json   ISO27001  ISO27701  ISO42001
 *     via `catalog-applier.ts`, listed in `scripts/seed-framework-catalogs.ts`
 *     and run by `scripts/entrypoint.sh:95` on EVERY container start. This is
 *     the path production actually uses.
 *   prisma/seed-catalog.ts                      ISO27001
 *     dev only (`npm run db:seed`); reaches no production database.
 *   src/data/libraries/*.yaml                   ISO27001-2022  ISO27701-2019
 *                                               ISO42001-2023
 *     via `library-importer.ts`, keyed on the library's `ref_id`.
 *
 * THE BARE SPELLINGS WERE MISSING FROM THE FIRST VERSION OF THIS FILE, and the
 * effect was the opposite of the fix: `ISO27701` and `ISO42001` — the keys
 * production creates — fell through to `false` and LOST an SoA they had under
 * the old `kind` gate. The list was written from the two paths that are easy
 * to grep, and the one that ships was not among them. `tests/helpers/
 * applied-catalogue.ts` exists for exactly this error; the guard beside this
 * module now uses it.
 */
const SOA_FRAMEWORK_KEYS: ReadonlySet<string> = new Set([
    // ISO/IEC 27001 — Annex A (93 controls); SoA mandated by clause 6.1.3 d).
    'ISO27001',
    'ISO27001-2022',
    // ISO/IEC 27701 — extends the ISMS SoA with the PIMS controls of its
    // Annexes A and B. Carries no `A.`-prefixed codes in this repo's library.
    'ISO27701',
    'ISO27701-2019',
    // ISO/IEC 42001 — Annex A (AI management controls); SoA mandated by 6.1.3.
    'ISO42001',
    'ISO42001-2023',
]);

/**
 * True when `frameworkKey` names a standard that has a Statement of
 * Applicability. Unknown keys are FALSE — see the module docblock.
 *
 * Deliberately takes the KEY and not the `Framework` row: the decision must not
 * be derivable from `kind`, and passing the row would put `kind` back within
 * reach of the next person to edit this.
 */
export function frameworkHasStatementOfApplicability(frameworkKey: string): boolean {
    return SOA_FRAMEWORK_KEYS.has(frameworkKey);
}

/** The declared set, for guards that assert every shipped framework is classified. */
export function soaFrameworkKeys(): string[] {
    return [...SOA_FRAMEWORK_KEYS].sort();
}
