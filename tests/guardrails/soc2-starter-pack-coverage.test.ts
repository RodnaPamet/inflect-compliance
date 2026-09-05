/**
 * SOC 2 Starter Pack — fixture ⇄ criteria integrity.
 *
 * The failure mode this exists for is SILENT. `prisma/seed.ts` links each
 * curated control to its criteria with
 *
 *     if (soc2ReqMap[rk]) { …create the link… }
 *
 * so a control that references a criterion the seed does not carry — a typo,
 * a criterion that was renamed, a control written against the real AICPA
 * numbering (CC6.6) rather than the criteria this product seeds — produces NO
 * link and NO error. The pack installs, the controls appear, and the coverage
 * number is quietly lower than it should be. Nothing in the product says why.
 *
 * So the assertions here are about resolution, not shape:
 *   - every requirement ref in the fixture resolves against BOTH the seed's
 *     `soc2Reqs` (which is what the link actually looks up) and the library
 *     (src/data/libraries/soc2-2017.yaml, which is what the framework means);
 *   - the two lists agree, so a criterion cannot be added to one alone;
 *   - the pack spans CC1–CC9 — a starter pack missing a Common Criteria
 *     category installs to a permanently-uncoverable requirement;
 *   - every seeded criterion is targeted by at least one control, which is
 *     what makes the day-one baseline 100% rather than partial;
 *   - the codes do not collide with the 'SOC2-' prefix owned by
 *     SOC2_BASELINE in scripts/backfill-framework-catalog.mjs — sharing it
 *     would make each pack swallow the other's templates.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { declarationOf } from '../helpers/source-blocks';

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
 * The fixture is now a CatalogFile — `{ framework, requirements, templates,
 * pack }` — rather than the bare array this guard was written against, so that
 * `applyCatalogFile` can create the framework, its criteria, the templates,
 * their links and the pack together. Every assertion below is unchanged; only
 * the reader moved, which is the right split: the docblock above says these
 * assertions are about RESOLUTION, not shape, and that stayed true.
 */
const catalog = JSON.parse(read('prisma/fixtures/soc2-control-templates.json')) as {
    requirements: Array<{ code: string }>;
    templates: StarterControl[];
};
const controls = catalog.templates;

/** The criterion codes the seed actually creates — the link lookup's domain. */
function seededCriterionCodes(rel: string): string[] {
    const block = declarationOf(read(rel), 'soc2Reqs');
    return [...block.matchAll(/code:\s*'([^']+)'/g)].map((m) => m[1]);
}
const SEEDED = seededCriterionCodes('prisma/seed.ts');

/** The assessable criteria the framework library declares. */
const soc2 = loadLibrary(
    parseLibraryFile(path.join(ROOT, 'src/data/libraries/soc2-2017.yaml')),
    'soc2-2017',
);
const LIBRARY_ASSESSABLE = soc2.framework.nodes
    .filter((n) => n.assessable)
    .map((n) => n.refId);

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

    it('every requirement ref resolves against the criteria the seed creates', () => {
        const seeded = new Set(SEEDED);
        const dangling: string[] = [];
        for (const c of controls) {
            expect(c.requirementCodes.length).toBeGreaterThanOrEqual(1);
            for (const r of c.requirementCodes) {
                if (!seeded.has(r)) dangling.push(`${c.code} → ${r}`);
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

    it('leaves no seeded criterion uncovered — the day-one baseline is 100%, not partial', () => {
        const targeted = new Set(controls.flatMap((c) => c.requirementCodes));
        const uncovered = SEEDED.filter((code) => !targeted.has(code));
        expect(uncovered).toEqual([]);
    });
});

describe('SOC 2 criteria — every declaration agrees', () => {
    it("the catalog file's own requirements match the criteria the seed creates", () => {
        // The CatalogFile now declares the criteria itself, so they are stated
        // in THREE places: prisma/seed.ts's soc2Reqs, this fixture, and
        // src/data/libraries/soc2-2017.yaml. Two of the three were already
        // cross-checked below; leaving the third unchecked would let the
        // catalog seeder create a criterion set the seed's link lookup does
        // not know, which is exactly the silent no-link failure this file was
        // written to prevent — one source further out.
        expect(catalog.requirements.map((r) => r.code).sort()).toEqual([...SEEDED].sort());
    });

    it('the seed carries exactly the library\'s assessable Common Criteria', () => {
        const libraryCC = LIBRARY_ASSESSABLE.filter((r) => r.startsWith('CC')).sort();
        expect([...SEEDED].sort()).toEqual(libraryCC);
    });

    it('prisma/seed-catalog.ts seeds the same criteria as prisma/seed.ts', () => {
        expect(seededCriterionCodes('prisma/seed-catalog.ts')).toEqual(SEEDED);
    });
});

describe('SOC 2 Starter Pack — seed wiring', () => {
    const seed = read('prisma/seed.ts');

    it('reads the curated control fixture and packages it as SOC2_STARTER_PACK', () => {
        expect(seed).toContain('soc2-control-templates.json');
        expect(seed).toContain("'SOC2_STARTER_PACK'");
        expect(seed).toMatch(/startsWith:\s*'TSC-'/);
    });
});
