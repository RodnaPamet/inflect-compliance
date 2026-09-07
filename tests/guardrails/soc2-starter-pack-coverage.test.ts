/**
 * SOC 2 — what production applies, and whether it resolves.
 *
 * ═══ THE PROXY THIS FILE CARRIED ═══
 *
 * The last block used to be:
 *
 *     const seed = read('prisma/seed.ts');
 *     expect(seed).toContain("'SOC2_STARTER_PACK'");
 *
 * `prisma/seed.ts` is not run on a production deploy, so that assertion could
 * not fail while the SOC 2 pack was undeliverable — and it named the wrong key
 * besides. Verified against the live production database: production has
 * SOC2_BASELINE. SOC2_STARTER_PACK is a row no customer has ever seen. The
 * catalogue reuses SOC2_BASELINE deliberately (see the fixture's `_meta`), so
 * a tenant is not offered two competing SOC 2 packs.
 *
 * Everything below therefore reads the CatalogFile that a seeder in
 * `scripts/entrypoint.sh` actually applies — discovered through
 * `appliedCatalogFor('SOC2')`, not by a hard-coded fixture path — and the
 * seed.ts arm survives only where the claim is genuinely about seed.ts.
 *
 * ═══ THE ORIGINAL FAILURE MODE, STILL GUARDED ═══
 *
 * A control that references a criterion its catalogue does not carry — a typo,
 * a renamed criterion, a control written against the real AICPA numbering
 * (CC6.6) rather than the criteria this product ships — used to produce NO
 * link and NO error: `prisma/seed.ts` links through
 * `if (soc2ReqMap[rk]) { …create the link… }`. The pack installed, the
 * controls appeared, and coverage was quietly lower than it should be.
 * `applyCatalogFile` aborts on such a ref instead (`assertCatalogConsistency`),
 * which turns a silent under-count into a failed deploy seeder — worth
 * catching here, at fixture-edit time, rather than on a container start.
 *
 * So the assertions here are about resolution, not shape:
 *   - every requirement ref in the applied catalogue resolves against BOTH its
 *     own requirement set and the library (src/data/libraries/soc2-2017.yaml,
 *     which is what the framework means);
 *   - the declarations agree, so a criterion cannot be added to one alone;
 *   - the pack spans CC1–CC9 — a starter pack missing a Common Criteria
 *     category installs to a permanently-uncoverable requirement;
 *   - every declared criterion is targeted by at least one control, which is
 *     what makes the day-one baseline 100% rather than partial;
 *   - the codes keep the 'TSC-' prefix and stay out of the 'SOC2-' namespace
 *     held by the seven placeholder templates that SOC2_BASELINE
 *     transitionally still carries (scripts/backfill-framework-catalog.mjs
 *     packs those by code prefix, and `ControlTemplate.code` is unique).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { appliedCatalogFor, productionDeclaringSources } from '../helpers/applied-catalogue';
import { declarationOf, braceBlockAfter } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FREQUENCIES = new Set(['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY']);
/** Every Common Criteria category a SOC 2 starter pack must reach. */
const CC_CATEGORIES = ['CC1', 'CC2', 'CC3', 'CC4', 'CC5', 'CC6', 'CC7', 'CC8', 'CC9'] as const;

interface StarterControl {
    code: string;
    title: string;
    description: string;
    category: string;
    defaultFrequency: string;
    defaultOwnerHint: string;
    /** Renamed from `requirements` when the fixture became a CatalogFile —
     *  `applyCatalogFile` reads `requirementCodes`. */
    requirementCodes: string[];
    /** Locale objects since the same move; the old shape was bare strings. */
    tasks: Array<{ title: { en: string }; description: { en: string } }>;
}

/**
 * The catalogue a production seeder applies for SOC 2, found by framework key.
 *
 * This used to be `JSON.parse(read('prisma/fixtures/soc2-control-templates.json'))`
 * — a path, which says nothing about whether anything applies it. Going
 * through the helper means the file has to be named by a seeder that
 * `scripts/entrypoint.sh` runs, so unwiring the fixture reddens this file
 * instead of leaving it green over a document nobody reads.
 */
