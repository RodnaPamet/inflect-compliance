/**
 * The fresh-DB schema-drift gate must actually RUN IN CI, blocking.
 *
 * ─── Why this file exists ───────────────────────────────────────────
 *
 * `scripts/check-fresh-db-schema-drift.mjs` + the committed residue
 * `prisma/fresh-db-schema-drift.expected.sql` are the enforcement half
 * of #2367: a database built only from `prisma/migrations` must
 * reproduce `prisma/schema`, modulo a documented residue.
 *
 * That enforcement lives in a single `ci.yml` step. Which means it can
 * be **deleted by an unrelated CI edit, and the failure mode of
 * deleting it is a green pass, not a red one** — exactly the hazard
 * `tests/guardrails/bundle-budget-runs-after-build.test.ts` was
 * written for, in its own words.
 *
 * It was found the hard way: an adversarial review of #2367 PR1
 * deleted the `Gate: fresh-DB schema drift` step from `ci.yml` and ran
 * every ci.yml-reading guard in the repo — 12 suites, 148 tests, all
 * GREEN. The residue file silently stopped being enforced and nothing
 * anywhere noticed. A guard whose own presence is unguarded is
 * decoration one level up.
 *
 * ─── What is asserted, and why each clause earns its place ──────────
 *
 *  1. The step EXISTS, pinned by exact `workflow:job` equality rather
 *     than a `>=` count or a `.some()`. A `.some()` over zero steps is
 *     false, but a filtered set that empties for an unrelated reason
 *     (job renamed, workflow split) would make a count-based
 *     assertion pass with nothing left to check.
 *  2. It runs AFTER the migrations are applied. Before them, the
 *     database is empty, the diff is enormous, and the gate would
 *     either fail permanently or — worse — be "fixed" by widening the
 *     residue file until it passed.
 *  3. It is UNCONDITIONAL: no `if:`, and no `continue-on-error`. Both
 *     turn a gate into a notification while leaving it visible in the
 *     YAML, which is the most expensive failure of the three because
 *     it survives a reviewer reading the file.
 *  4. Its subjects exist: the script, the residue file, and the
 *     `db:check-schema-drift` npm script the step invokes. A step
 *     whose command 404s is a red CI, not a silent hole — but a
 *     RENAMED script with the step left pointing at the old name is
 *     caught here rather than at 3am.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SCRIPT = 'scripts/check-fresh-db-schema-drift.mjs';
const RESIDUE = 'prisma/fresh-db-schema-drift.expected.sql';
const NPM_SCRIPT = 'db:check-schema-drift';

type Step = {
    name?: string;
    run?: string;
    if?: unknown;
    'continue-on-error'?: unknown;
};
type Job = { steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

const runsTheGate = (s: Step) => String(s.run ?? '').includes(NPM_SCRIPT);
const appliesMigrations = (s: Step) =>
    /prisma\s+migrate\s+deploy|db:(migrate|deploy)\b/.test(String(s.run ?? ''));

/** Every (workflow, job) site that runs the gate, with its ordering facts. */
const sites: Array<{
    site: string;
    gateIndex: number;
    migrateIndex: number;
    guarded: boolean;
    tolerated: boolean;
}> = [];

for (const file of fs.readdirSync(path.join(ROOT, '.github/workflows'))) {
    if (!/\.ya?ml$/.test(file)) continue;
    const wf = yaml.load(read(`.github/workflows/${file}`)) as Workflow;
    for (const [jobId, job] of Object.entries(wf?.jobs ?? {})) {
        const steps = job.steps ?? [];
        const gateIndex = steps.findIndex(runsTheGate);
        if (gateIndex === -1) continue;
        const step = steps[gateIndex];
        sites.push({
            site: `${file}:${jobId}`,
            gateIndex,
            migrateIndex: steps.findIndex(appliesMigrations),
            guarded: step.if !== undefined,
            tolerated: step['continue-on-error'] !== undefined,
        });
    }
}

describe('fresh-DB schema-drift gate — actually runs in CI', () => {
    it('runs at exactly the expected site (an empty selection is not a pass)', () => {
        // Exact equality, not a count. Read this off the failure
        // message if the pipeline is restructured — never compute it.
        expect(sites.map((s) => s.site).sort()).toEqual(['ci.yml:test']);
    });

    it('runs AFTER the migrations that build the database', () => {
        const wrong = sites.filter(
            (s) => s.migrateIndex === -1 || s.gateIndex < s.migrateIndex,
        );
        expect(wrong.map((s) => s.site)).toEqual([]);
    });

    it('is unconditional — no `if:` and no `continue-on-error`', () => {
        expect(sites.filter((s) => s.guarded).map((s) => s.site)).toEqual([]);
        expect(sites.filter((s) => s.tolerated).map((s) => s.site)).toEqual([]);
    });

    it('its subjects exist: script, residue file, npm script', () => {
        expect(fs.existsSync(path.join(ROOT, SCRIPT))).toBe(true);
        expect(fs.existsSync(path.join(ROOT, RESIDUE))).toBe(true);
        const pkg = JSON.parse(read('package.json')) as {
            scripts?: Record<string, string>;
        };
        expect(pkg.scripts?.[NPM_SCRIPT]).toContain(
            'check-fresh-db-schema-drift',
        );
    });

    it('the residue file is a real residue, not an empty rubber stamp', () => {
        // An emptied residue file would make the gate demand ZERO
        // drift and pass only on a tree that has none — plausible, and
        // exactly wrong: the 6 permanent statements (3 GAP-21
        // DROP NOT NULL + 3 pg_trgm GIN) can never be expressed in
        // Prisma, so an empty file means someone deleted the
        // documentation of why they are permanent.
        //
        // Asserted on the PARSED STATEMENT SET, never with a
        // whole-file `toContain`. A `toContain('emailHash')` over this
        // file would be satisfied by the header comment that explains
        // emailHash — so deleting the statement while keeping the
        // paragraph would pass. That is `assertion-needle-uniqueness`
        // Class D, and it caught this test's first draft at +2 over
        // the ceiling. Comments are filtered out before matching and
        // each shape is pinned to a full statement and an exact count.
        const statements = read(RESIDUE)
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('--'));

        const gap21 = statements.filter((l) =>
            /^ALTER TABLE "(?:User|AuditorAccount|UserIdentityLink)" ALTER COLUMN "(?:emailHash|emailAtLinkTimeHash)" DROP NOT NULL;$/.test(
                l,
            ),
        );
        const trgm = statements.filter((l) =>
            /^DROP INDEX "Control_(?:code|name|objective)_trgm_idx";$/.test(l),
        );

        expect(gap21).toHaveLength(3);
        expect(trgm).toHaveLength(3);
        expect(statements.length).toBeGreaterThanOrEqual(6);
    });
});
