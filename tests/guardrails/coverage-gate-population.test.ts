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
 *     Test (shard 1-7)  --selectProjects node jsdom   -> 2343 files
 *     Ratchets          --selectProjects scan          ->  810 files
 *                                                         ---- 3153
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
 * that costs three extra Jest boots. It verifies the MECHANISM instead, and
 * #4395 MOVED that mechanism, so what follows is the current one.
 *
 * Until #4395 the shards shed their ratchet files via `JEST_SKIP_RATCHETS=1`,
 * and the Ratchets job ran the same config with the flag unset plus explicit
 * positional paths. The lever was the flag, so this guard read the flag's
 * branch and required every path it dropped to appear as an argument to that
 * job. Both halves of that are now gone: the exclusion is unconditional in the
 * `node` project, and the Ratchets job selects a `scan` project whose
 * `testMatch` names the three directories.
 *
 * So the lever is now a COMPLEMENT between two parts of `jest.config.js`, and
 * that is what is checked: every `tests/<dir>` the shard projects exclude must
 * be claimed by another project's `testMatch` or carry a written reason, and
 * the project doing the claiming must actually be named by an instrumented
 * job. Drop `tests/foo/` into node's ignore list without giving it a home and
 * the files stop running at all — this fails, loudly, in the same diff.
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
    /** The projects this job selects, from `--selectProjects`. */
    selectsProjects: string[];
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
        selectsProjects: (() => {
            const m = /--selectProjects\s+((?:[a-z]+\s+)*[a-z]+)/.exec(flatten(jestStep.run!));
            return m ? m[1].trim().split(/\s+/) : [];
        })(),
    });
}

/** The gate job: the one running check-merged-coverage.ts. */
const gateEntry = Object.entries(jobs).find(([, job]) =>
    (job.steps ?? []).some(
        (s) => typeof s.run === 'string' && s.run.includes('scripts/check-merged-coverage.ts'),
    ),
);

/**
 * Jest invocations that deliberately do NOT feed the merged total.
 *
 * The rule above — every Jest job instruments and uploads — is the right
 * default, but it is over-strict for a job that runs ONE suite for its own
 * purposes. Making such a job contribute would be actively wrong: the merge
 * zero-fills every file the artifact does not mention, so a single-suite
 * artifact drags the global percentages DOWN rather than adding signal.
 *
 * Each entry states why the job's Jest run is not part of the population, and
 * the gate's expected-artifact count excludes it. An unlisted uninstrumented
 * Jest job still fails: this is an allowlist, not a hole.
 */
const NON_CONTRIBUTING_JEST_JOBS: Record<string, string> = {
    build:
        'Runs ONLY tests/guardrails/bundle-size-budget.test.ts, against the ' +
        '.next manifest its own `next build` just produced — the one place a ' +
        'real production build exists on a PR. It is a single-suite check, so ' +
        'contributing it would add a sixth artifact whose zero-fill lowers the ' +
        'merged global percentages instead of measuring anything. The suite ' +
        'itself is already in the Ratchets population and counted there.',
};

const contributing = producers.filter((p) => !(p.id in NON_CONTRIBUTING_JEST_JOBS));

/** The project blocks, read structurally rather than by regex over the source. */
interface JestProject {
    displayName?: string;
    testMatch?: string[];
    testPathIgnorePatterns?: string[];
}
const jestProjects = (require(JEST_CONFIG) as { projects: JestProject[] }).projects;

/**
 * Directories excluded from the `node` project that no Jest project claims,
 * because they are not Jest work at all. Each entry says what runs them; an
 * unlisted, unclaimed directory fails, so this is an allowlist, not a hole.
 */
const EXCLUDED_FROM_JEST: Record<string, string> = {
    'tests/e2e':
        'Playwright specs (`*.spec.ts`), which Jest\'s `**/*.test.ts` would ' +
        'not match anyway — the exclusion is belt-and-braces. Run by the ' +
        'e2e job via `playwright test`, and not part of the merged Jest total.',
    'tests/stress':
        'Opt-in load suite gated on `JEST_STRESS=1` (`npm run stress`), run by ' +
        '.github/workflows/integration-stress.yml against its own database. It ' +
        'measures throughput rather than behaviour, so instrumenting it would ' +
        'add a zero-filled artifact that lowers the merged percentages.',
};

