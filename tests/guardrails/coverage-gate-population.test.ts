/**
 * The coverage gate measures the WHOLE test suite, and its expected-artifact
 * count matches what CI actually produces.
 *
 * THE INVARIANT, AND WHY IT IS NOT OBVIOUS. `jest.thresholds.json` has five
 * keys, and a path key REMOVES its files from `global` — so `global` is a
 * residue ("everything the four path keys did not claim"), not a universe.
 * That makes the gate's verdict a function of WHICH TESTS RAN, not only of
 * the floors. Change the population and every floor silently means something
 * different, with no number in the diff to review.
 *
 * Until 2026-08-25 the population was trivially safe: one `Coverage (shard
 * N/4)` matrix ran `jest --shard` over the unfiltered suite. That job was a
 * second, instrumented execution of work the `Test` shards had already done
 * — ~45 job-minutes — and being `push`/`schedule`-only it could only ever
 * report a regression after the commit was on main.
 *
 * Folding it away means the population is now assembled from TWO jobs that
 * exist for other reasons:
 *
 *     Test (shard 1-4)  runs with JEST_SKIP_RATCHETS=1  -> 1386 files
 *     Ratchets          runs exactly what that flag drops ->  654 files
 *                                                          ---- 2040
 *
 * Both halves must stay instrumented and both must upload, or the merged
 * total quietly shrinks. The runtime script catches only ONE of the ways
 * that breaks: `check-merged-coverage.ts` refuses when the artifact COUNT is
 * wrong. It cannot notice a job that stopped emitting coverage at the same
 * time as somebody edited the expected count to match — which is exactly
 * what a well-meaning "the ratchets job doesn't need coverage" cleanup looks
 * like. That is the hole this guard closes, and it is why the assertions
 * below are cross-file rather than a single count check.
 *
 * The measured stake, so nobody reads the Ratchets half as decoration:
 * on 2026-08-25 those 654 files alone executed 4125 in-scope statements
 * across 326 files, including 14.58% of `./src/lib/`.
 *
 * WHAT THIS GUARD DOES NOT CLAIM. It does not verify that the two jest
 * invocations really partition the suite by re-running `jest --listTests` —
 * that costs three extra Jest boots. It verifies the MECHANISM instead: the
 * only thing that removes files from the shards is the `JEST_SKIP_RATCHETS`
 * branch in `jest.config.js`, so every path that branch excludes must appear
 * as a positional argument to the Ratchets job. Add `tests/foo/` to the skip
 * list without adding it to that job and the files stop running at all —
 * this fails, loudly, in the same diff.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const CI_YML = path.join(ROOT, '.github/workflows/ci.yml');
const JEST_CONFIG = path.join(ROOT, 'jest.config.js');

interface Step {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
}
interface Job {
    if?: string;
    needs?: string | string[];
    steps?: Step[];
    strategy?: { matrix?: Record<string, unknown> };
}

const workflow = yaml.load(fs.readFileSync(CI_YML, 'utf8')) as { jobs: Record<string, Job> };
const jobs = workflow.jobs;

/** Collapse a multi-line `run:` (with `\` continuations) to one line. */
const flatten = (run: string): string => run.replace(/\\\s*\n/g, ' ').replace(/\s+/g, ' ').trim();

/** Every job that boots Jest over some slice of the suite. */
interface Producer {
    id: string;
    command: string;
    /** How many artifacts this job uploads (matrix fan-out counts). */
    artifacts: number;
    artifactName: string | null;
    artifactPath: string | null;
    /** Whether the Jest step narrows the suite via JEST_SKIP_RATCHETS. */
    setsSkipFlag: boolean;
}

const producers: Producer[] = [];
for (const [id, job] of Object.entries(jobs)) {
    const jestStep = (job.steps ?? []).find(
        (s) => typeof s.run === 'string' && /\bnpx jest\b/.test(s.run) && !s.run.includes('--listTests'),
    );
    if (!jestStep?.run) continue;

    const upload = (job.steps ?? []).find(
        (s) =>
            typeof s.uses === 'string' &&
            s.uses.startsWith('actions/upload-artifact') &&
            typeof s.with?.name === 'string' &&
            (s.with.name as string).startsWith('coverage-shard-'),
    );
    const artifactName = (upload?.with?.name as string | undefined) ?? null;
    // A matrix job uploads one artifact per matrix leg, but only if the name
    // varies with the leg — a constant name would have the legs overwrite
    // each other and the count would be a lie.
    const shardLegs = Array.isArray(job.strategy?.matrix?.shard)
        ? (job.strategy!.matrix!.shard as unknown[]).length
        : 1;
    const perLeg = artifactName !== null && artifactName.includes('matrix.shard');
    producers.push({
        id,
        command: flatten(jestStep.run),
        artifacts: artifactName === null ? 0 : perLeg ? shardLegs : 1,
        artifactName,
        artifactPath: (upload?.with?.path as string | undefined) ?? null,
        setsSkipFlag: JSON.stringify(
            (jestStep as unknown as { env?: Record<string, unknown> }).env ?? {},
        ).includes('JEST_SKIP_RATCHETS'),
    });
}

/** The gate job: the one running check-merged-coverage.ts. */
const gateEntry = Object.entries(jobs).find(([, job]) =>
    (job.steps ?? []).some(
        (s) => typeof s.run === 'string' && s.run.includes('scripts/check-merged-coverage.ts'),
    ),
);

