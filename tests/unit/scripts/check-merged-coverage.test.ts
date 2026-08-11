/**
 * The merged-coverage gate replaces Jest's own `--coverageThreshold` pass,
 * so it has to reproduce Jest's semantics — not an approximation of them.
 *
 * The load-bearing rule is that a path key REMOVES its files from `global`.
 * Get that wrong and the gate still runs, still prints numbers, and still
 * says "ok" — while `global` quietly covers a smaller and easier set of
 * files than the floor was calibrated against. That is the failure this
 * suite exists to make impossible: a silent loosening that looks green.
 */
import * as path from 'node:path';

import libCoverage from 'istanbul-lib-coverage';

import {
    assertEveryGroupMatchedFiles,
    assertSupportedThresholds,
    evaluate,
    groupFiles,
    mergeShardFiles,
    METRICS,
    type ThresholdConfig,
} from '../../../scripts/check-merged-coverage';

const CWD = '/repo';

/**
 * The report is scoped by `collectCoverageFrom` to `.ts` under
 * `src/app-layer/` and `src/lib/`, so the fixtures below use paths that can
 * actually appear in it. The four threshold keys claim `usecases/`,
 * `policies/`, `events/` and all of `src/lib/`; what lands in `global` is the
 * REST of `src/app-layer/` — `repositories/`, `jobs/`, `services/` and their
 * siblings. `src/components/**` and `src/app/**` are outside the declared
 * scope and never reach the merged report.
 */

/** Run `fn`, expecting it to throw, and hand back the message to assert on. */
function messageFrom(fn: () => unknown): string {
    try {
        fn();
    } catch (error) {
        return (error as Error).message;
    }
    throw new Error('expected the call to throw, but it returned normally');
}

/**
 * Build a single file's Istanbul coverage with `covered` of `total`
 * statements hit. Statements are enough to exercise the grouping and
 * threshold maths; the other three metrics share the same code path.
 */
function fileCoverage(filePath: string, covered: number, total: number) {
    const statementMap: Record<string, unknown> = {};
    const s: Record<string, number> = {};
    for (let i = 0; i < total; i++) {
        statementMap[String(i)] = {
            start: { line: i + 1, column: 0 },
            end: { line: i + 1, column: 10 },
        };
        s[String(i)] = i < covered ? 1 : 0;
    }
    return {
        path: filePath,
        statementMap,
        fnMap: {},
        branchMap: {},
        s,
        f: {},
        b: {},
    };
}

function mapOf(entries: Array<[string, number, number]>) {
    const data: Record<string, unknown> = {};
    for (const [file, covered, total] of entries) {
        const abs = path.join(CWD, file);
        data[abs] = fileCoverage(abs, covered, total);
    }
    return libCoverage.createCoverageMap(data as never);
}

describe('check-merged-coverage — grouping', () => {
    const config: ThresholdConfig = {
        global: { statements: 50 },
        './src/lib/': { statements: 90 },
        './src/app-layer/usecases/': { statements: 80 },
    };

    it('assigns a file to its path group and NOT to global', () => {
        const groups = groupFiles(
            [
                path.join(CWD, 'src/lib/format.ts'),
                path.join(CWD, 'src/app-layer/repositories/risk.ts'),
            ],
            config,
            CWD,
        );
        expect(groups.get('./src/lib/')).toEqual([path.join(CWD, 'src/lib/format.ts')]);
        expect(groups.get('global')).toEqual([
            path.join(CWD, 'src/app-layer/repositories/risk.ts'),
        ]);
        // The regression this whole file guards: lib must not be counted twice.
        expect(groups.get('global')).not.toContain(path.join(CWD, 'src/lib/format.ts'));
    });

    it('gives every file exactly one group', () => {
        const files = [
            'src/lib/a.ts',
            'src/app-layer/usecases/b.ts',
            'src/app-layer/services/c.ts',
            'src/app-layer/jobs/d.ts',
        ].map((f) => path.join(CWD, f));
        const groups = groupFiles(files, config, CWD);
        const assigned = [...groups.values()].flat();
        expect(assigned.sort()).toEqual(files.sort());
        expect(new Set(assigned).size).toBe(files.length);
    });

    it('lets the longest path prefix win, regardless of key order', () => {
        const nested: ThresholdConfig = {
            global: { statements: 1 },
            './src/': { statements: 1 },
            './src/lib/security/': { statements: 1 },
        };
        const groups = groupFiles([path.join(CWD, 'src/lib/security/sanitize.ts')], nested, CWD);
        expect(groups.get('./src/lib/security/')).toHaveLength(1);
        expect(groups.get('./src/')).toHaveLength(0);
    });

    it('does not let a prefix match a sibling directory by name', () => {
        // './src/lib/' must not swallow './src/library-thing/…'.
        const groups = groupFiles([path.join(CWD, 'src/library-thing/x.ts')], config, CWD);
        expect(groups.get('./src/lib/')).toHaveLength(0);
        expect(groups.get('global')).toHaveLength(1);
    });
});

