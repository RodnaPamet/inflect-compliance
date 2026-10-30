/**
 * EVERY CI JOB DECLARES WHETHER IT IS A REQUIRED CHECK (#4552).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DEFECT, WHICH HAS HAPPENED TWICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A gate gets built, merged, and never added to the required-status-check set.
 * It then runs on every pull request, reports red on a violation, and blocks
 * nothing — which is indistinguishable from working, because the check is
 * PRESENT and its failure is visible. Nobody looks at the ruleset.
 *
 *   • #3196 — `Ratchets` was not required, so a PR with failing architectural
 *     guards could merge. Closed by adding it.
 *   • #4552 — `Change class` (#4439) is built, merged, running, and still not
 *     required, so the SIGNIFICANT-change rule it enforces advises rather than
 *     blocks. The gate exists because #4436 shipped a migration with neither a
 *     rollback plan nor a risk assessment while every check stayed green.
 *
 * Two occurrences of one shape is the argument for catching the shape.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS CAN AND CANNOT CHECK — read this before trusting it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It CANNOT read GitHub's live ruleset. A test has no credential for the
 * rulesets API, and gating CI on one would make every run depend on a token
 * and a network call. So this does NOT verify that the six contexts below are
 * actually required today — only `gh api repos/.../rulesets/<id>` can say that.
 *
 * What it DOES catch is the omission that produced both occurrences: a NEW job
 * appears in `ci.yml` and nobody decides whether it belongs in the required
 * set. Every job must be classified here, by exact set equality in both
 * directions, so the decision happens in the diff that adds the gate rather
 * than months later when somebody reads the ruleset.
 *
 * A stale entry fails too. `merge-queue-trigger-coverage` records what that
 * costs: a map describing a job that no longer exists becomes "the authority
 * on which jobs are deliberately exempt" while naming nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY NOT AN EXISTING GUARD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tests/guardrails/merge-queue-trigger-coverage.test.ts` classifies ci.yml
 * jobs, but for a different question — which ones run in the merge queue — and
 * over a different population. Its `QUEUE_ENFORCED_JOBS` is a hand-maintained
 * list of six that omits `ratchets` and `flue`, both of which do run in the
 * queue; and the test named "the enforced and skipped sets are disjoint and
 * complete over the gate" asserts non-overlap plus two memberships, not
 * completeness. Neither of those is a bug in that guard — its subject is the
 * queue's trigger invariant — but neither closes this gap, and `Change class`
 * appears nowhere in it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const CI_YML = path.resolve(__dirname, '../../.github/workflows/ci.yml');
const CI = fs.readFileSync(CI_YML, 'utf-8');

/**
 * The job ids and display names declared in `ci.yml`, derived from the file.
 *
 * A job's CHECK CONTEXT is its `name:` when it has one, else its id. For a
 * matrix job the context is the expanded name, so `test` reports as
 * `Test (shard 1/7)` and friends — which is why the required `Test` is the
 * `test-summary` rollup and not the shard job.
 */
