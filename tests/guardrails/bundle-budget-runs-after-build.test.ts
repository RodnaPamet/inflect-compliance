/**
 * The bundle-size budget must be invoked by a job that has actually built.
 *
 * THE INVARIANT. tests/guardrails/bundle-size-budget.test.ts can only
 * measure anything when `.next/app-build-manifest.json` exists, and it only
 * FAILS on a missing manifest when the invoking job sets
 * `BUNDLE_BUDGET_REQUIRE_MANIFEST`. Both halves live in workflow YAML, which
 * means both halves can be deleted by an unrelated CI edit — and the failure
 * mode of deleting them is a green pass, not a red one. That is exactly how
 * the gate spent its first months: it ran on every PR in the `Ratchets` job,
 * where no build exists, took its skip branch, and reported success without
 * ever measuring a route.
 *
 * So this guard asserts the wiring itself:
 *
 *   1. At least one workflow job runs the budget suite AFTER a production
 *      `next build` in the SAME job, with the require-manifest signal set.
 *   2. That job is reachable on a pull_request — no `if:` condition at all,
 *      which is what makes it the PR-time gate rather than a post-merge one.
 *      (A job that gains an `if:` may still be reachable, but it needs a
 *      human to re-check it against ci-check-reachability-before-merge.)
 *   3. The build step comes BEFORE the enforcement step. Order is the whole
 *      point: reversed, the manifest is from a previous run or absent.
 *   4. Nothing runs the suite with the require-manifest signal in a job that
 *      does NOT build — that would be a guaranteed red with no diagnostic
 *      value.
 *
 * WHY THIS IS NOT A PROSE GATE. It parses .github/workflows/*.yml — the file
 * CI actually executes — and asserts a relationship between two steps in it.
 * Delete the enforcement step, drop the env var, move the step above the
 * build, or put an `if:` on the job, and this test goes red. Grepping a
 * markdown file for a filename would prove none of those.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const WF_DIR = path.join(ROOT, '.github/workflows');

const SUITE = 'tests/guardrails/bundle-size-budget.test.ts';
const REQUIRE_ENV = 'BUNDLE_BUDGET_REQUIRE_MANIFEST';
/** Truthy per the suite's own parser — keep the two in step. */
const TRUTHY = /^(1|true|yes|on)$/i;

interface Step {
    name?: string;
    run?: string;
    env?: Record<string, unknown>;
    uses?: string;
}
interface Job {
    if?: unknown;
    steps?: Step[];
    env?: Record<string, unknown>;
}
interface Workflow {
    jobs?: Record<string, Job>;
    env?: Record<string, unknown>;
}

/** A step that compiles the app for production (not the test-mode bundle). */
function isProductionBuildStep(step: Step): boolean {
    const run = step.run ?? '';
    if (!/\bnext build\b/.test(run) && !/\bnpm run (?:build|analyze)(?![\w:-])/.test(run)) return false;
    // NEXT_TEST_MODE routes output to `.next-test/`, so that bundle never
    // produces the manifest this gate reads.
    const env = step.env ?? {};
    return !('NEXT_TEST_MODE' in env);
}

function runsBudgetSuite(step: Step): boolean {
    return (step.run ?? '').includes(SUITE);
}

function envValue(name: string, ...scopes: Array<Record<string, unknown> | undefined>): string | undefined {
    for (const scope of scopes) {
        if (scope && name in scope) return String(scope[name]);
    }
    return undefined;
}

interface Site {
    workflow: string;
    jobId: string;
    job: Job;
    buildIndex: number;
    enforceIndex: number;
    requireValue: string | undefined;
}

function collectSites(): Site[] {
    const sites: Site[] = [];
    for (const file of fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
        const wf = yaml.load(fs.readFileSync(path.join(WF_DIR, file), 'utf8')) as Workflow;
        for (const [jobId, job] of Object.entries(wf?.jobs ?? {})) {
            const steps = job.steps ?? [];
            const enforceIndex = steps.findIndex(runsBudgetSuite);
            if (enforceIndex === -1) continue;
            sites.push({
                workflow: file,
                jobId,
                job,
                buildIndex: steps.findIndex(isProductionBuildStep),
                enforceIndex,
                requireValue: envValue(REQUIRE_ENV, steps[enforceIndex]?.env, job.env, wf.env),
            });
        }
    }
    return sites;
}

describe('bundle budget runs after a build', () => {
    const sites = collectSites();

    // Vacuity guard: a parser that finds nothing would satisfy every
    // `every(...)` below without checking a thing.
    it('finds the workflow jobs that invoke the budget suite', () => {
        expect(sites.map((s) => `${s.workflow}:${s.jobId}`).sort()).toEqual([
            'bundle-analyze.yml:analyze',
            'ci.yml:build',
        ]);
    });

    it('every invocation sits in the same job as a production build, after it', () => {
        const broken = sites
            .filter((s) => s.buildIndex === -1 || s.buildIndex > s.enforceIndex)
            .map((s) =>
                s.buildIndex === -1
                    ? `${s.workflow}:${s.jobId} runs the budget suite but never builds`
                    : `${s.workflow}:${s.jobId} runs the budget suite (step ${s.enforceIndex}) BEFORE its build (step ${s.buildIndex})`,
            );
        expect(broken).toEqual([]);
    });

    it('every invocation sets the require-manifest signal truthy', () => {
        const unset = sites
            .filter((s) => !TRUTHY.test(s.requireValue ?? ''))
            .map((s) => `${s.workflow}:${s.jobId} — ${REQUIRE_ENV}=${s.requireValue ?? '<unset>'}`);
        expect(unset).toEqual([]);
    });

    it('at least one invocation is unconditionally reachable on a pull request', () => {
        const unconditional = sites.filter((s) => s.job.if === undefined);
        expect(unconditional.map((s) => `${s.workflow}:${s.jobId}`)).toContain('ci.yml:build');
    });

    it('no job sets the require-manifest signal without building', () => {
        const offenders: string[] = [];
        for (const file of fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
            const wf = yaml.load(fs.readFileSync(path.join(WF_DIR, file), 'utf8')) as Workflow;
            for (const [jobId, job] of Object.entries(wf?.jobs ?? {})) {
                const steps = job.steps ?? [];
                const builds = steps.some(isProductionBuildStep);
                const declares = steps.some((st) => TRUTHY.test(envValue(REQUIRE_ENV, st.env) ?? ''))
                    || TRUTHY.test(envValue(REQUIRE_ENV, job.env, wf.env) ?? '');
                if (declares && !builds) offenders.push(`${file}:${jobId}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
