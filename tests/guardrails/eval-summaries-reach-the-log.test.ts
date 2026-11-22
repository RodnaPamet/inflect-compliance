/**
 * AN EVALUATION'S SUMMARY REACHES THE JOB LOG (owner decision 2026-11-13).
 *
 * The owner's assistant tooling reads job LOGS through the GitHub API; it
 * cannot read a job's step summary or download an artifact. So every line an
 * evaluation or benchmark workflow writes to `$GITHUB_STEP_SUMMARY` is written
 * through `tee -a`, which puts the same text on stdout, never with a bare
 * `>>`, which hides it from the log.
 *
 *   1. In each workflow below, every run line naming `$GITHUB_STEP_SUMMARY`
 *      tees it. A workflow that publishes a summary still does (zero writes
 *      would make the rule vacuous).
 *   2. A tee does not swallow a failure: the retriever summarize step runs
 *      under `set -euo pipefail`, so a failing summarize still fails it.
 *   3. The retriever benchmark also prints retriever-summary.json's figures to
 *      the log, after the summary is written.
 *
 * skills-evaluate.yml writes no step summary; its script prints each skill's
 * verdict to the log itself, and the rule holds it if it ever gains one.
 * (load-test.yml is not an evaluation; k6's handleSummary already prints its
 * text summary to stdout.)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');

type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

/** workflow file → whether it publishes a step summary at all. */
const EVAL_WORKFLOWS: Readonly<Record<string, boolean>> = {
    'retriever-benchmark.yml': true,
    'agent-evals.yml': true,
    'garak.yml': true,
    'skills-evaluate.yml': false,
};

const TEE = 'tee -a "$GITHUB_STEP_SUMMARY"';

function stepsOf(file: string): Step[] {
    const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8')) as Workflow;
    return Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
}

function summaryLines(steps: Step[]): string[] {
    return steps.flatMap((s) => (s.run ?? '').split('\n')).filter((l) => l.includes('GITHUB_STEP_SUMMARY'));
}

describe('1. every step-summary write in an evaluation workflow also reaches the log', () => {
    it.each(Object.entries(EVAL_WORKFLOWS))('%s', (file, publishes) => {
        const lines = summaryLines(stepsOf(file));
        expect(lines.filter((l) => !l.includes(TEE))).toEqual([]);
        expect(lines.length > 0).toBe(publishes);
    });

    it('the detector refuses a bare append (proved on a planted line)', () => {
        const planted = summaryLines([{ run: 'cat x.md >> "$GITHUB_STEP_SUMMARY"\necho ok | tee -a "$GITHUB_STEP_SUMMARY"' }]);
        expect(planted.filter((l) => !l.includes(TEE))).toEqual(['cat x.md >> "$GITHUB_STEP_SUMMARY"']);
    });
});

describe('the retriever benchmark', () => {
    const steps = stepsOf('retriever-benchmark.yml');
    const summarizeIdx = steps.findIndex((s) => (s.run ?? '').includes('run.ts summarize'));
    const logIdx = steps.findIndex((s) => (s.run ?? '').includes('run.ts log-view'));

    it('2. tees the summarize output under pipefail, so a failing summarize fails the step', () => {
        const run = steps[summarizeIdx]?.run ?? '';
        expect(run.trimStart().startsWith('set -euo pipefail\n')).toBe(true);
        expect(run).toMatch(/--out retriever-summary\.json \| tee -a "\$GITHUB_STEP_SUMMARY"$/m);
    });

    it('3. prints the summary file\'s figures to the log after the summary is written', () => {
        expect(summarizeIdx).toBeGreaterThanOrEqual(0);
        expect(logIdx).toBeGreaterThan(summarizeIdx);
        expect(steps[logIdx].run).toMatch(/--summary retriever-summary\.json \\\n\s+--records retriever-records\s*$/);
    });
});
