/**
 * Reconciling the two representations of one framework.
 *
 * Every framework ships twice — the `prisma/seed.ts` row and the
 * `src/data/libraries/*.yaml` row — and a tenant's controls hang off whichever
 * one its database got. `domain/framework-representation.ts` is what lets a
 * mapping authored against the library reach controls held against the seed.
 *
 * The suite exists because that reconciliation failed SILENTLY for ISO/IEC
 * 27001. It failed on two independent axes at once, and closing either alone
 * delivers nothing:
 *
 *   identity — the seeded row carried no `sourceUrn`, so it was its own
 *              family and the collapse never fired;
 *   spelling — the seed numbers Annex A control 5.15 `5.15` and the library
 *              numbers it `A.5.15`, so a code-equality join reaches nothing
 *              even once the family IS collapsed.
 *
 * Half the file is therefore not about the functions at all: it recomputes,
 * from the shipped YAML and fixture JSON, that the `A.` strip is SAFE for ISO
 * 27001 and would be WRONG for ISO 42001. That is a property of the data, not
 * of the rule, so a later library revision must be able to turn it red.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { declarationOf } from '../helpers/source-blocks';
import {
    ISO27001_FAMILY_URN,
    LEGACY_KEY_FAMILY_URNS,
    SOC2_FAMILY_URN,
    canonicalRequirementCode,
    frameworkFamilyId,
    requirementCodeSpellings,
} from '@/app-layer/domain/framework-representation';

const ROOT = path.resolve(__dirname, '../..');
const LIB_DIR = path.join(ROOT, 'src/data/libraries');
const ISO42001_FAMILY_URN = 'urn:inflect:library:iso-42001';

const libraryCodes = (file: string): string[] =>
    loadLibrary(parseLibraryFile(path.join(LIB_DIR, file)), file).framework.nodes.map((n) => n.refId);

/**
 * The requirement codes `prisma/seed.ts` writes for one framework, read out of
 * the seed's own array literal rather than duplicated here. `declarationOf`
 * bounds the read to that declaration and strips comments, so a code named in
 * a comment cannot satisfy the comparison, and an unrelated edit elsewhere in
 * the seed cannot slide the window off the target.
 */
const seededCodes = (declaration: string): string[] =>
    [...declarationOf(fs.readFileSync(path.join(ROOT, 'prisma/seed.ts'), 'utf8'), declaration)
        .matchAll(/\bcode: '([^']+)'/g)].map((m) => m[1]);

/**
 * The requirement codes a CatalogFile declares — what production actually
 * creates for that framework.
 *
 * SOC 2 used to be read out of `soc2Reqs` in prisma/seed.ts. That block built
 * the framework a SECOND time alongside the CatalogFile a production seeder
 * applies, and was removed; seed.ts is not run on deploys, so it was never the
 * authority here anyway.
 */
const catalogCodes = (file: string): string[] =>
    (JSON.parse(fs.readFileSync(path.join(ROOT, 'prisma/fixtures', file), 'utf8')) as {
        requirements: Array<{ code: string }>;
    }).requirements.map((r) => r.code);

const fixtureCodes = (file: string): string[] =>
    (JSON.parse(fs.readFileSync(path.join(ROOT, 'prisma/fixtures', file), 'utf8')) as Array<{
        key: string;
    }>).map((r) => r.key);

/** Canonical codes that more than one distinct raw code in the set reduces to. */
function canonicalCollisions(familyId: string, codes: readonly string[]): string[] {
    const rawByCanonical = new Map<string, Set<string>>();
    for (const code of codes) {
        const canonical = canonicalRequirementCode(familyId, code);
        const bucket = rawByCanonical.get(canonical) ?? new Set<string>();
        bucket.add(code);
        rawByCanonical.set(canonical, bucket);
    }
    return [...rawByCanonical.entries()]
        .filter(([, raw]) => raw.size > 1)
        .map(([canonical]) => canonical)
        .sort();
}

