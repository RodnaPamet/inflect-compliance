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
    assertSupportedThresholds,
    evaluate,
    groupFiles,
    mergeShardFiles,
    METRICS,
    type ThresholdConfig,
} from '../../../scripts/check-merged-coverage';

const CWD = '/repo';

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
            [path.join(CWD, 'src/lib/format.ts'), path.join(CWD, 'src/components/Button.tsx')],
            config,
            CWD,
        );
        expect(groups.get('./src/lib/')).toEqual([path.join(CWD, 'src/lib/format.ts')]);
        expect(groups.get('global')).toEqual([path.join(CWD, 'src/components/Button.tsx')]);
        // The regression this whole file guards: lib must not be counted twice.
        expect(groups.get('global')).not.toContain(path.join(CWD, 'src/lib/format.ts'));
    });

    it('gives every file exactly one group', () => {
        const files = [
            'src/lib/a.ts',
            'src/app-layer/usecases/b.ts',
            'src/components/c.tsx',
            'src/app/api/d/route.ts',
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
            ['src/components/b.tsx', 6, 10], // 60% — over the global floor of 50
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
            ['src/components/low.tsx', 1, 10],
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

        const merged = mergeShardFiles([a, b]);
        expect(merged.fileCoverageFor(abs).toSummary().statements.covered).toBe(2);
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
