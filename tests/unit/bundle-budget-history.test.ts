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
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    BUDGET_FILE,
    budgetHistory,
    budgetTrendLines,
    parseBudgets,
} from '../helpers/bundle-budget-history';

/**
 * A SYNTHETIC REPOSITORY, BECAUSE CI HAS NO HISTORY.
 *
 * The first version of these tests read THIS repo's history and passed locally
 * and failed in CI — `actions/checkout` clones one commit for every job but
 * Build, and `tests/unit` runs in the Test shards. Giving six shards a full
 * clone to satisfy a test is the wrong trade, and making the assertions
 * tolerate an empty history would mean they assert nothing where they run.
 *
 * So the git reading is exercised against a repository this test builds: two
 * commits that move a budget, in a temp directory. It is deterministic, it does
 * not depend on this repo's own log, and it works in a shallow checkout.
 */
function synthRepo(versions: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-history-'));
    const run = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    run('init', '-q');
    run('config', 'user.email', 't@t.test');
    run('config', 'user.name', 't');
    run('config', 'commit.gpgsign', 'false');
    versions.forEach((content, n) => {
        fs.mkdirSync(path.join(dir, 'tests', 'guardrails'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'tests/guardrails/bundle-size-budget.test.ts'), content);
        run('add', '-A');
        run('commit', '-q', '-m', `v${n}`, `--date=2026-01-0${n + 1}T00:00:00`);
    });
    return dir;
}

const budgetsSrc = (dashboard: number) =>
    `const BUDGETS_KB: Record<string, number> = {\n    'dashboard': ${dashboard},\n    'static': 100,\n};\n`;

describe('budgetHistory — reading past budgets out of git', () => {
    let repo = '';
    let file = '';
    beforeAll(() => {
        repo = synthRepo([budgetsSrc(600), budgetsSrc(610), budgetsSrc(616)]);
        file = path.join(repo, 'tests/guardrails/bundle-size-budget.test.ts');
    });
    afterAll(() => {
        if (repo) fs.rmSync(repo, { recursive: true, force: true });
    });

    it('recovers every version, with real numbers in them', () => {
        const history = budgetHistory(12, file, repo);

        // A COUNT, not "did not throw". The first draft of the helper carried
        // an extension rewrite left over from using `__filename`, which turned
        // the path into `…budget.test.test.ts`; git matched nothing and the
        // function returned [] on a FULL clone while printing its
        // shallow-checkout notice. "Did not throw" was true the whole time.
        expect(history).toHaveLength(3);
        expect(history.map((h) => h.budgets.dashboard)).toEqual([600, 610, 616]);
        for (const v of history) {
            expect(v.sha).toMatch(/^[0-9a-f]{7,}$/);
            expect(v.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    it('returns oldest first, so a trend reads left to right', () => {
        const dates = budgetHistory(12, file, repo).map((h) => h.date);
        expect([...dates].sort()).toEqual(dates);
    });

    it('honours the limit, so the window is bounded', () => {
        expect(budgetHistory(2, file, repo)).toHaveLength(2);
    });

    it('reads nothing, rather than throwing, where there is no history', () => {
        // The shallow-checkout case, which is the normal state in every job but
        // Build — and the state that made the first version of this file red in
        // CI and green here.
        expect(budgetHistory(12, path.join(repo, 'no-such-file.ts'), repo)).toEqual([]);
    });
});

describe('budgetTrendLines — the slide, where the gate reports it', () => {
    let repo = '';
    let file = '';
    beforeAll(() => {
        repo = synthRepo([budgetsSrc(600), budgetsSrc(610), budgetsSrc(616)]);
        file = path.join(repo, 'tests/guardrails/bundle-size-budget.test.ts');
    });
    afterAll(() => {
        if (repo) fs.rmSync(repo, { recursive: true, force: true });
    });

    it('shows a moved budget as a trajectory with a raise count', () => {
        const lines = budgetTrendLines(['dashboard'], file, repo);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('600 -> 610 -> 616');
        expect(lines[0]).toMatch(/2 raises since \d{4}-\d{2}-\d{2}/);
    });

    it('says nothing about a bucket that never moved', () => {
        // `static` is 100 in all three versions, so it costs no line — which
        // keeps the block readable when one budget slides and four do not.
        const lines = budgetTrendLines(['static'], file, repo);
        expect(lines).toEqual(['  (no budget changed in the history read — nothing is sliding)']);
    });

    it('names the shallow checkout instead of printing a trend it does not have', () => {
        const lines = budgetTrendLines(['dashboard'], path.join(repo, 'no-such-file.ts'), repo);
        expect(lines.join('\n')).toContain('shallow checkout');
        expect(lines.join('\n')).toContain('fetch-depth: 0');
    });

    it('aims at the real guardrail by default', () => {
        expect(BUDGET_FILE).toContain(path.join('tests', 'guardrails', 'bundle-size-budget.test.ts'));
    });
});

describe('parseBudgets — a comment must not be read as a budget', () => {
    it('reads the real map', () => {
        const src = `const BUDGETS_KB: Record<string, number> = {\n    'dashboard': 616,\n    'risks': 653,\n};`;
        expect(parseBudgets(src)).toEqual({ dashboard: 616, risks: 653 });
    });

    it('IGNORES a budget quoted in a comment, which is this file\'s own habit', () => {
        // The assertion `budgetHistory` cannot make, because its source comes
        // from git and the decoy has to be inside it. Dropping `codeOf` passed
        // all seven other tests; this is the one that fails for it.
        const src = [
            'const BUDGETS_KB: Record<string, number> = {',
            "    // was 'dashboard': 610 before #4025 raised it",
            "    /* and 'risks': 999 in an older draft */",
            "    'dashboard': 616,",
            '};',
        ].join('\n');
        expect(parseBudgets(src)).toEqual({ dashboard: 616 });
    });

    it('reads nothing from a file with no such map', () => {
        expect(parseBudgets('const SOMETHING_ELSE = 1;')).toEqual({});
    });
});
