#!/usr/bin/env node
/**
 * VERIFY THAT AN INTEGRATION SUITE CAN RUN ALONE (#3336).
 *
 * `--shard=K/N` is a deterministic hash over FILE PATHS, so adding or removing
 * any test file re-partitions every shard and changes which suites share a
 * database and in what order. A suite that depends on a sibling — for a row it
 * never created, or for an `AuditLog` table that happens to be empty — then
 * passes or fails by luck, and the luck is a function of the file list. #3336
 * records three such failures on one PR, none of them in the PR's own code.
 *
 * The class is: **a suite that cannot run alone is a suite whose result depends
 * on the file list.** This script asks that question directly, one suite at a
 * time, and names the ones that cannot.
 *
 * ── WHY RUNNING A SUITE ALONE IS THE RIGHT TEST ────────────────────────────
 *
 * `tests/setup/globalSetup.ts` TEMPLATE-clones the migrated base into a fresh
 * database when Jest runs more than one worker. So a single suite run on its
 * own gets a database no other suite has touched — which is precisely the
 * precondition #3336 asks about, available without new infrastructure.
 *
 * That also explains why this class is invisible locally in the normal case:
 * running your own suite alone is the FRIENDLIEST environment, not the
 * harshest, and a long-lived scratch database makes it friendlier still by
 * accumulating the rows a sibling once created. A green local run is weak
 * evidence here, and this script is the thing that makes it strong.
 *
 * ── WHAT A FAILURE MEANS, AND WHAT IT DOES NOT ─────────────────────────────
 *
 * FAILS ALONE  →  the suite inherits state it does not create. Real defect:
 *                 it is one re-partition away from failing, and the failure
 *                 will land on a PR that did not cause it.
 * PASSES ALONE →  says nothing about whether the suite BREAKS its neighbours.
 *                 A suite that deletes a tenant other suites need passes alone
 *                 and still reddens them. That is the opposite direction and
 *                 this script cannot see it — #3343's ratchet is the instrument
 *                 for that half. Reported here so the result is not over-read.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *
 *   node scripts/verify-suite-isolation.mjs tests/integration/foo.test.ts [...]
 *   node scripts/verify-suite-isolation.mjs --at-risk [--limit N]
 *   node scripts/verify-suite-isolation.mjs --all [--limit N]
 *
 * `--at-risk` selects the population #3336 is about: suites that write audit
 * rows AND delete an audit parent. `--limit` bounds a sample, and the output
 * always prints the denominator so a sample is never mistaken for a sweep.
 *
 * Exit code is 1 if any suite failed alone, so this is usable as a gate.
 * It is NOT wired into CI by this change: running 392 suites one at a time is
 * a real cost and belongs to whoever agrees to pay it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIR = 'tests/integration';
const DELETES_AUDIT_PARENT = /\b(?:tenant|user)\.(?:deleteMany|delete)\(/;
const WRITES_AUDIT_ROWS = /from '@\/app-layer\/usecases\/|logEvent\(|runInTenantContext/;

function allSuites() {
    return execFileSync('git', ['ls-files', DIR], { encoding: 'utf8' })
        .split('\n')
        .filter((f) => f.endsWith('.test.ts'))
        .sort();
}

function atRisk() {
    return allSuites().filter((f) => {
        const s = fs.readFileSync(f, 'utf8');
        return DELETES_AUDIT_PARENT.test(s) && WRITES_AUDIT_ROWS.test(s);
    });
}

const argv = process.argv.slice(2);
const limitAt = argv.indexOf('--limit');
const limit = limitAt === -1 ? Infinity : Number(argv[limitAt + 1]);
const explicit = argv.filter((a) => a.endsWith('.test.ts'));

let population;
let populationLabel;
if (explicit.length) {
    population = explicit;
    populationLabel = `${explicit.length} named suite(s)`;
} else if (argv.includes('--at-risk')) {
    const all = atRisk();
    population = all;
    populationLabel = `${all.length} at-risk suites (write audit rows AND delete an audit parent) of ${allSuites().length} total`;
} else if (argv.includes('--all')) {
    const all = allSuites();
    population = all;
    populationLabel = `${all.length} integration suites`;
} else {
    console.error('usage: verify-suite-isolation.mjs <suite...> | --at-risk | --all [--limit N]');
    process.exit(2);
}

const selected = population.slice(0, Number.isFinite(limit) ? limit : undefined);

// THE DENOMINATOR, BESIDE THE RESULT. A sample reported as a sweep is the
// failure mode this line exists to prevent.
console.log(`population: ${populationLabel}`);
console.log(`running:    ${selected.length}${selected.length < population.length ? ` (SAMPLE of ${population.length} — not a sweep)` : ' (the whole population)'}`);
console.log('');

const failed = [];
const errored = [];
let i = 0;
for (const suite of selected) {
    i += 1;
    const label = `[${i}/${selected.length}] ${path.basename(suite)}`;
    // One suite, alone, in its own process. CI=1 as an env var rather than
    // `--ci`, which this repo's conventions require.
    const r = spawnSync('npx', ['jest', suite, '--forceExit', '--silent'], {
        env: { ...process.env, CI: '1' },
        encoding: 'utf8',
        timeout: 10 * 60_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.error || r.status === null) {
        errored.push({ suite, why: r.error ? r.error.message : `killed/timeout (signal ${r.signal})` });
        console.log(`${label}  ERRORED (no verdict)`);
        continue;
    }
    if (r.status === 0) {
        console.log(`${label}  passes alone`);
    } else {
        // Keep the first failing assertion, which is what names the inherited
        // row or the teardown that needed a sibling.
        // The first REAL assertion line. `● Console` and `● Validation Warning:`
        // are jest chrome, not findings — measured: the positive control below
        // reported "Validation Warning" as its cause, which named nothing.
        const first = out
            .split('\n')
            .find((l) => /●\s/.test(l) && !/Console|Validation Warning|Deprecation/.test(l));
        failed.push({ suite, status: r.status, first: (first ?? '').trim().slice(0, 160) });
        console.log(`${label}  FAILS ALONE (exit ${r.status})`);
        if (first) console.log(`        ${first.trim().slice(0, 160)}`);
    }
}

console.log('');
console.log(`passed alone : ${selected.length - failed.length - errored.length}/${selected.length}`);
console.log(`failed alone : ${failed.length}`);
console.log(`no verdict   : ${errored.length}  (killed or timed out — NOT a pass)`);
if (failed.length) {
    console.log('');
    console.log('Suites that cannot run alone — each inherits state it does not create:');
    for (const f of failed) console.log(`  ${f.suite}`);
}
console.log('');
console.log('NOTE: passing alone does NOT mean a suite is safe for its neighbours.');
console.log('A suite that deletes a parent others need passes here and still reddens them;');
console.log("that direction is #3343's ratchet, not this script.");

process.exit(failed.length ? 1 : 0);
