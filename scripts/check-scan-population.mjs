#!/usr/bin/env node
/**
 * The Ratchets job really ran the population it is supposed to run (#4426).
 *
 * WHY THIS IS NOT A JEST TEST. Every other check on this population is one,
 * and that is the defect. `tests/guardrails/coverage-gate-population.test.ts`
 * pins the `scan` project's `testPathIgnorePatterns` by exact equality — the
 * right mechanism — and it lives INSIDE the population it protects. Add
 * `'tests/guardrails/.*'` to that list and, measured on #4395:
 *
 *     scan population      810 -> 585 files
 *     the pinning suite    "0 matches"
 *     the Ratchets job     green
 *
 * 225 suites stop running and stop feeding the merged coverage total, and the
 * assertion written to prevent exactly that is excluded by the same pattern.
 * A second pin in `tests/guards/` means a single-directory exclusion always
 * leaves one running, but that is defence in depth, not a fix: every in-jest
 * pin can be removed by a jest-level pattern. This script is outside jest, so
 * no pattern can reach it.
 *
 * WHAT IT ASSERTS, AND WHY IN THIS SHAPE.
 *
 *   1. Every declared directory contributed at least one suite. This needs no
 *      baseline and never goes stale, and it is what catches the realistic
 *      lever: one pattern naming one directory.
 *   2. The total meets a floor. This catches a PARTIAL cut, which (1) cannot
 *      see.
 *
 * A single total floor would NOT have been enough on its own, which is the
 * measurement that chose this shape: `tests/contracts` holds 2 files of 810.
 * Excluding it costs 0.2% of the population, so any floor loose enough to
 * survive normal churn is also loose enough to let that exclusion through — a
 * gate too narrow to ever fire for a third of the directories it covers.
 *
 * The floor is a LOWER bound, so adding tests never requires touching it. It
 * needs lowering only when suites are deliberately removed, and that edit is
 * the written decision this exists to force.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Directories the `scan` project owns. Each must contribute ≥1 suite. */
const REQUIRED_DIRS = ['tests/guards', 'tests/guardrails', 'tests/contracts'];

/**
 * Measured 810 on 2026-10-29 (583 guards + 225 guardrails + 2 contracts).
 * Lower it only alongside a note saying which suites went and why.
 */
const TOTAL_FLOOR = 800;

const resultsPath = process.argv[2];
if (!resultsPath) {
    console.error('usage: check-scan-population.mjs <jest --outputFile JSON>');
    process.exit(2);
}

// An unreadable file must FAIL, never pass quietly: a check that did not run
// is absent, not green, and absence is what this whole script is about.
let parsed;
try {
    parsed = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
} catch (err) {
    console.error(
        `::error title=Ratchets population unverifiable::could not read ${resultsPath} ` +
            `(${err.message}). The Jest step must run with ` +
            `\`--json --outputFile=<path>\` BEFORE this check, and a missing file is a ` +
            `failure rather than a pass — otherwise this script's own absence reads as success.`,
    );
    process.exit(1);
}

const names = (parsed.testResults ?? []).map((t) => String(t.name ?? ''));
const total = names.length;

// Vacuity guard on our own parse: `numTotalTestSuites` and the array length
// are produced independently by jest, so a disagreement means we are reading
// the wrong shape rather than a smaller population.
const declared = Number(parsed.numTotalTestSuites ?? -1);
if (declared !== total) {
    console.error(
        `::error title=Ratchets population unreadable::numTotalTestSuites=${declared} ` +
            `but testResults holds ${total} entries. The report shape changed; fix this ` +
            `script rather than the floor.`,
    );
    process.exit(1);
}

const perDir = new Map(REQUIRED_DIRS.map((d) => [d, 0]));
for (const n of names) {
    const rel = n.split(path.sep).join('/');
    for (const d of REQUIRED_DIRS) {
        if (rel.includes(`/${d}/`)) perDir.set(d, perDir.get(d) + 1);
    }
}

// Always print the numbers, pass or fail — a floor nobody can see is a floor
// nobody re-derives.
console.log('Ratchets population actually executed:');
for (const d of REQUIRED_DIRS) console.log(`  ${d.padEnd(20)} ${perDir.get(d)}`);
console.log(`  ${'TOTAL'.padEnd(20)} ${total}  (floor ${TOTAL_FLOOR})`);

const empty = REQUIRED_DIRS.filter((d) => perDir.get(d) === 0);
const failures = [];
if (empty.length > 0) {
    failures.push(
        `${empty.length} declared director${empty.length === 1 ? 'y' : 'ies'} contributed ZERO ` +
            `suites: ${empty.join(', ')}. Something removed them from the \`scan\` project — ` +
            `check its \`testMatch\` and \`testPathIgnorePatterns\`, and the job's own flags. ` +
            `If a directory was deliberately retired, drop it from REQUIRED_DIRS here in the ` +
            `same change.`,
    );
}
if (total < TOTAL_FLOOR) {
    failures.push(
        `only ${total} suites ran, below the floor of ${TOTAL_FLOOR}. Either something narrowed ` +
            `the population, or suites were deliberately removed — in which case lower the floor ` +
            `here with a note saying which went and why.`,
    );
}

if (failures.length > 0) {
    for (const f of failures) console.error(`::error title=Ratchets population shrank::${f}`);
    process.exit(1);
}
console.log(`OK: all ${REQUIRED_DIRS.length} directories present, total at or above the floor.`);
