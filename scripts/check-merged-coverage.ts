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
 * "Everything outside the four listed paths" is a small, specific population,
 * and it is worth knowing WHICH one. The merged report is scoped by
 * `collectCoverageFrom` to `.ts` files under `src/app-layer/` and `src/lib/`;
 * the four keys claim `usecases/`, `policies/`, `events/` and all of
 * `src/lib/`. What is left over — the actual `global` denominator — is the
 * REST OF `src/app-layer/`: `repositories/`, `jobs/`, `services/`,
 * `integrations/`, `ai/`, `schemas/`, `notifications/`, `reports/`,
 * `domain/`, `automation/`, `libraries/`, `utils/`. It is NOT the UI.
 * `src/components/**` and `src/app/**` sit outside the declared scope and no
 * longer reach the report at all — until 2026-08-11 they did, because
 * `collectCoverageFrom` was written to a config bucket nothing reads, and
 * `global` was three-quarters React files whose presence depended on which
 * components a test happened to import.
 *
 * A group that matches ZERO files is the same failure wearing a different
 * hat: no files means no percentage means no verdict means "ok".
 * `assertEveryGroupMatchedFiles()` refuses it.
 *
 * SUPPORTED SUBSET
 * ----------------
 * Jest's own option also accepts globs and negative thresholds ("at most N
 * uncovered lines"). This script implements PATH-PREFIX keys and POSITIVE
 * percentages only — the subset `jest.thresholds.json` actually uses — and
 * throws on anything else rather than guessing. A future glob key fails loudly
 * here instead of being silently skipped.
 */
import { createHash } from 'node:crypto';
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

/**
 * Refuse a threshold group that claimed no files at all.
 *
 * WHY THIS IS A SEPARATE CHECK AND NOT A `null` FROM `percentFor`
 * --------------------------------------------------------------
 * `percentFor` returns null when a metric has zero instrumented units, and
 * `evaluate` skips the metric. That is CORRECT for a file with no branches —
 * a branches floor must not read as a hard 0% and fail. It is catastrophic
 * for a group with no FILES, because zero files makes every metric null: the
 * group records no `actual`, no `failures`, and prints
 *
 *     ok   ./src/typo-does-not-exist/     0 files
 *
 * A green row measuring nothing. The two cases arrive as the same `null` and
 * deserve opposite verdicts, so the file-count case is decided here, before
 * any percentage is computed.
 *
 * This is not hypothetical. Rehydrating CI shard artifacts without rewriting
 * their `/home/runner/work/...` path keys makes all four `./src/...` prefixes
 * match zero files; nothing is subtracted from `global`, and the script
 * reported a passing 83.27% over a population it was never meant to gate.
 * See docs/implementation-notes/2026-08-11-coverage-gate-enrolment.md.
 *
 * WHY `global` IS HELD TO THE SAME RULE
 * ------------------------------------
 * It is tempting to exempt it. `global` is a residue ("whatever no path key
 * claimed"), not a declared path, so an empty one does not mean a typo — it
 * means the path keys partitioned the scope exhaustively, which is a coherent
 * thing for a config to do. Coherent, and still vacuous: an exhaustively
 * partitioned `global` floor applies to nothing, which is precisely the
 * silent loosening the header comment above exists to prevent. A config that
 * reaches that state is fixed by deleting the `global` key, not by tolerating
 * a floor over an empty set. So the rule stays one sentence with no exception
 * to remember — no group gates on zero files — and only the DIAGNOSIS is
 * specialised per group.
 *
 * WHY IT THROWS RATHER THAN RETURNING A FAILURE
 * ---------------------------------------------
 * An empty group means the other groups' numbers are wrong too: the files
 * that should have been subtracted are still inflating `global`. Printing a
 * table of untrustworthy percentages beside an error invites someone to read
 * the percentages. Refusing to print any number is the honest response, and
 * it matches how `assertSupportedThresholds` already refuses a config it
 * cannot evaluate.
 */
