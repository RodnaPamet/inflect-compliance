/**
 * AN EXECUTOR THAT COMPUTES A REFUSAL MUST REPORT ONE (#3591).
 *
 * `makeResult` derives the whole success/failure verdict from an argument it is
 * allowed not to receive:
 *
 *     success: outcome ? outcome.status !== 'ERROR' : true,
 *
 * So a call site that omits the eighth argument reports `success: true` no
 * matter what its usecase decided, and `recordJobMetrics` in the same file
 * counts that run as a successful one. There is no type error, no lint warning,
 * and nothing in the diff that looks like a verdict being thrown away.
 *
 * ═══ WHY THE RULE IS NOT "EVERY EXECUTOR MUST PASS AN OUTCOME" ═══
 *
 * Because that would be wrong for most of them. Twenty-four of the fifty-four
 * call sites are dispatchers and sweeps with no refusal vocabulary — a fan-out
 * that enqueued nine children has nothing to say beyond "nine", and inventing a
 * JobOutcome for it would be ceremony. A guard demanding one everywhere would
 * be satisfied by `status: 'PASSED'` hard-coded at every site, which is the
 * current behaviour with more words.
 *
 * The rule is narrower and it is the one the defect actually broke: **if the
 * usecase handed back a refusal or a status and the call site put it in
 * `details`, the call site knows the run might not have passed, and must say so
 * in the outcome.** `legacy-reconcile` carried `refusal: r.refusal` and
 * `status: r.status` into `details` and then reported success — the information
 * was in hand and dropped one argument short.
 *
 * ═══ WHAT IT COST TO NOT HAVE THIS ═══
 *
 * The first production run of `legacy-reconcile` refused `NO_FRESH_ROSTER`,
 * wrote `IntegrationExecution: PARTIAL` with the reason, and logged "job
 * processed successfully" in the same breath. Two surfaces disagreeing about one
 * run, with the operator-facing one correct and the metric wrong. It took a
 * proving run to notice, because no test can see a missing argument whose
 * default is the happy answer.
 *
 * `legacy-access-pull`, registered forty lines earlier, maps its refusal
 * properly and explains why in a comment. The two siblings of one feature
 * disagreed, which is the shape this guard exists to keep from recurring.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const REGISTRY = 'src/app-layer/jobs/executor-registry.ts';

/**
 * Keys in `details` that mean "the usecase told me this might not be a pass".
 *
 * `status` is included and is the broadest of the three. That is deliberate: a
 * call site putting a usecase's status into `details` has the verdict in hand,
 * and whether it is `'RESOLVED' | 'REFUSED'` or something else is exactly what
 * the outcome argument is for.
 */
const SIGNAL_KEYS = ['refusal', 'refusalReason', 'status'] as const;

interface CallSite {
    readonly jobName: string;
    readonly argCount: number;
    readonly detailsArg: string;
    readonly carriesSignal: boolean;
}

/**
 * Split every `makeResult(...)` call into its TOP-LEVEL arguments.
 *
 * A depth walk rather than a regex, because `details` is an object literal
 * full of commas and a regex counting them would read the first `,` inside
 * `{ executionId: ... }` as the end of the argument. Strings are not tracked
 * separately — a `(`, `)` or `,` inside a string literal would skew the walk —
 * and that is checked rather than assumed: `finds every call site` below pins
 * the count, and `the walk agrees with a hand count` pins the argument counts
 * of two known sites.
 */