describe('check-merged-coverage — thresholds', () => {
    it('fails a group under its floor and passes one over it', () => {
        const config: ThresholdConfig = {
            global: { statements: 50 },
            './src/lib/': { statements: 90 },
        };
        const map = mapOf([
            ['src/lib/a.ts', 8, 10], // 80% — under the lib floor of 90
            ['src/app-layer/repositories/b.ts', 6, 10], // 60% — over the global floor of 50
        ]);
        const results = evaluate(map, config, CWD);
        const lib = results.find((r) => r.group === './src/lib/')!;
        const global = results.find((r) => r.group === 'global')!;

        expect(lib.failures).toEqual([{ metric: 'statements', actual: 80, required: 90 }]);
        expect(global.failures).toEqual([]);
        expect(global.actual.statements).toBe(60);
    });

    it('computes global WITHOUT the files a path group claimed', () => {
        // If global wrongly included the lib file, the global percentage
        // would be (9+1)/20 = 50 and would PASS its floor of 50. Excluding
        // it correctly leaves 1/10 = 10% and fails.
        const config: ThresholdConfig = {
            global: { statements: 50 },
            './src/lib/': { statements: 50 },
        };
        const map = mapOf([
            ['src/lib/high.ts', 9, 10],
            ['src/app-layer/jobs/low.ts', 1, 10],
        ]);
        const global = evaluate(map, config, CWD).find((r) => r.group === 'global')!;
        expect(global.actual.statements).toBe(10);
        expect(global.failures).toHaveLength(1);
    });

    it('skips a metric with nothing instrumented instead of reporting 0%', () => {
        // A file with no branches must not drag a branches floor to a
        // false failure — Istanbul reports 100%/absent, never a hard 0.
        const config: ThresholdConfig = { global: { statements: 50, branches: 50 } };
        const map = mapOf([['src/x.ts', 6, 10]]);
        const global = evaluate(map, config, CWD)[0];
        expect(global.actual.statements).toBe(60);
        expect(global.actual.branches).toBeUndefined();
        expect(global.failures).toEqual([]);
    });
});