const applied = appliedCatalogFor('SOC2');
const controls = (applied?.templates ?? []) as unknown as StarterControl[];
const CATALOG_CRITERIA = (applied?.requirements ?? []).map((r) => String(r.code));
const pack = (applied?.pack ?? {}) as { key?: string; templateCodes?: string[] };

/**
 * The criterion codes a dev-only seed program states inline.
 *
 * `prisma/seed.ts` used to be one of these, and is not any more: its SOC 2
 * block built the framework a second time and was removed when SOC 2 moved
 * onto applyCatalogFile. `prisma/seed-catalog.ts` still declares its own
 * `soc2Reqs`, and is a manual operator CLI that scripts/entrypoint.sh does not
 * run — so it can still drift from the catalogue production applies.
 */
function seededCriterionCodes(rel: string): string[] {
    const block = declarationOf(read(rel), 'soc2Reqs');
    return [...block.matchAll(/code:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** The assessable criteria the framework library declares. */
const soc2 = loadLibrary(
    parseLibraryFile(path.join(ROOT, 'src/data/libraries/soc2-2017.yaml')),
    'soc2-2017',
);
const LIBRARY_ASSESSABLE = soc2.framework.nodes
    .filter((n) => n.assessable)
    .map((n) => n.refId);

describe('SOC 2 delivery', () => {
    it('a production seeder applies a SOC 2 catalogue at all', () => {
        // DENOMINATOR. `appliedCatalogFor` returns null when nothing production
        // runs names a CatalogFile with this framework key, and every case in
        // this file is vacuous on null — `controls` becomes [], so each `for`
        // loop below iterates nothing and each `toEqual([])` passes.
        expect(applied).not.toBeNull();
        expect(applied?.file).toBe('prisma/fixtures/soc2-control-templates.json');
        expect(applied?.requirements.length).toBeGreaterThanOrEqual(10);
        expect(applied?.templates.length).toBeGreaterThanOrEqual(20);
    });

    it('declares the framework as SOC2 2017, kind SOC_CRITERIA', () => {
        expect(applied?.framework.key).toBe('SOC2');
        expect(applied?.framework.version).toBe('2017');
        expect(applied?.framework.kind).toBe('SOC_CRITERIA');
    });

    it('declares the pack production actually has', () => {
        // SOC2_BASELINE, not seed.ts's SOC2_STARTER_PACK — checked against the
        // live production database. Reused on purpose: a second SOC 2 pack
        // would make a tenant choose between two offerings of the same thing.
        expect(pack.key).toBe('SOC2_BASELINE');
        expect(productionDeclaringSources('SOC2_BASELINE')).toContain(
            'prisma/fixtures/soc2-control-templates.json',
        );
        // And the dev-only key stays dev-only. If this ever fails, the pack a
        // customer installs has been renamed to one production has never had.
        expect(productionDeclaringSources('SOC2_STARTER_PACK')).toEqual([]);
    });

    it('links every curated template into that pack by explicit code', () => {
        // `applyCatalogFile` links `pack.templateCodes`, not a code prefix, so
        // a template added to the catalogue and forgotten here ships as an
        // unpacked control: installable one at a time, absent from the pack.
        expect([...(pack.templateCodes ?? [])].sort()).toEqual(controls.map((c) => c.code).sort());
    });
});

describe('SOC 2 Starter Pack — curated control templates', () => {
    it('ships a substantive set of uniquely-coded controls', () => {
        expect(controls.length).toBeGreaterThanOrEqual(20);
        const codes = controls.map((c) => c.code);
        expect(new Set(codes).size).toBe(codes.length);
    });

    it('uses the TSC- prefix, never the SOC2- prefix the baseline backfill packs by', () => {
        const wrong = controls.filter((c) => !/^TSC-/.test(c.code) || /^SOC2-/i.test(c.code));
        expect(wrong.map((c) => c.code)).toEqual([]);
    });

    it('every control is fully specified (title, description, category, frequency, owner, tasks)', () => {
        for (const c of controls) {
            expect(c.title).toBeTruthy();
            expect(c.description.length).toBeGreaterThan(40);
            expect(c.category).toBeTruthy();
            expect(FREQUENCIES.has(c.defaultFrequency)).toBe(true);
            expect(c.defaultOwnerHint).toBeTruthy();
            expect(c.tasks.length).toBeGreaterThanOrEqual(1);
            for (const t of c.tasks) {
                expect(t.title.en).toBeTruthy();
                expect(t.description.en).toBeTruthy();
            }
        }
    });

    it('every requirement ref resolves against the criteria the catalogue creates', () => {
        const declared = new Set(CATALOG_CRITERIA);
        const dangling: string[] = [];
        for (const c of controls) {
            expect(c.requirementCodes.length).toBeGreaterThanOrEqual(1);
            for (const r of c.requirementCodes) {
                if (!declared.has(r)) dangling.push(`${c.code} → ${r}`);
            }
        }
        expect(dangling).toEqual([]);
    });

    it('every requirement ref also resolves against the framework library', () => {
        const live = new Set(LIBRARY_ASSESSABLE);
        const dangling: string[] = [];
        for (const c of controls) {
            for (const r of c.requirementCodes) {
                if (!live.has(r)) dangling.push(`${c.code} → ${r}`);
            }
        }
        expect(dangling).toEqual([]);
    });

    it('covers every Common Criteria category CC1–CC9', () => {
        const covered = new Set(
            controls.flatMap((c) => c.requirementCodes.map((r) => r.split('.')[0])),
        );
        const missing = CC_CATEGORIES.filter((g) => !covered.has(g));
        expect(missing).toEqual([]);
    });

    it('leaves no declared criterion uncovered — the day-one baseline is 100%, not partial', () => {
        const targeted = new Set(controls.flatMap((c) => c.requirementCodes));
        const uncovered = CATALOG_CRITERIA.filter((code) => !targeted.has(code));
        expect(uncovered).toEqual([]);
    });
});

/**
 * The seed.ts consumer-shape describe was DELETED here, not repointed.
 *
 * It guarded a real past bug: prisma/seed.ts read
 * soc2-control-templates.json and treated it as an ARRAY when the file is
 * `{ _meta, framework, requirements, templates, pack }`. A shape mismatch
 * between a fixture and its consumer is invisible to every test that reads the
 * fixture, so the assertions were deliberately about the CONSUMER — its cast,
 * its field reads — bound to seed.ts with declarationOf and braceBlockAfter.
 *
 * That consumer no longer exists. SOC 2 moved onto applyCatalogFile and its
 * seed.ts block went with it, so there is no hand-rolled reader left to get
 * the shape wrong: the fixture now reaches the database only through
 * loadCatalogFile, which validates it against CatalogFileSchema and throws on
 * a mismatch rather than casting past one.
 *
 * declarationOf threw `declaration not found: const soc2Catalog` rather than
 * matching an empty string, which is why this was noticed at all — a guard
 * whose subject is renamed away must fail loudly.
 */


describe('SOC 2 criteria — every declaration agrees', () => {
    it("the applied catalogue carries exactly the library's assessable Common Criteria", () => {
        const libraryCC = LIBRARY_ASSESSABLE.filter((r) => r.startsWith('CC')).sort();
        expect([...CATALOG_CRITERIA].sort()).toEqual(libraryCC);
    });

    // The three-way drift check is now two-way, and that is a REDUCTION IN
    // RISK rather than in coverage. The criteria were stated in three places:
    // this catalogue, `soc2Reqs` in prisma/seed.ts, and the library YAML.
    // seed.ts no longer states them — SOC 2 moved onto applyCatalogFile and
    // its duplicate block went — so there is one fewer copy to drift. What
    // remains is asserted above: the catalogue against the library.

    it('prisma/seed-catalog.ts states the same criteria the applied catalogue declares', () => {
        // seed-catalog.ts is a manual operator CLI, run by hand and not by
        // scripts/entrypoint.sh, and it still declares its own `soc2Reqs`. It
        // was previously checked against prisma/seed.ts — a lockstep between
        // two dev-only copies, which said nothing about either matching what
        // production gets. seed.ts has since stopped stating the criteria, so
        // the comparison now runs against the catalogue a production seeder
        // applies: the only copy that reaches a customer.
        expect([...seededCriterionCodes('prisma/seed-catalog.ts')].sort()).toEqual(
            [...CATALOG_CRITERIA].sort(),
        );
    });
});
