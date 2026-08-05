/**
 * Merge per-shard Istanbul coverage and enforce `jest.thresholds.json`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The coverage gate used to be one unsharded `jest --coverage --runInBand`
 * pass over the whole suite — 35+ minutes, and climbing. Sharding it is the
 * obvious fix, but `--coverageThreshold` evaluated per shard would gate on a
 * QUARTER of the data: every shard would report most of `src/` as 0% covered
 * and fail, and loosening the floors to make shards pass would destroy the
 * gate. Thresholds have to be checked ONCE, on the merged total.
 *
 * So the shards emit raw `coverage-final.json` and this script does the two
 * things Jest was doing at the end: merge, then compare against the floors.
 *
 * THE PART THAT IS EASY TO GET WRONG
 * ----------------------------------
 * A non-`global` key in `jest.thresholds.json` does not just *add* a check —
 * it REMOVES those files from the `global` group. `./src/lib/` at 89% lines
 * and `global` at 78% is not "lib must beat 89 and everything must beat 78";
 * it is "lib must beat 89, and everything OUTSIDE the four listed paths must
 * beat 78". Implement it as a plain overlay and `global` silently gets easier
 * — the gate keeps passing while covering less. `groupFiles()` below is that
 * rule, and `check-merged-coverage.test.ts` pins it.
 *
 * SUPPORTED SUBSET
 * ----------------
 * Jest's own option also accepts globs and negative thresholds ("at most N
 * uncovered lines"). This script implements PATH-PREFIX keys and POSITIVE
 * percentages only — the subset `jest.thresholds.json` actually uses — and
 * throws on anything else rather than guessing. A future glob key fails loudly
 * here instead of being silently skipped.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import libCoverage from 'istanbul-lib-coverage';

/** The four counters Jest reports, in the order it prints them. */
export const METRICS = ['statements', 'branches', 'functions', 'lines'] as const;
export type Metric = (typeof METRICS)[number];

export type ThresholdGroup = Partial<Record<Metric, number>>;
export type ThresholdConfig = Record<string, ThresholdGroup>;

export interface GroupResult {
    group: string;
    fileCount: number;
    /** Missing when the group covers zero instrumented units of that metric. */
    actual: Partial<Record<Metric, number>>;
    failures: Array<{ metric: Metric; actual: number; required: number }>;
}

/**
 * Reject threshold shapes this script does not implement, rather than
 * silently mis-evaluating them.
 */
export function assertSupportedThresholds(config: ThresholdConfig): void {
    for (const [group, limits] of Object.entries(config)) {
        if (group !== 'global' && !group.startsWith('./')) {
            throw new Error(
                `Unsupported threshold key "${group}": this script implements path-prefix ` +
                    `keys (starting with "./") and "global" only. Jest also accepts globs — ` +
                    `if you need one, extend groupFiles() and its test, do not loosen this check.`,
            );
        }
        for (const [metric, value] of Object.entries(limits)) {
            if (!(METRICS as readonly string[]).includes(metric)) {
                throw new Error(`Unknown coverage metric "${metric}" in group "${group}".`);
            }
            if (typeof value !== 'number' || value < 0) {
                throw new Error(
                    `Unsupported threshold ${group}.${metric} = ${String(value)}: this script ` +
                        `implements positive percentages only (Jest also accepts negative ` +
                        `"max uncovered units" values).`,
                );
            }
        }
    }
}

/**
 * Assign every covered file to exactly one threshold group.
 *
 * Path keys win over `global`, and the LONGEST matching path key wins over a
 * shorter one — so `./src/app-layer/usecases/` takes precedence over a
 * hypothetical `./src/` without depending on key order.
 */
export function groupFiles(files: string[], config: ThresholdConfig, cwd: string): Map<string, string[]> {
    const pathKeys = Object.keys(config)
        .filter((k) => k !== 'global')
        .map((k) => ({ key: k, prefix: path.resolve(cwd, k) + path.sep }))
        // Longest prefix first so the most specific group claims the file.
        .sort((a, b) => b.prefix.length - a.prefix.length);

    const groups = new Map<string, string[]>();
    for (const key of Object.keys(config)) groups.set(key, []);

    for (const file of files) {
        const absolute = path.resolve(cwd, file);
        const match = pathKeys.find((p) => absolute.startsWith(p.prefix));
        // No path key claimed it → it counts toward `global`, and ONLY toward
        // global. This is the removal rule the header comment describes.
        const target = match ? match.key : 'global';
        if (groups.has(target)) groups.get(target)!.push(file);
    }
    return groups;
}

