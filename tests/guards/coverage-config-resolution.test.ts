/**
 * Guard: the coverage keys in `jest.config.js` land in the bucket that
 * is actually READ.
 *
 * ── The regression class ──────────────────────────────────────────────
 *
 * `groupOptions` in `jest-config` (node_modules/jest-config/build/index.js)
 * splits one normalised options object into a `globalConfig` bucket and a
 * `projectConfig` bucket. A key written to the wrong bucket is NOT an
 * error, NOT a warning, and NOT a deprecation notice — it is silently
 * dropped, and the option falls back to its default. Measured membership
 * on the installed jest (30.4.2):
 *
 *   collectCoverageFrom        → globalConfig   (a projectConfig copy is
 *                                                written but never read by
 *                                                any @jest/* or jest-* pkg)
 *   coverageThreshold          → globalConfig   ONLY
 *   coveragePathIgnorePatterns → projectConfig  ONLY
 *
 * This is exactly the failure GAP-15 (#48) introduced. It moved
 * `collectCoverageFrom` off the top level onto the project blocks, so
 * `globalConfig.collectCoverageFrom` resolved to `[]` — which disables
 * BOTH consumers at once:
 *
 *   - jest-runner → `shouldInstrument`: an empty array is no filter at
 *     all, so every non-test module any suite happens to import gets
 *     instrumented (`src/components/**`, `src/app/**`, …).
 *   - @jest/reporters → `_addUntestedFiles`: the zero-fill is guarded by
 *     `if (globalConfig.collectCoverageFrom.length > 0)`, so nothing is
 *     zero-filled and a file no test imports is simply absent from the
 *     report instead of counted at 0%.
 *
 * The merged CI report ended up holding 1491 files against 758 declared.
 * It survived from 2026-04-27 to 2026-08-11 because nothing asserted it.
 *
 * ── Why this guard resolves the config instead of reading it ──────────
 *
 * Reading `jest.config.js` as text and grepping for `collectCoverageFrom`
 * would have passed happily for those 15 months: the key WAS present, it
 * was just in the bucket nobody reads. Placement is not visible in the
 * source text — only in the resolved output. So this file runs the real
 * `readConfigs` from `jest-config` over the real `jest.config.js` and
 * asserts the RESOLVED values.
 *
 * ── Mutation proof ───────────────────────────────────────────────────
 *
 * Each assertion is a standalone function so the same code can be pointed
 * at deliberately-broken configs. The fixtures are written to a temp dir
 * under `os.tmpdir()` (never inside the repo tree) and resolved through
 * the same `readConfigs` entry point, so the bucket split is the real
 * one — not a simulation. A CORRECT baseline fixture is resolved too, so
 * a mutant failing proves the MUTATION is what breaks it, not the fact
 * that the fixture is minimal.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readConfigs } from 'jest-config';

const REPO_ROOT = path.resolve(__dirname, '../..');
const REAL_CONFIG_PATH = path.join(REPO_ROOT, 'jest.config.js');

/**
 * The declared coverage scope — the denominator the coverage gate is
 * supposed to measure against. Kept here as a literal (not imported from
 * `jest.config.js`) so that a change to the config is a change this test
 * SEES rather than one it silently follows.
 */
const DECLARED_COVERAGE_SCOPE: readonly string[] = [
    'src/app-layer/**/*.ts',
    'src/lib/**/*.ts',
    'src/app-layer/**/*.tsx',
    'src/lib/**/*.tsx',
    '!src/**/*.d.ts',
    '!src/**/types.ts',
    '!src/**/__tests__/**',
    '!src/**/*.test.ts',
    '!src/**/*.test.tsx',
];

/**
 * The `coveragePathIgnorePatterns` entry that only works from a project
 * block. At the top level it resolves to nothing and both projects fall
 * back to the default `['/node_modules/']`, which is how `tests/**` files
 * ended up inside the instrumented set.
 */
const TESTS_IGNORE_PATTERN = '/tests/';

type ResolvedConfig = Awaited<ReturnType<typeof readConfigs>>;
type JestArgv = Parameters<typeof readConfigs>[0];

/**
 * Resolve a jest config file exactly the way the `jest` CLI does.
 *
 * NOTE: the config MUST be a real file on disk. `readConfigs` also accepts
 * a JSON string via `argv.config`, but that path is not faithful: jest
 * re-reads the same JSON string for every project entry, so inline project
 * blocks inherit top-level values that a file-based config would not give
 * them. Using a file keeps the fixture semantics identical to the repo's.
 */
async function resolveJestConfig(
    configPath: string,
    rootDir: string,
): Promise<ResolvedConfig> {
    const argv = { $0: 'jest', _: [], config: configPath } satisfies JestArgv;
    return readConfigs(argv, [rootDir]);
}