export function assertEveryGroupMatchedFiles(
    grouped: Map<string, string[]>,
    allFiles: string[],
    cwd: string,
): void {
    const empty = [...grouped.entries()]
        .filter(([, files]) => files.length === 0)
        .map(([group]) => group);
    if (empty.length === 0) return;

    const named = empty.map((group) => `"${group}"`).join(', ');
    const sample = allFiles.slice(0, 3);

    throw new Error(
        `Coverage threshold groups matched zero files: ${named}.\n` +
            `A threshold group with no files gates on nothing — it reports "ok" while ` +
            `measuring nothing, which is the exact failure this gate exists to prevent.\n` +
            `Likely causes:\n` +
            `  - the key names a path that does not exist — a typo, or a directory that ` +
            `moved or was renamed;\n` +
            `  - the shard artifacts were produced in a different checkout. Istanbul keys ` +
            `coverage by ABSOLUTE path, so a report full of /home/runner/work/... paths ` +
            `matches no "./src/..." prefix resolved against a local cwd. Rewrite the path ` +
            `keys to this checkout before gating on a downloaded artifact;\n` +
            `  - for "global" only: every covered file was claimed by a path key, so the ` +
            `global floor now applies to nothing. Delete the key or narrow the path ` +
            `groups — do not leave a floor over an empty set.\n` +
            `Prefixes were resolved against cwd ${cwd}; the merged report holds ` +
            `${allFiles.length} files.` +
            (sample.length > 0
                ? `\nFirst paths in the report:\n${sample.map((f) => `  ${f}`).join('\n')}`
                : ''),
    );
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
    const coveredFiles = map.files();
    const grouped = groupFiles(coveredFiles, config, cwd);
    // Config SHAPE is checked above; group POPULATION is checked here. Both
    // refuse before any percentage is computed, because a number derived from
    // a broken config is worse than no number.
    assertEveryGroupMatchedFiles(grouped, coveredFiles, cwd);

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

/**
 * A file's instrumentation shape — the identity of the statement map it was
 * measured against. Two entries with the same shape came from the same
 * instrumentation and their hit counts are addable; two with different shapes
 * are counts against different rulers.
 */
function shapeOf(entry: libCoverage.FileCoverageData): string {
    return createHash('sha1')
        .update(JSON.stringify(Object.values(entry.statementMap)))
        .digest('hex')
        .slice(0, 12);
}

function coveredStatements(entry: libCoverage.FileCoverageData): number {
    return Object.values(entry.s).filter((hits) => hits > 0).length;
}

export type MergeDivergence = {
    /** Files whose shards disagreed on the instrumentation shape. */
    files: number;
    /** Covered statements discarded with the minority shapes. */
    discardedCovered: number;
};

/**
 * Merge every `coverage-final.json` found under `dir` (one per shard).
 *
 * WHY THIS IS NOT `map.merge(shard)` FOUR TIMES
 * ---------------------------------------------
 * istanbul merges two entries for the same file by LOCATION: shared locations
 * add their hit counts, and a location present in only one entry is adopted
 * as-is. That is exactly right when both entries came from the same
 * instrumentation, and it is how hits from four shards accumulate.
 *
 * They do not always come from the same instrumentation. A file a shard's
 * tests never imported is enrolled by Jest's zero-fill
 * (`@jest/reporters::_addUntestedFiles`), and on CI that path yields a
 * DIFFERENT, larger statement map than the one the same file gets when a test
 * actually loads it — a strict superset, some of whose extra entries carry
 * null end-columns. Measured on run 31473460650:
 *
 *   src/app-layer/usecases/access-review-connected.ts
 *     shard 1 (a test loaded it):  69 statements, 62 covered
 *     shards 2-4 (zero-filled):   121 statements,  0 covered
 *
 * A blind location-union takes the 121 and keeps the 62 hits, reporting 51%
 * for a file that is 90% covered. Across the report that moved
 * `./src/app-layer/usecases/` from 90.55% to 75.98% with the covered-statement
 * count unchanged at 14512 — the denominator grew by 5900 on 113 files whose
 * source had not changed. 312 of 754 files carried more than one shape.
 *
 * So: group a file's entries by shape, merge WITHIN each group (hits from the
 * same ruler add up), and keep the group that observed the most coverage.
 * Hits recorded against a minority shape are discarded rather than
 * reinterpreted — there is no sound mapping between two coordinate spaces, and
 * silently adopting the larger denominator is the failure this exists to stop.
 *
 * The count of what was discarded is returned and PRINTED. A normalisation
 * nobody can see is its own kind of false green.
 */
export function mergeShardFiles(files: string[]): {
    map: libCoverage.CoverageMap;
    divergence: MergeDivergence;
} {
    const perFile = new Map<string, libCoverage.FileCoverageData[]>();
    for (const file of files) {
        const shard = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
            string,
            libCoverage.FileCoverageData
        >;
        for (const [name, entry] of Object.entries(shard)) {
            const entries = perFile.get(name);
            if (entries) entries.push(entry);
            else perFile.set(name, [entry]);
        }
    }

    const merged = libCoverage.createCoverageMap({});
    const divergence: MergeDivergence = { files: 0, discardedCovered: 0 };

    for (const [name, entries] of perFile) {
        const byShape = new Map<string, libCoverage.FileCoverageData[]>();
        for (const entry of entries) {
            const shape = shapeOf(entry);
            const group = byShape.get(shape);
            if (group) group.push(entry);
            else byShape.set(shape, [entry]);
        }

        if (byShape.size === 1) {
            // The common case: one ruler, so istanbul's own merge is correct.
            for (const entry of entries) merged.addFileCoverage(entry);
            continue;
        }

        divergence.files += 1;
        let winner: { coverage: libCoverage.FileCoverage; covered: number } | null = null;
        for (const group of byShape.values()) {
            // A fresh map per shape so istanbul merges within the shape only.
            // `addFileCoverage` wraps by reference and mutates on merge, so the
            // entries are copied — otherwise the first shape's merge rewrites
            // the data the next one reads.
            const scoped = libCoverage.createCoverageMap({});
            for (const entry of group) {
                scoped.addFileCoverage(
                    JSON.parse(JSON.stringify(entry)) as libCoverage.FileCoverageData,
                );
            }
            const coverage = scoped.fileCoverageFor(name);
            const covered = coveredStatements(coverage.data);
            if (winner === null || covered > winner.covered) {
                if (winner !== null) divergence.discardedCovered += winner.covered;
                winner = { coverage, covered };
            } else {
                divergence.discardedCovered += covered;
            }
        }
        merged.addFileCoverage(winner!.coverage);
    }

    return { map: merged, divergence };
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

    const { map, divergence } = mergeShardFiles(shardFiles);
    const config: ThresholdConfig = JSON.parse(fs.readFileSync(thresholdPath, 'utf8'));
    const results = evaluate(map, config, process.cwd());

    console.log(`Merged ${shardFiles.length} shard coverage files — ${map.files().length} files.`);
    if (divergence.files > 0) {
        // Visible on every run, not just when it is bad enough to fail: a
        // normalisation nobody can see is its own kind of false green. A
        // sudden jump here means the two instrumentation paths drifted
        // further apart, which moves the numbers below without any test
        // changing.
        console.log(
            `Normalised ${divergence.files} file(s) whose shards disagreed on the instrumentation ` +
                `shape; discarded ${divergence.discardedCovered} covered statement(s) recorded ` +
                `against a minority shape. See mergeShardFiles for why.`,
        );
    }
    console.log('');
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
