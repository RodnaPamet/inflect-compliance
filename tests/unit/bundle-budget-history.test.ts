/**
 * THE BUDGET'S HISTORY, SO A FOURTH BUMP DOES NOT READ AS THE FIRST (#4044).
 *
 * `bundle-size-budget` derives headroom at run time (#4041), which fixed the
 * rot the `measured max` comments had three times — but a derived percentage
 * still shows one number at a time, so the fourth consecutive dependency bump
 * to eat the headroom reads exactly like the first. Three bumps crossed these
 * budgets inside two days, each consuming what the last left, and two sessions
 * independently read their own encounter as a one-off because nothing in the
 * file could show a trend.
 *
 * The history comes from GIT rather than a generated file, because a stored
 * number beside its own source is the trap that file is a monument to.
 *
 * ── WHY THIS LIVES HERE AND NOT IN THE GUARDRAIL ───────────────────────────
 *
 * `bundle-size-budget` SKIPS unless a production `.next` is present, which is
 * true only in the Build job. Anything asserted inside it is unasserted
 * everywhere else, so the helper is a module and this is its test.
 */
import * as path from 'path';

import {
    BUDGET_FILE,
    budgetHistory,
    budgetTrendLines,
} from '../helpers/bundle-budget-history';

describe('budgetHistory — reading past budgets out of git', () => {
    it('recovers real versions, with real numbers in them', () => {
        const history = budgetHistory();

        // A COUNT, not "did not throw". The first draft of this helper carried
        // an extension rewrite left over from using `__filename`, which turned
        // the path into `…budget.test.test.ts`; git matched nothing and the
        // function returned [] on a full clone while printing its
        // shallow-checkout notice. "Did not throw" was true the whole time.
        expect(history.length).toBeGreaterThanOrEqual(2);

        for (const version of history) {
            expect(version.sha).toMatch(/^[0-9a-f]{7,}$/);
            expect(version.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            // Every recovered value is a positive integer KB, which is what
            // proves the comment-stripping worked: this file's prose is full of
            // figures like "read 574.4 KB" and a raw regex would catch them.
            for (const kb of Object.values(version.budgets)) {
                expect(Number.isInteger(kb)).toBe(true);
                expect(kb).toBeGreaterThan(0);
            }
        }
    });

    it('returns oldest first, so a trend reads left to right', () => {
        const dates = budgetHistory().map((h) => h.date);
        expect([...dates].sort()).toEqual(dates);
    });

    it('reads nothing, rather than throwing, where there is no history', () => {
        // The shallow-checkout case. `actions/checkout` defaults to one commit,
        // so this is the normal state in every job but Build.
        const history = budgetHistory(12, path.join(__dirname, 'no-such-file-ever.ts'));
        expect(history).toEqual([]);
    });
});

describe('budgetTrendLines — the slide, where the gate reports it', () => {
    it('shows a moved budget as a trajectory with a raise count', () => {
        const lines = budgetTrendLines(['dashboard']);
        expect(lines).toHaveLength(1);
        // `->` between values, and a count — the two things a single
        // percentage could never say.
        expect(lines[0]).toMatch(/dashboard\s+\d+( -> \d+)+/);
        expect(lines[0]).toMatch(/\d+ raises? since \d{4}-\d{2}-\d{2}/);
    });

    it('says nothing about a bucket that never moved', () => {
        // A bucket with no history in the window costs no line, so the block
        // stays readable when one budget is sliding and four are not.
        const lines = budgetTrendLines(['a-bucket-that-never-existed']);
        expect(lines).toEqual(['  (no budget changed in the history read — nothing is sliding)']);
    });

    it('names the shallow checkout instead of printing a trend it does not have', () => {
        const lines = budgetTrendLines(['dashboard'], path.join(__dirname, 'no-such-file-ever.ts'));
        expect(lines.join('\n')).toContain('shallow checkout');
        expect(lines.join('\n')).toContain('fetch-depth: 0');
    });

    it('aims at the real guardrail by default', () => {
        // A default pointing anywhere else would make every assertion above
        // true of the wrong file.
        expect(BUDGET_FILE).toContain(path.join('tests', 'guardrails', 'bundle-size-budget.test.ts'));
    });
});