/** Percentage for one metric over one set of files, or null if nothing to cover. */
function percentFor(map: libCoverage.CoverageMap, files: string[], metric: Metric): number | null {
    const summary = libCoverage.createCoverageSummary();
    for (const file of files) summary.merge(map.fileCoverageFor(file).toSummary());
    const entry = summary[metric];
    if (!entry || entry.total === 0) return null;
    return entry.pct;
}

export function evaluate(
    map: libCoverage.CoverageMap,
    config: ThresholdConfig,
    cwd: string,
): GroupResult[] {
    assertSupportedThresholds(config);
    const grouped = groupFiles(map.files(), config, cwd);

    return Object.entries(config).map(([group, limits]) => {
        const files = grouped.get(group) ?? [];
        const actual: Partial<Record<Metric, number>> = {};
        const failures: GroupResult['failures'] = [];

        for (const metric of METRICS) {
            const required = limits[metric];
            if (required === undefined) continue;
            const pct = percentFor(map, files, metric);
            if (pct === null) continue;
            actual[metric] = pct;
            if (pct < required) failures.push({ metric, actual: pct, required });
        }
        return { group, fileCount: files.length, actual, failures };
    });
}

/** Merge every `coverage-final.json` found under `dir` (one per shard). */
export function mergeShardFiles(files: string[]): libCoverage.CoverageMap {
    const merged = libCoverage.createCoverageMap({});
    for (const file of files) {
        merged.merge(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    return merged;
}

export function findShardFiles(dir: string): string[] {
    const found: string[] = [];
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name === 'coverage-final.json') found.push(full);
        }
    };
    walk(dir);
    return found.sort();
}

function main(): void {
    const [dir, thresholdPath, expectedShardsRaw] = process.argv.slice(2);
    if (!dir || !thresholdPath) {
        console.error(
            'usage: tsx scripts/check-merged-coverage.ts <shard-artifact-dir> <thresholds.json> [expectedShards]',
        );
        process.exit(2);
    }

    const shardFiles = findShardFiles(dir);
    // A missing shard would quietly lower every percentage — the exact
    // failure mode sharding introduces. Refuse to report a number at all.
    const expected = expectedShardsRaw ? Number(expectedShardsRaw) : shardFiles.length;
    if (shardFiles.length === 0) {
        console.error(`No coverage-final.json found under ${dir} — the shards produced nothing.`);
        process.exit(1);
    }
    if (shardFiles.length !== expected) {
        console.error(
            `Expected ${expected} shard coverage files under ${dir}, found ${shardFiles.length}:\n` +
                shardFiles.map((f) => `  ${f}`).join('\n') +
                `\nRefusing to gate on partial data — a missing shard reads as uncovered code.`,
        );
        process.exit(1);
    }

    const map = mergeShardFiles(shardFiles);
    const config: ThresholdConfig = JSON.parse(fs.readFileSync(thresholdPath, 'utf8'));
    const results = evaluate(map, config, process.cwd());

    console.log(`Merged ${shardFiles.length} shard coverage files — ${map.files().length} files.\n`);
    for (const result of results) {
        const cells = METRICS.filter((m) => result.actual[m] !== undefined)
            .map((m) => `${m} ${result.actual[m]!.toFixed(2)}% (>=${config[result.group][m]})`)
            .join('  ');
        const mark = result.failures.length ? 'FAIL' : 'ok  ';
        console.log(`${mark} ${result.group.padEnd(32)} ${String(result.fileCount).padStart(5)} files  ${cells}`);
    }

    const failed = results.filter((r) => r.failures.length > 0);
    if (failed.length > 0) {
        console.error('\nCoverage thresholds not met:');
        for (const result of failed) {
            for (const f of result.failures) {
                console.error(
                    `  ${result.group} ${f.metric}: ${f.actual.toFixed(2)}% < ${f.required}%`,
                );
            }
        }
        process.exit(1);
    }
    console.log('\nAll coverage thresholds met.');
}

// `tsx` runs this file directly in CI; the test imports it as a module.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    main();
}