describe('frameworkFamilyId', () => {
    it('uses sourceUrn when the row has one', () => {
        expect(frameworkFamilyId({ key: 'ISO42001', sourceUrn: ISO42001_FAMILY_URN })).toBe(
            ISO42001_FAMILY_URN,
        );
        expect(frameworkFamilyId({ key: 'ISO42001-2023', sourceUrn: ISO42001_FAMILY_URN })).toBe(
            ISO42001_FAMILY_URN,
        );
    });

    it('places a legacy seeded ISO27001 row — sourceUrn null — in the library family', () => {
        // The measured cause of the inert ISMS route. A database seeded before
        // `prisma/seed.ts` wrote the urn is NOT re-seeded on deploy, so the
        // fallback is what makes the fix true for tenants that already exist.
        expect(frameworkFamilyId({ key: 'ISO27001', sourceUrn: null })).toBe(ISO27001_FAMILY_URN);
        expect(frameworkFamilyId({ key: 'ISO27001-2022', sourceUrn: ISO27001_FAMILY_URN })).toBe(
            ISO27001_FAMILY_URN,
        );
    });

    it('degrades an unknown urn-less row to its own family rather than guessing', () => {
        expect(frameworkFamilyId({ key: 'CUSTOM-THING', sourceUrn: null })).toBe('key:CUSTOM-THING');
    });

    it('places a seeded SOC2 row in the library family too', () => {
        // `prisma/seed.ts` wrote NO urn on this row at all until the entry
        // landed, so unlike ISO 27001 this is not only a legacy-database
        // fallback: every database has an urn-less `SOC2` row until it is
        // re-seeded.
        expect(frameworkFamilyId({ key: 'SOC2', sourceUrn: null })).toBe(SOC2_FAMILY_URN);
        expect(frameworkFamilyId({ key: 'SOC2-2017', sourceUrn: SOC2_FAMILY_URN })).toBe(
            SOC2_FAMILY_URN,
        );
    });

    it('carries only the keys whose two representations have been compared', () => {
        // Each entry ASSERTS that two `Framework` rows describe one framework,
        // so the list is not a place to add a guess: the two `describe` blocks
        // at the foot of this file recompute the code comparison behind each
        // one from the shipped data.
        expect(Object.keys(LEGACY_KEY_FAMILY_URNS).sort()).toEqual(['ISO27001', 'SOC2']);
    });
});

describe('canonicalRequirementCode', () => {
    it('reduces both ISO 27001 Annex A spellings to one join key', () => {
        expect(canonicalRequirementCode(ISO27001_FAMILY_URN, 'A.5.15')).toBe('5.15');
        expect(canonicalRequirementCode(ISO27001_FAMILY_URN, '5.15')).toBe('5.15');
        expect(canonicalRequirementCode(ISO27001_FAMILY_URN, 'A.8.2')).toBe('8.2');
    });

    it('leaves an ISO 27001 clause and an Annex A THEME alone', () => {
        // `A.5` is the Organizational-controls theme and `5` is the Leadership
        // clause. Neither has the `<n>.<n>` shape, so neither is touched.
        expect(canonicalRequirementCode(ISO27001_FAMILY_URN, 'A.5')).toBe('A.5');
        expect(canonicalRequirementCode(ISO27001_FAMILY_URN, '5')).toBe('5');
        expect(canonicalRequirementCode(ISO27001_FAMILY_URN, '10')).toBe('10');
    });

    it('does NOT strip outside the ISO 27001 family', () => {
        // ISO 42001 clause 8.2 (AI risk assessment) and Annex control A.8.2
        // (system documentation) are different obligations that BOTH exist in
        // BOTH representations. A blanket strip merges them.
        expect(canonicalRequirementCode(ISO42001_FAMILY_URN, 'A.8.2')).toBe('A.8.2');
        expect(canonicalRequirementCode(ISO42001_FAMILY_URN, '8.2')).toBe('8.2');
        expect(canonicalRequirementCode('key:ISO27001', 'A.5.15')).toBe('A.5.15');
    });
});

describe('requirementCodeSpellings', () => {
    it('offers both ISO 27001 Annex A spellings, whichever it was given', () => {
        expect(requirementCodeSpellings(ISO27001_FAMILY_URN, 'A.5.15')).toEqual(['A.5.15', '5.15']);
        expect(requirementCodeSpellings(ISO27001_FAMILY_URN, '5.15')).toEqual(['5.15', 'A.5.15']);
    });

    it('offers one spelling for codes with no second form', () => {
        expect(requirementCodeSpellings(ISO27001_FAMILY_URN, 'A.5')).toEqual(['A.5']);
        expect(requirementCodeSpellings(ISO27001_FAMILY_URN, '7')).toEqual(['7']);
        expect(requirementCodeSpellings(ISO42001_FAMILY_URN, 'A.8.2')).toEqual(['A.8.2']);
        expect(requirementCodeSpellings('urn:inflect:library:owasp-agentic-top10', 'ASI03')).toEqual([
            'ASI03',
        ]);
    });
});