function declaredJobs(): { id: string; context: string }[] {
    const body = CI.slice(CI.indexOf('\njobs:'));
    const out: { id: string; context: string }[] = [];
    for (const line of body.split('\n')) {
        const id = /^ {2}([a-z0-9][\w-]*):\s*$/.exec(line);
        if (id) {
            out.push({ id: id[1], context: id[1] });
            continue;
        }
        const name = /^ {4}name:\s*(.+?)\s*$/.exec(line);
        if (name && out.length > 0 && out[out.length - 1].context === out[out.length - 1].id) {
            out[out.length - 1].context = name[1].replace(/^["']|["']$/g, '');
        }
    }
    return out;
}

/** The six contexts the `main` ruleset requires, as GitHub spells them. */
const REQUIRED_CONTEXTS = ['Lint', 'Typecheck', 'Test', 'Build', 'Security', 'Ratchets'] as const;

/**
 * Every `ci.yml` job, and whether it is a required status check.
 *
 * A new job fails this suite until it is added here. `required: false` is a
 * perfectly good answer — it just has to be an answer, with the reason that
 * makes it one.
 */
const CHECK_REQUIREDNESS: Readonly<Record<string, { required: boolean; why: string }>> = {
    // ── required ──────────────────────────────────────────────────────────
    lint: { required: true, why: 'Context "Lint".' },
    typecheck: { required: true, why: 'Context "Typecheck".' },
    ratchets: { required: true, why: 'Context "Ratchets" — added by #3196, the first occurrence of this defect.' },
    build: { required: true, why: 'Context "Build".' },
    security: { required: true, why: 'Context "Security".' },
    'test-summary': {
        required: true,
        why: 'Context "Test" — the ROLLUP. It is the required one precisely because it cannot '
            + 'report until every `Test (shard N/7)` leg has finished, so requiring it requires them all.',
    },

    // ── not required, each for a stated reason ────────────────────────────
    'change-class': {
        required: false,
        why: '#4552 — THE OPEN GAP, and the reason this guard exists. Built to BLOCK (owner '
            + 'decision 2026-10-29) and not yet in the ruleset, so it advises. When the toggle is '
            + 'flipped this entry becomes `required: true` and the assertion below starts holding '
            + 'it to the context list.',
    },
    test: {
        required: false,
        why: 'The sharded legs. Their context carries the matrix index (`Test (shard 1/7)`), which '
            + 'is not a stable name to require; `test-summary` is required on their behalf.',
    },
    changes: {
        required: false,
        why: 'A path-filter fan-out that computes `needs` outputs for other jobs. It gates work '
            + 'rather than judging it, and has no verdict to require.',
    },
    flue: {
        required: false,
        why: 'Runs the ESM-only `flue` jest project. Its population is disjoint from Test and '
            + 'Ratchets, so it is real coverage — a candidate for the required set, not a '
            + 'deliberate exclusion. Recorded here as the decision nobody has made.',
    },
    'coverage-gate': {
        required: false,
        why: 'Merges nine shard artefacts and enforces the floors. Depends on every Jest job '
            + 'finishing, so requiring it would serialise the gate behind the slowest shard.',
    },
    e2e: {
        required: false,
        why: 'Longest job in the pipeline and a different failure class; deliberately skipped in '
            + 'the merge queue (see merge-queue-trigger-coverage). Requiring a context the queue '
            + 'skips stalls every merge.',
    },
    'e2e-bundle': {
        required: false,
        why: 'Builds the Next bundle that `e2e` then drives. It produces an artefact rather than a '
            + 'verdict about the diff, and a failure here surfaces as the E2E job having nothing to '
            + 'run — so the thing worth requiring would be E2E, which is itself queue-skipped.',
    },
    'load-smoke': {
        required: false,
        why: 'A k6 smoke run against a locally booted app. Advisory by design: its thresholds '
            + 'measure a throwaway runner\'s CPU as much as the code, so a red here is not evidence '
            + 'the diff is slower. Requiring it would gate merges on runner weather.',
    },
    codeql: {
        required: false,
        why: 'Deliberately queue-skipped: SAST finds taint patterns, not merge collisions, and its '
            + 'analyze step would file SARIF against the throwaway queue ref. The required '
            + '`Security` job gates on the PR\'s own CodeQL result instead (#4047).',
    },
    docker: {
        required: false,
        why: 'Container build, deliberately queue-skipped as the most expensive pair in the pipeline '
            + '(~40 min with Trivy). A merge collision cannot produce a container finding — the image '
            + 'CVE surface is a property of the base image and dependency tree, not of two diffs '
            + 'meeting. Runs unconditionally on the push to main.',
    },
    trivy: {
        required: false,
        why: 'Image CVE scan, downstream of `docker` and so inheriting its exclusion. Worth knowing '
            + 'that a failed or cancelled `docker` makes this SKIP rather than fail, so requiring it '
            + 'would be requiring a context that can go absent — and an absent check scores as zero '
            + 'failures in every aggregate that reads a check set.',
    },
    'scanner-image': {
        required: false,
        why: 'Builds the reference agent-harness scanner container from `packages/`. It ships to a '
            + 'client estate rather than into this app, so its verdict says nothing about whether '
            + 'this diff is safe to merge into main.',
    },
};

describe('every ci.yml job declares whether it is a required check', () => {
    it('the deriver actually reads the file — a detector that finds nothing proves nothing', () => {
        const jobs = declaredJobs();
        // Guards the shape of the derivation itself: a regex that stopped
        // matching would make every assertion below vacuously true.
        expect(jobs.length).toBeGreaterThan(10);
        expect(jobs.map((j) => j.id)).toContain('lint');
        expect(jobs.find((j) => j.id === 'test-summary')?.context).toBe('Test');
        // And it must read the `name:` rather than fall back to the id.
        expect(jobs.find((j) => j.id === 'change-class')?.context).toBe('Change class');
        expect(jobs.find((j) => j.id === 'coverage-gate')?.context).toBe('Coverage (≥60%)');
    });

    it('classifies exactly the jobs ci.yml declares — no new job, no stale entry', () => {
        const ids = declaredJobs().map((j) => j.id).sort();
        // Exact equality in BOTH directions. A new gate fails until somebody
        // decides; an entry for a deleted job fails so the map cannot rot into
        // describing a pipeline that no longer exists.
        expect(ids).toEqual(Object.keys(CHECK_REQUIREDNESS).sort());
    });

    it('the jobs marked required are exactly the contexts the ruleset names', () => {
        const jobs = declaredJobs();
        const requiredContexts = jobs
            .filter((j) => CHECK_REQUIREDNESS[j.id]?.required)
            .map((j) => j.context)
            .sort();
        expect(requiredContexts).toEqual([...REQUIRED_CONTEXTS].sort());
    });

    it('every not-required job says WHY, in more than a word', () => {
        const thin = Object.entries(CHECK_REQUIREDNESS)
            .filter(([, v]) => !v.required && v.why.trim().length < 40)
            .map(([k]) => k);
        // A reason is the whole value of this map: "false" alone records that
        // somebody typed false, not that anybody decided.
        expect(thin).toEqual([]);
    });

    it('names the open gap rather than normalising it', () => {
        // When #4552's toggle lands, this flips to required and the context
        // assertion above will demand "Change class" join REQUIRED_CONTEXTS —
        // so the guard cannot be left half-updated.
        const gate = CHECK_REQUIREDNESS['change-class'];
        expect(gate.required).toBe(false);
        expect(gate.why).toMatch(/#4552/);
    });
});
