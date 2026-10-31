/**
 * A test that does MONTH ARITHMETIC must not let today's date decide its verdict.
 *
 * ─── The failure this exists for ────────────────────────────────────────────
 *
 * `src/app-layer/utils/cadence.ts` records the owner's decision: "monthly"
 * means the same date next month, CLAMPED to the target month's last day, so
 * 31 January + 1 month is 28 February and not 3 March. A test that asserts the
 * UNCLAMPED day therefore agrees with the product only on days 1-28.
 *
 * It has gone wrong twice, both times expensively and both times pointing at
 * the wrong cause:
 *
 *   2026-10-05  `tests/unit/test-plan-cadence-and-bulk-gate.test.ts`
 *               false-reddened an unrelated dependency pull request (#3183)
 *               for EIGHTEEN DAYS.
 *   2026-10-31  `tests/integration/control-test-flow.test.ts` took `main` and
 *               every open pull request red — `Expected: 31, Received: 30`, in
 *               a DB test about control runs that no diff had touched (#4672).
 *
 * The second is the reason this guard exists rather than a third comment. The
 * CORRECT assertion already existed in the first file, with a comment
 * describing this exact failure mode — and the sibling three directories away
 * kept the bug for another 26 days. A comment in one file is not a guard over
 * a class. (#4673)
 *
 * It is green on roughly 353 days a year, so it cannot be found by waiting.
 *
 * ─── What this checks ──────────────────────────────────────────────────────
 *
 * Population: every file under `tests/` that makes a REAL `setMonth(...)` or
 * `addMonths(...)` CALL. Derived from git via `repoRelativeFiles()` and read
 * through the TypeScript parser, which matters more than it sounds:
 *
 *   - `tests/guards/cadence-has-one-home.test.ts` mentions `setMonth` inside
 *     STRING LITERALS and a REGEX (it is a guard *about* month arithmetic);
 *   - `tests/guards/external-write-clamp-is-pinned.test.ts` mentions
 *     `addMonthsClamped` in a COMMENT.
 *
 * A text scan flags both. `codeOf` would not help — it masks comments and
 * deliberately KEEPS string literals. Only a parse distinguishes a call from a
 * mention, so the population is AST-derived and both files are correctly out.
 *
 * For each file in the population, if it anchors on the AMBIENT clock
 * (`new Date()` with no arguments, or `Date.now()`) and does not pin it
 * (`useFakeTimers` / `setSystemTime`), then every `expect(<expr with
 * getDate()>)` assertion must compare against a CLAMPED value — in practice
 * `Math.min(anchor.getDate(), daysInTargetMonth)`, the shape both live call
 * sites now use.
 *
 * ─── What it deliberately does NOT check ───────────────────────────────────
 *
 * An ambient anchor asserted through some OTHER exact-date shape — an
 * `toISOString()` equality, say — is the same class and is not covered. That
 * would need the guard to decide which assertions are date-exact, which is a
 * much wider analysis than the one defect has earned. Named here rather than
 * left implicit: the gate covers the day-of-month shape, which is the one that
 * has actually broken twice.
 *
 * ─── Why the guard itself cannot have the bug it guards ────────────────────
 *
 * It reads SOURCE and never evaluates a date, so its verdict is the same on
 * the 31st and the 1st. That is the property #4673 asks for — "a mutation
 * proof that only bites on the 31st is the same bug one level up" — and here
 * it is structural rather than arranged: there is no clock in the detector to
 * depend on.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as ts from 'typescript';

import { repoRelativeFiles } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');

interface Facts {
    /** Real `setMonth(...)` / `addMonths(...)` calls — not mentions. */
    readonly monthCalls: number;
    /** `new Date()` with no args, or `Date.now()`. */
    readonly ambientAnchors: number;
    /** `useFakeTimers` / `setSystemTime` — the clock is pinned. */
    readonly pinsTheClock: boolean;
    /** `expect(<expr containing getDate()>)` assertions, and whether clamped. */
    readonly dayAssertions: ReadonlyArray<{ readonly line: number; readonly clamped: boolean }>;
}

/**
 * Read one file's facts off the AST.
 *
 * Exported so the detector proof at the bottom can feed it fixtures. A
 * detector that can only be run over the live tree cannot be SHOWN to work —
 * only observed not to have complained.
 */