/**
 * Every fixture dir this run created, so the cleanup test can assert on
 * exactly those paths rather than scanning `os.tmpdir()` for a prefix
 * (which a crashed earlier run could poison permanently).
 */
const fixtureDirs: string[] = [];

/** Write `source` as a `jest.config.js` in a fresh temp dir and resolve it. */
async function resolveFixture(source: string): Promise<ResolvedConfig> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jest-coverage-config-'));
    fixtureDirs.push(dir);
    try {
        const file = path.join(dir, 'jest.config.js');
        fs.writeFileSync(file, source, 'utf8');
        return await resolveJestConfig(file, dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ── the three assertions, as reusable checkers ────────────────────────
//
// Each takes a resolved config so it can be aimed at the real one (must
// pass) or at a mutant (must throw).

/**
 * ASSERTION 1 — `collectCoverageFrom` reaches the globalConfig bucket
 * with the declared scope intact.
 *
 * A non-empty value here is what makes the coverage denominator a
 * DECLARED scope rather than "whatever the suite's import graph happened
 * to touch". Emptiness is the GAP-15 shape.
 */
function assertCollectCoverageFromIsGlobal(
    resolved: ResolvedConfig,
    expectedScope: readonly string[],
): void {
    const value = resolved.globalConfig.collectCoverageFrom;

    expect(Array.isArray(value)).toBe(true);
    // The load-bearing half: `[]` disables both the instrumentation
    // filter and the zero-fill.
    expect(value.length).toBeGreaterThan(0);
    expect(value).toEqual([...expectedScope]);
}

/**
 * ASSERTION 2 — every project resolves `coveragePathIgnorePatterns`
 * containing `/tests/`.
 *
 * This is the mirror image of assertion 1: a PROJECT-only option that is
 * inert at the top level. Without it the run instruments the test tree
 * itself (`tests/setup/*`, `tests/helpers/*`) and those files land inside
 * the gated group.
 */
function assertProjectsIgnoreTestTree(resolved: ResolvedConfig): void {
    // Guard against the check passing vacuously over an empty project
    // list — the repo runs a two-project split (node + jsdom).
    expect(resolved.configs.length).toBeGreaterThanOrEqual(2);

    for (const project of resolved.configs) {
        const label = String(project.displayName?.name ?? project.id);
        expect({
            project: label,
            coveragePathIgnorePatterns: project.coveragePathIgnorePatterns,
        }).toEqual({
            project: label,
            coveragePathIgnorePatterns:
                expect.arrayContaining([TESTS_IGNORE_PATTERN]),
        });
    }
}

/**
 * ASSERTION 3 — `globalConfig.coverageThreshold` is `undefined`.
 *
 * This one is DELIBERATE, and it is the reason
 * `scripts/check-merged-coverage.ts` exists.
 *
 * `coverageThreshold` is a globalConfig-only key, and `jest.config.js`
 * puts it on the NODE PROJECT on purpose — the one placement where jest
 * reads it back as `undefined` and therefore enforces nothing. That is
 * the intent: CI runs the suite in four shards, each holding roughly a
 * quarter of the coverage data. A threshold that jest enforced would
 * make every shard compare its quarter against floors calibrated on all
 * of it, and every shard would fail. The floors are checked exactly once,
 * by `scripts/check-merged-coverage.ts`, over the four MERGED shard
 * artifacts.
 *
 * So: if this assertion ever starts failing because someone hoisted
 * `coverageThreshold` to the top level, the fix is NOT to update this
 * test. It is to put the key back on the project block and leave the
 * merged-report script as the gate — or to consciously retire that
 * script first.
 */
function assertJestEnforcesNoThreshold(resolved: ResolvedConfig): void {
    expect(resolved.globalConfig.coverageThreshold).toBeUndefined();
}

// ── mutant fixtures ───────────────────────────────────────────────────

/** The correct placement of all three keys, in miniature. */
const FIXTURE_CORRECT = `module.exports = {
    collectCoverageFrom: ['src/app-layer/**/*.ts'],
    projects: [
        { displayName: 'p1', coveragePathIgnorePatterns: ['/node_modules/', '/tests/'] },
        { displayName: 'p2', coveragePathIgnorePatterns: ['/node_modules/', '/tests/'] },
    ],
};`;

/** MUTANT A — the literal GAP-15 regression: scope moved onto the projects. */
const FIXTURE_SCOPE_ON_PROJECTS = `module.exports = {
    projects: [
        {
            displayName: 'p1',
            collectCoverageFrom: ['src/app-layer/**/*.ts'],
            coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
        },
        {
            displayName: 'p2',
            collectCoverageFrom: ['src/app-layer/**/*.ts'],
            coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
        },
    ],
};`;

/** MUTANT B — the mirror image: ignore patterns hoisted to the top level. */
const FIXTURE_IGNORE_AT_TOP_LEVEL = `module.exports = {
    collectCoverageFrom: ['src/app-layer/**/*.ts'],
    coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
    projects: [{ displayName: 'p1' }, { displayName: 'p2' }],
};`;

/** MUTANT C — threshold hoisted to the top level, where jest DOES enforce it. */
const FIXTURE_THRESHOLD_AT_TOP_LEVEL = `module.exports = {
    collectCoverageFrom: ['src/app-layer/**/*.ts'],
    coverageThreshold: { global: { lines: 60 } },
    projects: [
        { displayName: 'p1', coveragePathIgnorePatterns: ['/node_modules/', '/tests/'] },
        { displayName: 'p2', coveragePathIgnorePatterns: ['/node_modules/', '/tests/'] },
    ],
};`;

const FIXTURE_SCOPE: readonly string[] = ['src/app-layer/**/*.ts'];

// ── tests ─────────────────────────────────────────────────────────────

describe('jest coverage config — resolved bucket placement', () => {
    let real: ResolvedConfig;

    beforeAll(async () => {
        real = await resolveJestConfig(REAL_CONFIG_PATH, REPO_ROOT);
    }, 60_000);

    it('resolves both projects from the repo config', () => {
        const names = real.configs.map((c) => c.displayName?.name);
        expect(names).toEqual(expect.arrayContaining(['node', 'jsdom']));
    });

    it('puts collectCoverageFrom in globalConfig, holding the declared scope', () => {
        assertCollectCoverageFromIsGlobal(real, DECLARED_COVERAGE_SCOPE);
    });

    it('gives every project a coveragePathIgnorePatterns containing /tests/', () => {
        assertProjectsIgnoreTestTree(real);
    });

    it('leaves globalConfig.coverageThreshold undefined (see the comment — deliberate)', () => {
        assertJestEnforcesNoThreshold(real);
    });
});

describe('jest coverage config — mutation proof', () => {
    /**
     * Control. Everything the mutants below change is correct here, so a
     * mutant's failure is attributable to its mutation rather than to the
     * fixture being a stripped-down config.
     */
    it('passes all three checks on a correctly-placed miniature config', async () => {
        const resolved = await resolveFixture(FIXTURE_CORRECT);

        assertCollectCoverageFromIsGlobal(resolved, FIXTURE_SCOPE);
        assertProjectsIgnoreTestTree(resolved);
        assertJestEnforcesNoThreshold(resolved);
    }, 30_000);

    it('catches collectCoverageFrom moved onto the project blocks (the GAP-15 shape)', async () => {
        const resolved = await resolveFixture(FIXTURE_SCOPE_ON_PROJECTS);

        // The scope IS present in the source text of the fixture — a
        // grep-based guard would pass. The resolved global bucket is
        // empty, which is the thing that actually breaks the gate.
        expect(resolved.globalConfig.collectCoverageFrom).toEqual([]);
        expect(resolved.configs[0].collectCoverageFrom).toEqual([
            'src/app-layer/**/*.ts',
        ]);

        expect(() =>
            assertCollectCoverageFromIsGlobal(resolved, FIXTURE_SCOPE),
        ).toThrow();

        // The other two checks are unaffected — the mutation is targeted.
        assertProjectsIgnoreTestTree(resolved);
        assertJestEnforcesNoThreshold(resolved);
    }, 30_000);

    it('catches coveragePathIgnorePatterns hoisted to the top level', async () => {
        const resolved = await resolveFixture(FIXTURE_IGNORE_AT_TOP_LEVEL);

        // Silently dropped: both projects fall back to the default.
        for (const project of resolved.configs) {
            expect(project.coveragePathIgnorePatterns).toEqual([
                '/node_modules/',
            ]);
        }

        expect(() => assertProjectsIgnoreTestTree(resolved)).toThrow();

        assertCollectCoverageFromIsGlobal(resolved, FIXTURE_SCOPE);
        assertJestEnforcesNoThreshold(resolved);
    }, 30_000);

    it('catches coverageThreshold hoisted to where jest would enforce it per shard', async () => {
        const resolved = await resolveFixture(FIXTURE_THRESHOLD_AT_TOP_LEVEL);

        expect(resolved.globalConfig.coverageThreshold).toEqual({
            global: { lines: 60 },
        });

        expect(() => assertJestEnforcesNoThreshold(resolved)).toThrow();

        assertCollectCoverageFromIsGlobal(resolved, FIXTURE_SCOPE);
        assertProjectsIgnoreTestTree(resolved);
    }, 30_000);

    it('writes its fixtures outside the repo tree and cleans them up', () => {
        // Four fixtures were resolved above; none of them may have been
        // written inside the repo, and none may survive the run.
        expect(fixtureDirs.length).toBe(4);

        for (const dir of fixtureDirs) {
            expect(dir.startsWith(REPO_ROOT + path.sep)).toBe(false);
            expect(fs.existsSync(dir)).toBe(false);
        }
    });
});
