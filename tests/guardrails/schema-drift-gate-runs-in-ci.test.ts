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
 *  5. The residue file contains the signed-off statements and NOTHING
 *     ELSE — a floor AND a ceiling. See the two residue tests below.
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

/**
 * The residue file's SQL statements, comments and blank lines removed.
 *
 * Everything below is asserted on this parsed set, never with a
 * whole-file `toContain`. A `toContain('emailHash')` over this file
 * would be satisfied by the header paragraph that EXPLAINS emailHash —
 * so deleting the statement while keeping the prose would pass. That is
 * `assertion-needle-uniqueness` Class D, and it caught this file's
 * first draft at +2 over the ceiling.
 */
const residueStatements = (): string[] =>
    read(RESIDUE)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('--'));

/**
 * The three statement shapes that have been argued for in the residue
 * file's header prose, with the exact number of each.
 *
 * Groups 1 and 2 are PERMANENT — neither can be expressed in Prisma at
 * any cost. Group 3 is OPEN and is expected to shrink to zero when the
 * ControlException referential action is settled; when it does, delete
 * its entry here in the same commit that deletes the lines.
 */
const SIGNED_OFF: Array<{ name: string; count: number; re: RegExp }> = [
    {
        name: 'group 1 — GAP-21 hash columns, NOT NULL in DB / optional in schema',
        count: 3,
        re: /^ALTER TABLE "(?:User|AuditorAccount|UserIdentityLink)" ALTER COLUMN "(?:emailHash|emailAtLinkTimeHash)" DROP NOT NULL;$/,
    },
    {
        name: 'group 2 — pg_trgm GIN indexes Prisma cannot declare',
        count: 3,
        re: /^DROP INDEX "Control_(?:code|name|objective)_trgm_idx";$/,
    },
    {
        name: 'group 3 — ControlException composite SET NULL FKs (OPEN)',
        count: 4,
        re: /^ALTER TABLE "ControlException" (?:DROP CONSTRAINT "ControlException_(?:compensatingControlId|renewedFromId)_tenantId_fkey";|ADD CONSTRAINT "ControlException_(?:compensatingControlId|renewedFromId)_tenantId_fkey" FOREIGN KEY .+;)$/,
    },
];

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
        // FLOOR. An emptied residue file would make the gate demand ZERO
        // drift and pass only on a tree that has none — plausible, and
        // exactly wrong: the 6 permanent statements (3 GAP-21
        // DROP NOT NULL + 3 pg_trgm GIN) can never be expressed in
        // Prisma, so an empty file means someone deleted the
        // documentation of why they are permanent.
        //
        // Asserted per shape with an exact count, so losing ONE statement
        // from a group fails even though the group still has members.
        const statements = residueStatements();
        const counted = Object.fromEntries(
            SIGNED_OFF.map(({ name, re }) => [
                name,
                statements.filter((l) => re.test(l)).length,
            ]),
        );
        expect(counted).toEqual(
            Object.fromEntries(SIGNED_OFF.map(({ name, count }) => [name, count])),
        );
    });

    it('the residue holds NOTHING but the signed-off shapes', () => {
        // CEILING, and the direction the first version of this file left
        // open. `check-fresh-db-schema-drift.mjs` fails on any difference
        // between the diff and this file — so the cheapest way to make
        // real new drift go green is to paste the offending statement
        // INTO the residue. The script's own error message warns against
        // exactly that; nothing enforced it, and the old floor assertion
        // (`toBeGreaterThanOrEqual(6)`) structurally could not: a file
        // only ever grows past a floor.
        //
        // A fourth shape is not a residue, it is undiagnosed drift
        // wearing the residue's clothes. The fix is to reconcile it —
        // correct `prisma/schema`, or write the migration — not to widen
        // this allowlist. Widening is still possible, but it has to edit
        // THIS file and argue for the new group in the header prose.
        const unclassified = residueStatements().filter(
            (l) => !SIGNED_OFF.some(({ re }) => re.test(l)),
        );
        expect(unclassified).toEqual([]);
    });
});