export function factsOf(src: string, fileName = 'probe.ts'): Facts {
    const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let monthCalls = 0;
    let ambientAnchors = 0;
    let pinsTheClock = false;
    const dayAssertions: Array<{ line: number; clamped: boolean }> = [];

    const nameOf = (e: ts.Expression): string =>
        ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : '';

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const callee = nameOf(node.expression);
            if (callee === 'setMonth' || callee === 'addMonths') monthCalls++;
            if (callee === 'useFakeTimers' || callee === 'setSystemTime') pinsTheClock = true;
            if (
                callee === 'now'
                && ts.isPropertyAccessExpression(node.expression)
                && node.expression.expression.getText(sf) === 'Date'
            ) {
                ambientAnchors++;
            }
            // `expect(subject).toBe(expected)` / `.toEqual(...)`
            if (
                ts.isPropertyAccessExpression(node.expression)
                && /^(toBe|toEqual|toStrictEqual)$/.test(node.expression.name.text)
            ) {
                const recv = node.expression.expression;
                if (
                    ts.isCallExpression(recv)
                    && ts.isIdentifier(recv.expression)
                    && recv.expression.text === 'expect'
                    && recv.arguments.length === 1
                    && /\bgetDate\s*\(\s*\)/.test(recv.arguments[0].getText(sf))
                ) {
                    const expected = node.arguments.map((a) => a.getText(sf)).join(',');
                    dayAssertions.push({
                        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                        clamped: /Math\.min\s*\(/.test(expected),
                    });
                }
            }
        }
        if (
            ts.isNewExpression(node)
            && node.expression.getText(sf) === 'Date'
            && (!node.arguments || node.arguments.length === 0)
        ) {
            ambientAnchors++;
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return { monthCalls, ambientAnchors, pinsTheClock, dayAssertions };
}

/** Files under `tests/` that really do month arithmetic. */
function population(): Array<{ file: string; facts: Facts }> {
    return repoRelativeFiles()
        .filter((f) => /^tests\/.*\.tsx?$/.test(f))
        .map((f) => ({ file: f, facts: factsOf(fs.readFileSync(path.join(ROOT, f), 'utf-8'), f) }))
        .filter((e) => e.facts.monthCalls > 0);
}

describe('month arithmetic in tests is not decided by today (#4673)', () => {
    const pop = population();

    it('found a real population (the denominator is part of the result)', () => {
        // Every assertion below is satisfied by an empty population. This is
        // what makes them mean something: if the AST walk, the glob or the
        // git listing breaks, this fails instead of passing over nothing.
        //
        // Three files today: control-test-flow (integration), incident-deadlines
        // and test-plan-cadence-and-bulk-gate. A fourth joins automatically.
        expect(pop.length).toBeGreaterThanOrEqual(3);
    });

    it('every ambient-clock month-arithmetic test clamps its day-of-month assertion', () => {
        const offenders = pop
            .filter((e) => e.facts.ambientAnchors > 0 && !e.facts.pinsTheClock)
            .flatMap((e) =>
                e.facts.dayAssertions
                    .filter((a) => !a.clamped)
                    .map((a) => `${e.file}:${a.line} — asserts an exact day-of-month from an ambient `
                        + `clock. One month on from a 29th/30th/31st CLAMPS to the target month's last `
                        + `day (cadence.ts), so this agrees with the product only on days 1-28 and `
                        + `reddens the repo on the rest. Compare against `
                        + `Math.min(anchor.getDate(), daysInTargetMonth), or pin the clock.`),
            );
        expect(offenders).toEqual([]);
    });

    it('the two files that had the bug are still in the population', () => {
        // Named, not counted. If either is renamed or stops doing month
        // arithmetic, the rule above silently stops covering the two sites
        // that actually broke — which is how the 2026-10-05 fix failed to
        // reach the 2026-10-31 instance.
        const files = pop.map((e) => e.file).sort();
        expect(files).toContain('tests/integration/control-test-flow.test.ts');
        expect(files).toContain('tests/unit/test-plan-cadence-and-bulk-gate.test.ts');
    });

    describe('detector proof — synthetic sources, so a clean tree means something', () => {
        const AMBIENT_UNCLAMPED = [
            'const now = new Date();',
            'const target = new Date(now);',
            'target.setMonth(target.getMonth() + 1);',
            'expect(due.getDate()).toBe(now.getDate());',
        ].join('\n');

        const AMBIENT_CLAMPED = [
            'const now = new Date();',
            'const target = new Date(now);',
            'target.setMonth(target.getMonth() + 1);',
            'const daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();',
            'expect(due.getDate()).toBe(Math.min(now.getDate(), daysInTarget));',
        ].join('\n');

        it('flags the shape that shipped twice', () => {
            const f = factsOf(AMBIENT_UNCLAMPED);
            expect(f.monthCalls).toBe(1);
            expect(f.ambientAnchors).toBeGreaterThan(0);
            expect(f.dayAssertions.map((a) => a.clamped)).toEqual([false]);
        });

        it('accepts the clamped shape — the control that differs only in Math.min', () => {
            const f = factsOf(AMBIENT_CLAMPED);
            expect(f.monthCalls).toBe(1);
            expect(f.dayAssertions.map((a) => a.clamped)).toEqual([true]);
        });

        it('accepts a pinned clock, which needs no clamp', () => {
            const f = factsOf([
                "const anchor = new Date('2026-01-31T00:00:00.000Z');",
                'expect(addMonths(anchor, 1).getDate()).toBe(28);',
            ].join('\n'));
            expect(f.monthCalls).toBe(1);
            expect(f.ambientAnchors).toBe(0);
        });

        it('a faked clock counts as pinned even with a bare new Date()', () => {
            const f = factsOf([
                "jest.useFakeTimers().setSystemTime(new Date('2026-01-31'));",
                'const now = new Date();',
                'now.setMonth(now.getMonth() + 1);',
                'expect(now.getDate()).toBe(28);',
            ].join('\n'));
            expect(f.pinsTheClock).toBe(true);
        });

        it('a MENTION is not a call — strings, regexes and comments are out', () => {
            // The two files a text scan false-flags, reduced to their shape.
            const f = factsOf([
                "const RE = /\\.setMonth\\(/;",
                "expect(RE.test('next.setMonth(next.getMonth() + 1)')).toBe(true);",
                '// addMonths is what cadence.ts uses',
            ].join('\n'));
            expect(f.monthCalls).toBe(0);
        });

        it('the detector can return zero, so a passing case means something', () => {
            expect(factsOf('const a = 1;').monthCalls).toBe(0);
            expect(factsOf('const a = 1;').dayAssertions).toEqual([]);
        });
    });
});
