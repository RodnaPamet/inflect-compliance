/**
 * Every questionnaire fixture has a PRODUCTION delivery path.
 *
 * ═══ THE DEFECT THIS EXISTS FOR (#2622) ═══
 *
 * The AISVS AI-vendor questionnaire — ten sections, 33 questions, its own
 * coverage readout, finding linkage and ratchet — was built inline in
 * `prisma/seed.ts`, which production never runs. The script `entrypoint.sh`
 * actually invokes, `scripts/seed-vendor-questionnaires.ts`, carried only the
 * two Supplier questionnaires. So a fully-built artefact materialised into the
 * dev demo tenant and nowhere else, and every test passed, because every test
 * seeded the dev path.
 *
 * `catalogue-reaches-production.test.ts` asks this question for FRAMEWORK
 * catalogues and is keyed to `scripts/seed-framework-catalogs.ts`;
 * questionnaires go through a different seeder and were outside its scan
 * entirely. This is the same question for the other seeder.
 *
 * ═══ WHY A SOURCE SCAN AND NOT A DATABASE CHECK ═══
 *
 * A guardrail cannot reach a database — that belongs in tests/integration. This
 * answers the cheaper and different question: is the fixture WIRED to the
 * script production runs? A fixture nobody references cannot be caught by a
 * delivery test that never loads it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { REPO_ROOT } from '../helpers/repo-files';

const FIXTURE_DIR = path.join(REPO_ROOT, 'prisma/fixtures');
/** The seeder `entrypoint.sh` runs. `prisma/seed.ts` is NOT a delivery path. */
const PROD_SEEDER = path.join(REPO_ROOT, 'scripts/seed-vendor-questionnaires.ts');

describe('questionnaire fixtures reach production', () => {
    const fixtures = fs
        .readdirSync(FIXTURE_DIR)
        .filter((f) => /questionnaire/i.test(f) && f.endsWith('.json'));
    const seeder = fs.readFileSync(PROD_SEEDER, 'utf8');

    it('finds the questionnaire fixtures and the production seeder', () => {
        // Positive control: an empty fixture list would make the assertion
        // below pass while checking nothing at all.
        expect(fixtures.length).toBeGreaterThanOrEqual(3);
        expect(seeder.length).toBeGreaterThan(500);
    });

    it('every questionnaire fixture is referenced by the seeder production runs', () => {
        const unwired = fixtures.filter((f) => !seeder.includes(f.replace(/\.json$/, '')));
        expect(unwired).toEqual([]);
    });

    it('the AISVS questionnaire is seeded through the shared builder, not a second copy', () => {
        // The eighty-odd lines that build it live in
        // prisma/aisvs-vendor-questionnaire.ts and are called from both seeders.
        // Re-inlining them here would recreate the state
        // prisma/generic-template-tasks.ts exists to warn about: the same logic
        // in two places, fixed in one, still wrong from the other.
        //
        // Asserted via `.includes(...)` rather than `expect(file).toContain(...)`:
        // a whole-file read as an expect SUBJECT lands in Class D's un-analysable
        // bucket and pushes UNANALYSABLE_READ_BASELINE, which has zero headroom.
        // Naming the subject as a call expression keeps it readable to
        // tests/helpers/assertion-reach.ts.
        const devSeed = fs.readFileSync(path.join(REPO_ROOT, 'prisma/seed.ts'), 'utf8');
        const callers = [
            ['scripts/seed-vendor-questionnaires.ts', seeder.includes('seedAisvsVendorQuestionnaire')],
            ['prisma/seed.ts', devSeed.includes('seedAisvsVendorQuestionnaire')],
        ].filter(([, wired]) => !wired);
        expect(callers).toEqual([]);
    });
});