function callSites(source: string): CallSite[] {
    const out: CallSite[] = [];
    let from = 0;
    for (;;) {
        const k = source.indexOf('makeResult(', from);
        if (k < 0) break;
        from = k + 1;

        const named = /makeResult\(\s*'([^']+)'/.exec(source.slice(k, k + 80));
        const jobName = named ? named[1] : '(not a literal)';

        const bounds: Array<[number, number]> = [];
        let depth = 0;
        let last = 0;
        let j = k + 'makeResult'.length;
        for (; j < source.length; j += 1) {
            const c = source[j];
            if (c === '(' || c === '[' || c === '{') {
                depth += 1;
                if (depth === 1) last = j + 1;
            } else if (c === ')' || c === ']' || c === '}') {
                depth -= 1;
                if (depth === 0) {
                    bounds.push([last, j]);
                    break;
                }
            } else if (c === ',' && depth === 1) {
                bounds.push([last, j]);
                last = j + 1;
            }
        }

        const args = bounds.map(([a, b]) => source.slice(a, b));
        const detailsArg = args.length >= 7 ? args[6] : '';
        const carriesSignal = SIGNAL_KEYS.some((key) =>
            new RegExp(String.raw`(^|[{,\s])${key}\s*:`).test(detailsArg)
        );
        out.push({ jobName, argCount: args.length, detailsArg, carriesSignal });
    }
    return out;
}

const source = codeOf(readFileSync(path.join(__dirname, '..', '..', REGISTRY), 'utf8'));
const sites = callSites(source);
const signalling = sites.filter((s) => s.carriesSignal);
const offenders = signalling.filter((s) => s.argCount < 8);

describe('an executor that computes a refusal must report one', () => {
    it('finds every call site, so the rule below ranges over the real population', () => {
        // The denominator, printed. A walker that silently stopped matching
        // would make the rule pass over nothing — and this file is the only
        // thing standing between that and a green build.
        expect({
            callSites: sites.length,
            carryingASignal: signalling.length,
            withoutASignal: sites.length - signalling.length,
        }).toEqual({
            callSites: 54,
            carryingASignal: 10,
            withoutASignal: 44,
        });
    });

    it('the walk agrees with a hand count on two known sites', () => {
        // Proves the depth walk counts ARGUMENTS and not commas. `details` on
        // both of these is a multi-key object literal, so a comma-counting
        // implementation would report far more than eight.
        const pull = sites.find((s) => s.jobName === 'legacy-access-pull');
        const reconcile = sites.find((s) => s.jobName === 'legacy-reconcile');
        expect(pull?.argCount).toBe(8);
        expect(reconcile?.argCount).toBe(8);
    });

    it('no signalling call site omits its outcome', () => {
        expect(offenders.map((s) => `${s.jobName} (${String(s.argCount)} args)`)).toEqual([]);
    });

    it('both halves of the legacy-access feature are in the signalling set', () => {
        // The pair that disagreed. Naming them keeps the regression specific:
        // if either stops carrying its status into `details`, this fails and
        // says which, rather than the count quietly dropping to 9.
        const names = signalling.map((s) => s.jobName);
        expect(names).toContain('legacy-access-pull');
        expect(names).toContain('legacy-reconcile');
    });

    it('NEGATIVE CONTROL — the detector catches a seven-argument signalling call', () => {
        // Without this the three assertions above are green on a detector that
        // can no longer detect anything. The synthetic source is the exact
        // shape of the #3591 defect: a refusal carried into `details`, no
        // eighth argument.
        const synthetic = `
            executorRegistry.register('made-up-job', async () => {
                const r = await runSomething();
                return makeResult('made-up-job', startedAt, startMs, r.n, r.n, 0, {
                    executionId: r.executionId,
                    status: r.status,
                    refusal: r.refusal,
                });
            });
        `;
        const found = callSites(synthetic);
        expect(found).toHaveLength(1);
        expect(found[0].jobName).toBe('made-up-job');
        expect(found[0].argCount).toBe(7);
        expect(found[0].carriesSignal).toBe(true);
    });

    it('NEGATIVE CONTROL — and does NOT flag a seven-argument call with no signal', () => {
        // The other direction, so the rule cannot drift into "every executor
        // must pass an outcome", which would be wrong for 44 of the 54.
        const synthetic = `
            return makeResult('a-dispatcher', startedAt, startMs, n, n, 0, {
                enqueued: n,
                tenantIds: ids,
            });
        `;
        const found = callSites(synthetic);
        expect(found).toHaveLength(1);
        expect(found[0].argCount).toBe(7);
        expect(found[0].carriesSignal).toBe(false);
    });
});