describe('the shipped data the ISO 27001 rule stands on', () => {
    const libCodes = libraryCodes('iso27001-2022.yaml');
    const seedCodes = fixtureCodes('iso27001_2022_annexA.json');

    it('the two representations really do disagree — no code is spelled the same in both', () => {
        // If this ever goes green the other way round, the strip has become
        // dead code and should be deleted rather than kept "just in case".
        const shared = libCodes.filter((c) => seedCodes.includes(c));
        expect(shared).toEqual([]);
    });

    it('canonicalising joins them: every seeded Annex A code is reachable from the library', () => {
        const canonicalLib = new Set(
            libCodes.map((c) => canonicalRequirementCode(ISO27001_FAMILY_URN, c)),
        );
        const reachable = seedCodes.filter((c) => canonicalLib.has(c));
        // The library carries a curated SUBSET of Annex A, not all 93 rows.
        expect(reachable.length).toBe(29);
        expect(reachable.slice(0, 4)).toEqual(['5.1', '5.2', '5.3', '5.7']);
    });

    it('collapses no two distinct codes inside either representation', () => {
        expect(canonicalCollisions(ISO27001_FAMILY_URN, libCodes)).toEqual([]);
        expect(canonicalCollisions(ISO27001_FAMILY_URN, seedCodes)).toEqual([]);
    });

    it('would collapse real ISO 42001 obligations if the rule were not family-scoped', () => {
        const iso42001Lib = libraryCodes('iso-42001.yaml');
        const iso42001Seed = fixtureCodes('iso_42001_requirements.json');

        // Both spellings present in BOTH representations — this is the
        // measurement that rules out a blanket strip.
        for (const codes of [iso42001Lib, iso42001Seed]) {
            expect(codes.includes('8.2')).toBe(true);
            expect(codes.includes('A.8.2')).toBe(true);
        }

        // Under the ISO 27001 rule they would merge…
        expect(canonicalCollisions(ISO27001_FAMILY_URN, iso42001Lib).length).toBeGreaterThan(0);
        // …and under the family they actually belong to, they do not.
        expect(canonicalCollisions(ISO42001_FAMILY_URN, iso42001Lib)).toEqual([]);
        expect(canonicalCollisions(ISO42001_FAMILY_URN, iso42001Seed)).toEqual([]);
    });
});

describe('the shipped data the SOC 2 rule stands on', () => {
    const libCodes = libraryCodes('soc2-2017.yaml');
    const seedCodes = catalogCodes('soc2-control-templates.json');

    it('the detector actually found the criteria production creates', () => {
        // Without this, a renamed field or a reshaped fixture would make every
        // comparison below vacuously true over an empty list.
        expect(seedCodes.length).toBeGreaterThanOrEqual(10);
        expect(seedCodes).toContain('CC6.1');
    });

    it('every seeded criterion is spelled the same in the library', () => {
        // This is what makes a legacy-key entry SUFFICIENT for SOC 2 and a
        // code rule unnecessary: the identity axis is the only one that
        // differs. If a future library revision renumbers the criteria, this
        // goes red and the entry needs a canonicalisation rule beside it.
        expect(seedCodes.filter((c) => !libCodes.includes(c))).toEqual([]);
    });

    it('the two representations really are different rows, not one', () => {
        // The library carries the non-assessable parent nodes (`CC1`, `CC2`, …)
        // and the supplemental criteria the seed omits, so the sets are not
        // equal — the seeded list is a strict subset.
        expect(libCodes.filter((c) => !seedCodes.includes(c)).length).toBeGreaterThan(0);
    });

    it('canonicalisation is the identity here, and collapses nothing', () => {
        for (const code of [...libCodes, ...seedCodes]) {
            expect(canonicalRequirementCode(SOC2_FAMILY_URN, code)).toBe(code);
        }
        expect(canonicalCollisions(SOC2_FAMILY_URN, libCodes)).toEqual([]);
        expect(canonicalCollisions(SOC2_FAMILY_URN, seedCodes)).toEqual([]);
    });

    it('the applied catalogue writes the urn, so the legacy entry is a fallback and not the only tie', () => {
        // This read prisma/seed.ts's `soc2` framework row until that row was
        // removed — SOC 2 was being built twice and the duplicate went.
        //
        // The move nearly dropped the urn: unlike the other three frameworks
        // converged with it, SOC 2 carries no metadataJson, so it was left out
        // when provenance was added to the CatalogFiles, and nobody noticed it
        // still had a sourceUrn. This assertion is what caught that.
        const catalog = JSON.parse(
            fs.readFileSync(
                path.join(ROOT, 'prisma/fixtures/soc2-control-templates.json'),
                'utf8',
            ),
        ) as { framework: { sourceUrn?: string } };
        expect(catalog.framework.sourceUrn).toBe(SOC2_FAMILY_URN);
    });
});