describe('the coverage gate measures the whole suite', () => {
    it('the census is plausibly sized (guards against a vacuous pass)', () => {
        // Every assertion below iterates `producers`. A parse that yields an
        // empty list would pass all of them while checking nothing.
        expect(producers.length).toBeGreaterThanOrEqual(2);
        expect(gateEntry).toBeDefined();
    });

    it('every job that runs Jest collects coverage', () => {
        const uninstrumented = producers
            .filter((p) => !/--coverage\b/.test(p.command) || /--no-coverage\b/.test(p.command))
            .map((p) => p.id);
        // A Jest job that skips instrumentation removes its files from the
        // merged total without removing them from the suite — the floors then
        // gate a smaller population at the same numbers.
        expect(uninstrumented).toEqual([]);
    });

    it('every job that runs Jest uploads its coverage to the gate', () => {
        const notUploading = producers
            .filter((p) => p.artifactName === null || p.artifactPath !== 'coverage/coverage-final.json')
            .map((p) => `${p.id} (name=${p.artifactName}, path=${p.artifactPath})`);
        expect(notUploading).toEqual([]);
    });

    it('the gate expects exactly as many artifacts as CI produces', () => {
        const expectedTotal = producers.reduce((n, p) => n + p.artifacts, 0);
        expect(expectedTotal).toBeGreaterThanOrEqual(5);

        const [, gateJob] = gateEntry!;
        const step = (gateJob.steps ?? []).find((s) =>
            s.run?.includes('scripts/check-merged-coverage.ts'),
        )!;
        const declared = flatten(step.run!).trim().split(/\s+/).at(-1);
        expect(Number(declared)).toBe(expectedTotal);
    });

    it('the gate waits for every producing job', () => {
        const [, gateJob] = gateEntry!;
        const needs = Array.isArray(gateJob.needs) ? gateJob.needs : [gateJob.needs].filter(Boolean);
        const missing = producers.map((p) => p.id).filter((id) => !needs.includes(id));
        expect(missing).toEqual([]);
    });

    it('the gate is reachable on a pull request', () => {
        // The whole point of the fold: a coverage regression must be visible
        // BEFORE merge, not on the first main push after it.
        const [, gateJob] = gateEntry!;
        expect(gateJob.if ?? '').not.toMatch(/github\.event_name/);
    });

    it('every path the shards skip is run by another instrumented job', () => {
        // `JEST_SKIP_RATCHETS=1` is the ONLY thing that narrows the shards.
        // Whatever it drops has to be picked up, or those files run nowhere.
        const config = fs.readFileSync(JEST_CONFIG, 'utf8');
        const branch = /JEST_SKIP_RATCHETS === '1'\s*\?\s*\[([\s\S]*?)\]\s*:\s*\[\]/.exec(config);
        expect(branch).not.toBeNull();

        const skipped = [...branch![1].matchAll(/<rootDir>\/(tests\/[A-Za-z0-9_-]+)\//g)].map(
            (m) => m[1],
        );
        // Vacuity: the branch really does list paths.
        expect(skipped.length).toBeGreaterThanOrEqual(3);

        // The flag is set via the step's `env:`, not inline in the command,
        // so the complement is "every Jest job that does NOT set it".
        const claimants = producers.filter((p) => !p.setsSkipFlag).map((p) => p.command);
        // Vacuity again: if nothing is left after the filter, `unclaimed`
        // below would be the full skip list and the test would fail loudly
        // rather than pass — but assert it anyway so the reason is legible.
        expect(claimants.length).toBeGreaterThanOrEqual(1);

        const haystack = claimants.join(' ');
        const unclaimed = [...new Set(skipped)].filter((dir) => !haystack.includes(dir));
        expect(unclaimed).toEqual([]);
    });
});

/**
 * The population can also be narrowed WITHOUT touching JEST_SKIP_RATCHETS.
 *
 * An adversarial review of this branch found the hole by mutation: adding
 * `'tests/guardrails/.*'` to the Ratchets job's `--testPathIgnorePatterns`
 * removes ~530 test files from CI *and* from the merged coverage total — and
 * every guard in this file still passed, including this one's own suite, which
 * the pattern had just excluded from running at all.
 *
 * So the ignore list is pinned by exact equality rather than by inspection. A
 * new pattern fails here until somebody writes down why it is not a silent
 * coverage cut. That is the same reasoning as the JEST_SKIP_RATCHETS check
 * above: the population of the merged total is the thing being protected, and
 * there is more than one lever on it.
 */
const IGNORE_PATTERN_ALLOWLIST: Record<string, Record<string, string>> = {
    ratchets: {
        '/node_modules/': 'Jest default; excludes dependencies, not repo tests.',
        'rls-coverage\\.test\\.ts':
            'DB-backed RLS guard — needs a live Postgres with policies applied, ' +
            'which the Ratchets job has no service container for. It runs in the ' +
            'Test shards instead, so its files are still in the merged population.',
    },
};

describe('the merged population is not narrowed by an ignore pattern', () => {
    it('every producer\'s --testPathIgnorePatterns is exactly the allowlisted set', () => {
        for (const p of producers) {
            const m = /--testPathIgnorePatterns\s+((?:'[^']*'\s*)+)/.exec(p.command);
            const found = m
                ? Array.from(m[1].matchAll(/'([^']*)'/g)).map((x) => x[1] as string).sort()
                : [];
            const allowed = Object.keys(IGNORE_PATTERN_ALLOWLIST[p.id] ?? {}).sort();
            expect({ job: p.id, patterns: found }).toEqual({ job: p.id, patterns: allowed });
        }
    });

    it('the allowlist has a written reason per pattern and no stale entries', () => {
        const producerIds = new Set(producers.map((p) => p.id));
        for (const [jobId, patterns] of Object.entries(IGNORE_PATTERN_ALLOWLIST)) {
            expect(producerIds.has(jobId)).toBe(true);
            for (const [pattern, reason] of Object.entries(patterns)) {
                expect(typeof pattern).toBe('string');
                expect(reason.length).toBeGreaterThan(30);
            }
        }
    });
});
