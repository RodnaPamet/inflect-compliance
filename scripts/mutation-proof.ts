/**
 * Break a guard on purpose, and refuse to report anything if the break did not
 * land (#2897).
 *
 * ═══ WHY THIS EXISTS AS A SCRIPT ═══
 *
 * A green test proves nothing on its own; what proves a guard has teeth is
 * watching it go red when the thing it watches is broken. This repo already
 * treats that as the standard — what it did not have was a harness, so every
 * mutation proof was hand-rolled, and two failure modes kept recurring:
 *
 *   1. THE PATCH SILENTLY DOES NOT APPLY. An anchor with the wrong
 *      indentation matches zero times, the sed or python step fails, and the
 *      test still runs — against unmutated source. It comes back green, which
 *      reads as "the mutation survived" when it means "no mutation happened".
 *
 *   2. THE VERDICT IS READ OFF THE WRONG LINE. Jest prints `Test Suites:` and
 *      `Tests:` adjacently and both match a naive `N failed`. Worse, a suite
 *      that fails to LOAD prints `Tests: 0 total` with no failure count at
 *      all, so a harness counting failed tests scores a run that executed
 *      nothing as a clean pass.
 *
 * Both are answered here. A patch that does not apply RAISES before any test
 * runs, so no result line can appear beneath the failure; and the verdict
 * comes from `parseJestSummary`, which reads both count lines and treats "ran
 * nothing" as its own answer.
 *
 * ── USAGE ──
 *
 *   npx tsx scripts/mutation-proof.ts <spec.json>
 *
 * where the spec is:
 *
 *   {
 *     "suites": ["tests/guards/my-guard.test.ts"],
 *     "mutations": [
 *       { "label": "guard stops reading the flag",
 *         "file": "src/thing.ts",
 *         "find": "const consented = merged.writesEnabled === true;",
 *         "replace": "const consented = true;",
 *         "expect": 2 }
 *     ]
 *   }
 *
 * `expect` is the number of tests you PREDICT will redden. It is not an
 * assertion — a mismatch is reported rather than thrown — because a wrong
 * prediction is information: fewer reds than predicted usually means a blind
 * assertion, and more usually means the mutation is broader than intended.
 *
 * Every file is restored in a `finally`, and the restore is verified by hash
 * before the next mutation runs.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseJestSummary, summaryIsGreen, summaryRanSomething } from '../tests/helpers/jest-summary';

interface Mutation {
    readonly label: string;
    readonly file: string;
    readonly find: string;
    readonly replace: string;
    readonly expect?: number;
}
interface Spec {
    readonly suites: readonly string[];
    readonly mutations: readonly Mutation[];
}

const md5 = (p: string): string => createHash('md5').update(readFileSync(p, 'utf8')).digest('hex');

function runSuites(suites: readonly string[]): { red: boolean; failed: number; ran: boolean } {
    const r = spawnSync('npx', ['jest', '--runTestsByPath', ...suites], {
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
    });
    const summary = parseJestSummary(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    return {
        red: !summaryIsGreen(summary),
        failed: summary.testsFailed || summary.suitesFailed,
        ran: summaryRanSomething(summary),
    };
}

function main(): void {
    const specPath = process.argv[2];
    if (!specPath) throw new Error('usage: tsx scripts/mutation-proof.ts <spec.json>');
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;

    const baseline = runSuites(spec.suites);
    if (!baseline.ran) throw new Error('baseline executed no tests — nothing to prove against');
    if (baseline.red) throw new Error('baseline is RED; fix that before mutating');
    console.log('  baseline: GREEN');

    const originals = new Map<string, string>();
    for (const m of spec.mutations) {
        if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
    }

    const rows: string[] = [];
    for (const m of spec.mutations) {
        const original = originals.get(m.file) as string;
        const hits = original.split(m.find).length - 1;
        if (hits !== 1) {
            // RAISE, do not continue. A result printed after this point would
            // describe a run against unmutated source.
            throw new Error(
                `${m.label}: PATCH FAILED — anchor matched ${hits} times in ${m.file}. ` +
                    'No test was run and no result is reported.',
            );
        }
        const before = md5(m.file);
        writeFileSync(m.file, original.replace(m.find, m.replace));
        if (md5(m.file) === before) throw new Error(`${m.label}: PATCH FAILED — file unchanged.`);

        let verdict: ReturnType<typeof runSuites>;
        try {
            verdict = runSuites(spec.suites);
        } finally {
            writeFileSync(m.file, original);
            if (md5(m.file) !== before) throw new Error(`${m.label}: RESTORE FAILED for ${m.file}`);
        }

        const state = !verdict.ran ? 'RAN NOTHING' : verdict.red ? 'RED' : 'GREEN — blind spot';
        const note =
            m.expect === undefined || m.expect === verdict.failed
                ? ''
                : `  (predicted ${m.expect})`;
        rows.push(`  ${state.padEnd(18)} ${String(verdict.failed).padStart(2)} failed${note}  ${m.label}`);
    }

    console.log();
    for (const r of rows) console.log(r);
    const blind = rows.filter((r) => r.includes('GREEN')).length;
    console.log();
    console.log(
        blind === 0
            ? `  every mutation reddened the suite`
            : `  ${blind} mutation(s) stayed GREEN — the guard cannot see what they broke`,
    );
}

main();