describe('check-merged-coverage — merging shards', () => {
    it('unions hits for the same file across shards', () => {
        // Shard 1 covers statements 0-1, shard 2 covers 2-3. Merged, the
        // file is 4/5 = 80% — neither shard alone would clear an 80 floor.
        const abs = path.join(CWD, 'src/lib/shared.ts');
        const shard1 = fileCoverage(abs, 0, 5);
        shard1.s['0'] = 1;
        shard1.s['1'] = 1;
        const shard2 = fileCoverage(abs, 0, 5);
        shard2.s['2'] = 1;
        shard2.s['3'] = 1;

        const merged = libCoverage.createCoverageMap({});
        merged.merge({ [abs]: shard1 } as never);
        merged.merge({ [abs]: shard2 } as never);

        const summary = merged.fileCoverageFor(abs).toSummary();
        expect(summary.statements.covered).toBe(4);
        expect(summary.statements.pct).toBe(80);
    });

    it('reads and merges real shard files from disk', () => {
        const fs = require('node:fs') as typeof import('node:fs');
        const os = require('node:os') as typeof import('node:os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-merge-'));
        const abs = path.join(CWD, 'src/lib/one.ts');
        const a = path.join(dir, 'a.json');
        const b = path.join(dir, 'b.json');
        const left = fileCoverage(abs, 0, 4);
        left.s['0'] = 1;
        const right = fileCoverage(abs, 0, 4);
        right.s['3'] = 1;
        fs.writeFileSync(a, JSON.stringify({ [abs]: left }));
        fs.writeFileSync(b, JSON.stringify({ [abs]: right }));

        const { map, divergence } = mergeShardFiles([a, b]);
        expect(map.fileCoverageFor(abs).toSummary().statements.covered).toBe(2);
        // Same instrumentation in both shards — nothing to normalise.
        expect(divergence).toEqual({ files: 0, discardedCovered: 0 });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /**
     * The regression this normalisation exists for. On CI a file that a
     * shard's tests never imported is enrolled by Jest's zero-fill with a
     * LARGER statement map than the one it gets when a test loads it — a
     * strict superset. istanbul merges by location, so the union adopts the
     * bigger denominator while keeping only the real shard's hits, and a file
     * that is 90% covered reports 51%.
     *
     * The fixture reproduces the observed shape exactly: shard A loaded the
     * file (4 statements, 3 covered); shards B and C zero-filled it with an
     * 8-statement map whose first four locations are identical.
     */
    it('does not let a zero-filled shard enlarge the denominator of a file another shard covered', () => {
        const fs = require('node:fs') as typeof import('node:fs');
        const os = require('node:os') as typeof import('node:os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-shape-'));
        const abs = path.join(CWD, 'src/lib/two.ts');

        const loaded = fileCoverage(abs, 3, 4);
        const zeroFilled = fileCoverage(abs, 0, 8);

        const shards = ['a', 'b', 'c'].map((n) => path.join(dir, `${n}.json`));
        fs.writeFileSync(shards[0], JSON.stringify({ [abs]: loaded }));
        fs.writeFileSync(shards[1], JSON.stringify({ [abs]: zeroFilled }));
        fs.writeFileSync(shards[2], JSON.stringify({ [abs]: zeroFilled }));

        const { map, divergence } = mergeShardFiles(shards);
        const summary = map.fileCoverageFor(abs).toSummary();

        // Blind location-union would give 3/8 = 37.5%.
        expect(summary.statements.total).toBe(4);
        expect(summary.statements.covered).toBe(3);
        expect(summary.statements.pct).toBe(75);

        // And it says so out loud rather than normalising silently.
        expect(divergence.files).toBe(1);
        expect(divergence.discardedCovered).toBe(0);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('keeps the shape that observed the most coverage, and reports what it dropped', () => {
        const fs = require('node:fs') as typeof import('node:fs');
        const os = require('node:os') as typeof import('node:os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-shape2-'));
        const abs = path.join(CWD, 'src/lib/three.ts');

        // Two rulers, both with real hits: 5 covered under one instrumentation,
        // 2 under the other. There is no sound mapping between the two
        // coordinate spaces, so the minority's hits are discarded — and counted.
        const dominant = fileCoverage(abs, 5, 10);
        const minority = fileCoverage(abs, 2, 12);

        const shards = ['a', 'b'].map((n) => path.join(dir, `${n}.json`));
        fs.writeFileSync(shards[0], JSON.stringify({ [abs]: dominant }));
        fs.writeFileSync(shards[1], JSON.stringify({ [abs]: minority }));

        const { map, divergence } = mergeShardFiles(shards);
        const summary = map.fileCoverageFor(abs).toSummary();

        expect(summary.statements.total).toBe(10);
        expect(summary.statements.covered).toBe(5);
        expect(divergence).toEqual({ files: 1, discardedCovered: 2 });

        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('check-merged-coverage — refuses what it does not implement', () => {
    it('rejects a glob key rather than silently skipping it', () => {
        expect(() =>
            assertSupportedThresholds({ global: { lines: 1 }, 'src/**/*.ts': { lines: 90 } }),
        ).toThrow(/Unsupported threshold key/);
    });

    it('rejects a negative "max uncovered units" threshold', () => {
        expect(() => assertSupportedThresholds({ global: { lines: -10 } })).toThrow(
            /positive percentages only/,
        );
    });

    it('rejects an unknown metric name', () => {
        expect(() =>
            assertSupportedThresholds({ global: { lnies: 90 } as never }),
        ).toThrow(/Unknown coverage metric/);
    });

    it('accepts the real jest.thresholds.json', () => {
        const config = require('../../../jest.thresholds.json') as ThresholdConfig;
        expect(() => assertSupportedThresholds(config)).not.toThrow();
        // Every group names at least one of the four metrics — a typo'd
        // group with no recognised metric would gate on nothing.
        for (const [group, limits] of Object.entries(config)) {
            expect(METRICS.some((m) => limits[m] !== undefined)).toBe(true);
            expect(group).toBeTruthy();
        }
    });
});

/**
 * The sibling hole to the removal rule.
 *
 * `assertSupportedThresholds` catches a threshold key whose SHAPE this script
 * cannot evaluate. Nothing caught a key whose shape is fine and whose
 * POPULATION is empty: `percentFor` returned null for every metric, `evaluate`
 * skipped every metric, and the row printed
 *
 *     ok   ./src/typo-does-not-exist/     0 files
 *
 * A green gate measuring nothing — the same silent loosening as a broken
 * removal rule, arriving through a different door.
 */
describe('check-merged-coverage — refuses a group that matched zero files', () => {
    it('fails a declared group with no files instead of reporting it ok', () => {
        const config: ThresholdConfig = {
            global: { statements: 50 },
            './src/typo-does-not-exist/': { statements: 99 },
        };
        const map = mapOf([['src/app-layer/repositories/risk.ts', 9, 10]]);

        // Pre-fix this returned [{ group: './src/typo-does-not-exist/',
        // fileCount: 0, actual: {}, failures: [] }] and the gate exited 0.
        const message = messageFrom(() => evaluate(map, config, CWD));
        expect(message).toContain('"./src/typo-does-not-exist/"');
        expect(message).toContain('gates on nothing');
        // The message has to name the cause, not just the symptom.
        expect(message).toContain('typo');
    });

    it('names CI shard artifacts from another checkout as the other likely cause', () => {
        // The reproduction recorded in
        // docs/implementation-notes/2026-08-11-coverage-gate-enrolment.md:
        // shard artifacts downloaded from CI are keyed by their ABSOLUTE
        // /home/runner/work/... paths. Resolved against a local checkout every
        // "./src/..." prefix matches zero files, so nothing is subtracted from
        // `global` and the script reports a high, authoritative-looking,
        // meaningless percentage. Every file here is 100% covered — pre-fix
        // this config sailed past all five floors while gating on none of them.
        const config = require('../../../jest.thresholds.json') as ThresholdConfig;
        const runner = '/home/runner/work/inflect-compliance/inflect-compliance';
        const data: Record<string, unknown> = {};
        for (const file of ['src/lib/format.ts', 'src/app-layer/usecases/risk.ts']) {
            const abs = path.join(runner, file);
            data[abs] = fileCoverage(abs, 10, 10);
        }
        const map = libCoverage.createCoverageMap(data as never);

        const message = messageFrom(() => evaluate(map, config, CWD));
        // All four declared groups, named, so the operator sees the pattern
        // rather than chasing one key.
        expect(message).toContain('"./src/app-layer/usecases/"');
        expect(message).toContain('"./src/app-layer/policies/"');
        expect(message).toContain('"./src/app-layer/events/"');
        expect(message).toContain('"./src/lib/"');
        expect(message).toContain('ABSOLUTE path');
        // …and the smoking gun: a real path from the report, next to the cwd
        // it was resolved against. Seeing both side by side ends the hunt.
        expect(message).toContain(runner);
        expect(message).toContain(CWD);
    });

    it('applies the same rule to `global`, with its own diagnosis', () => {
        // `global` is a residue, not a declared path, so an empty one means
        // the path keys partitioned the scope exhaustively. That is coherent
        // and still vacuous: the global floor then applies to nothing.
        const config: ThresholdConfig = {
            global: { statements: 50 },
            './src/app-layer/': { statements: 50 },
        };
        const map = mapOf([['src/app-layer/repositories/risk.ts', 9, 10]]);

        const message = messageFrom(() => evaluate(map, config, CWD));
        expect(message).toContain('"global"');
        expect(message).not.toContain('"./src/app-layer/"');
        expect(message).toContain('every covered file was claimed by a path key');
    });

    it('does not confuse an empty METRIC with an empty GROUP', () => {
        // This is the distinction the bug collapsed. A file with no branches
        // legitimately yields no branches percentage and must stay silent;
        // only a group with no FILES is the error. Same null out of
        // `percentFor`, opposite verdicts.
        const config: ThresholdConfig = { global: { statements: 50, branches: 50 } };
        const map = mapOf([['src/app-layer/repositories/asset.ts', 6, 10]]);

        expect(() => evaluate(map, config, CWD)).not.toThrow();
        const global = evaluate(map, config, CWD)[0];
        expect(global.actual.branches).toBeUndefined();
        expect(global.failures).toEqual([]);
    });

    it('leaves groupFiles() a pure partition — the refusal is evaluate()’s', () => {
        // The prefix-boundary tests above legitimately assert `toHaveLength(0)`
        // on a group. Pushing the refusal down into `groupFiles` would break
        // them and conflate "which group owns this file" with "is this config
        // gating on anything".
        const config: ThresholdConfig = {
            global: { statements: 1 },
            './src/lib/': { statements: 1 },
        };
        expect(() =>
            groupFiles([path.join(CWD, 'src/app-layer/jobs/x.ts')], config, CWD),
        ).not.toThrow();
    });

    it('stays quiet when every group matched at least one file', () => {
        const grouped = new Map<string, string[]>([
            ['global', [path.join(CWD, 'src/app-layer/services/a.ts')]],
            ['./src/lib/', [path.join(CWD, 'src/lib/b.ts')]],
        ]);
        expect(() =>
            assertEveryGroupMatchedFiles(grouped, [...grouped.values()].flat(), CWD),
        ).not.toThrow();
    });
});