describe('the coverage gate measures the whole suite', () => {
    it('the census is plausibly sized (guards against a vacuous pass)', () => {
        // Every assertion below iterates the producer census. A parse that yields an
        // empty list would pass all of them while checking nothing.
        expect(producers.length).toBeGreaterThanOrEqual(2);
        expect(gateEntry).toBeDefined();
    });

    it('every exemption names a real Jest job and carries a reason', () => {
        // A stale exemption is a hole that looks like a decision: the job is
        // gone (or renamed) and the entry silently excuses nothing while
        // implying the question was considered.
        const ids = new Set(producers.map((p) => p.id));
        for (const [jobId, reason] of Object.entries(NON_CONTRIBUTING_JEST_JOBS)) {
            expect(ids.has(jobId)).toBe(true);
            expect(reason.length).toBeGreaterThan(60);
        }
        // And the exemption must not swallow the whole census.
        expect(contributing.length).toBeGreaterThanOrEqual(2);
    });

    it('every job that runs Jest collects coverage', () => {
        const uninstrumented = contributing
            .filter((p) => !/--coverage\b/.test(p.command) || /--no-coverage\b/.test(p.command))
            .map((p) => p.id);
        // A Jest job that skips instrumentation removes its files from the
        // merged total without removing them from the suite — the floors then
        // gate a smaller population at the same numbers.
        expect(uninstrumented).toEqual([]);
    });

    it('every job that runs Jest uploads its coverage to the gate', () => {
        const notUploading = contributing
            .filter((p) => p.artifactName === null || p.artifactPath !== 'coverage/coverage-final.json')
            .map((p) => `${p.id} (name=${p.artifactName}, path=${p.artifactPath})`);
        expect(notUploading).toEqual([]);
    });

    it('the gate expects exactly as many artifacts as CI produces', () => {
        const expectedTotal = contributing.reduce((n, p) => n + p.artifacts, 0);
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
        const missing = contributing.map((p) => p.id).filter((id) => !needs.includes(id));
        expect(missing).toEqual([]);
    });

    it('the gate is reachable on a pull request', () => {
        // The whole point of the fold: a coverage regression must be visible
        // BEFORE merge, not on the first main push after it.
        const [, gateJob] = gateEntry!;
        expect(gateJob.if ?? '').not.toMatch(/github\.event_name/);
    });

    it('every tests/ directory the shard projects exclude is claimed by another project', () => {
        // THE COMPLEMENT (#4395). `node` excludes a directory; some other
        // project's `testMatch` has to claim it, or those files run nowhere —
        // in CI or locally. Anything deliberately outside Jest altogether is
        // listed in EXCLUDED_FROM_JEST with a reason.
        const byName = new Map(jestProjects.map((pr) => [pr.displayName, pr]));
        const node = byName.get('node');
        expect(node).toBeDefined();

        const excluded = [
            ...new Set(
                (node!.testPathIgnorePatterns ?? []).flatMap((pat) =>
                    [...pat.matchAll(/tests\/[A-Za-z0-9_-]+/g)].map((m) => m[0]),
                ),
            ),
        ];
        // Vacuity: node really does exclude test directories.
        expect(excluded.length).toBeGreaterThanOrEqual(3);

        const claimed = jestProjects
            .filter((pr) => pr.displayName !== 'node')
            .flatMap((pr) => pr.testMatch ?? [])
            .join(' ');
        // Vacuity: the claiming side is non-empty and really is read from
        // `testMatch` — if this string were empty every directory below would
        // read as unclaimed and the test would fail rather than pass, but say
        // it out loud so a future reader sees which half was checked.
        expect(claimed).toContain('tests/guards');

        const unclaimed = excluded.filter(
            (dir) => !claimed.includes(dir) && !(dir in EXCLUDED_FROM_JEST),
        );
        expect(unclaimed).toEqual([]);
    });

    it('the project claiming the scan directories is named by an instrumented job', () => {
        // The other half of the complement. `scan`'s `testMatch` claiming
        // `tests/guards/` means nothing if no CI job selects `scan`: the
        // directories are excluded from the shards, so that job is the only
        // thing that runs 810 files. Point the Ratchets job at a different
        // project and the test above still passes — this one does not.
        const selected = new Set(contributing.flatMap((pr) => pr.selectsProjects));
        // Vacuity: the parse found project names at all.
        expect(selected.size).toBeGreaterThanOrEqual(2);
        expect([...selected]).toContain('scan');
    });

    it('every exclusion from Jest names a real directory and carries a reason', () => {
        for (const [dir, reason] of Object.entries(EXCLUDED_FROM_JEST)) {
            expect(fs.existsSync(path.join(ROOT, dir))).toBe(true);
            expect(reason.length).toBeGreaterThan(40);
        }
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
/**
 * The pinned ignore lists — now on the PROJECT, because that is where the
 * lever lives (#4395).
 *
 * An adversarial review of the original branch found the hole by mutation:
 * adding `'tests/guardrails/.*'` to the Ratchets job's
 * `--testPathIgnorePatterns` removed ~530 test files from CI *and* from the
 * merged coverage total — and every guard in this file still passed, including
 * this one's own suite, which the pattern had just excluded from running.
 *
 * That lever was a CLI flag, and it was worse than it looked: a CLI
 * `--testPathIgnorePatterns` REPLACES the selected project's own list wholesale
 * rather than adding to it, so passing one also silently re-admitted every
 * directory the project excludes on purpose. No job passes it any more, and the
 * first list below pins that to EXACTLY nothing — a new flag fails here until
 * somebody writes down why it is not a silent coverage cut.
 *
 * The `scan` project's own list is pinned the same way and for the same reason,
 * since it is now what carries the one real exclusion.
 */
const CLI_IGNORE_ALLOWLIST: Record<string, Record<string, string>> = {
    // Deliberately empty: see above. Keyed by job id if an entry is ever added.
};

const PROJECT_IGNORE_ALLOWLIST: Record<string, Record<string, string>> = {
    scan: {
        '<rootDir>/node_modules/': 'Jest default; excludes dependencies, not repo tests.',
        '<rootDir>/.claude/':
            'Gitignored worktree checkouts holding a FULL copy of the repo — ' +
            'every test file twice, which makes jest-haste-map report duplicate ' +
            'manual mocks. Required of every project by #3633.',
        'rls-coverage\\.test\\.ts':
            'DB-backed RLS guard — needs a live Postgres with policies applied, ' +
            'which this project has no `globalSetup` to provision. It stays in ' +
            'the `node` project via a negative lookahead, so its files are ' +
            'still in the merged population and still run on every PR.',
    },
};

describe('the merged population is not narrowed by an ignore pattern', () => {
    it('no producer passes --testPathIgnorePatterns on the command line', () => {
        for (const p of producers) {
            const m = /--testPathIgnorePatterns\s+((?:'[^']*'\s*)+)/.exec(p.command);
            const found = m
                ? Array.from(m[1].matchAll(/'([^']*)'/g)).map((x) => x[1] as string).sort()
                : [];
            const allowed = Object.keys(CLI_IGNORE_ALLOWLIST[p.id] ?? {}).sort();
            expect({ job: p.id, patterns: found }).toEqual({ job: p.id, patterns: allowed });
        }
    });

    it("every scanning project's testPathIgnorePatterns is exactly the allowlisted set", () => {
        for (const [name, patterns] of Object.entries(PROJECT_IGNORE_ALLOWLIST)) {
            const project = jestProjects.find((pr) => pr.displayName === name);
            expect(project).toBeDefined();
            const found = [...(project!.testPathIgnorePatterns ?? [])].sort();
            const allowed = Object.keys(patterns).sort();
            expect({ project: name, patterns: found }).toEqual({ project: name, patterns: allowed });
        }
    });

    it('both allowlists have a written reason per pattern and no stale entries', () => {
        const producerIds = new Set(producers.map((p) => p.id));
        for (const [jobId, patterns] of Object.entries(CLI_IGNORE_ALLOWLIST)) {
            expect(producerIds.has(jobId)).toBe(true);
            for (const reason of Object.values(patterns)) {
                expect(reason.length).toBeGreaterThan(30);
            }
        }
        const projectNames = new Set(jestProjects.map((pr) => pr.displayName));
        // Vacuity: this loop really does inspect patterns. The CLI allowlist
        // above is empty by design, so without this the whole test would pass
        // having checked nothing at all.
        let checked = 0;
        for (const [name, patterns] of Object.entries(PROJECT_IGNORE_ALLOWLIST)) {
            expect(projectNames.has(name)).toBe(true);
            for (const reason of Object.values(patterns)) {
                expect(reason.length).toBeGreaterThan(30);
                checked += 1;
            }
        }
        expect(checked).toBeGreaterThanOrEqual(3);
    });
});
