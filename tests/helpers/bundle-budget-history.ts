/**
 * THE BUDGET'S OWN HISTORY, READ FROM GIT (#4044).
 *
 * Extracted from `tests/guardrails/bundle-size-budget.test.ts` so it can be
 * asserted on behaviour: that guardrail SKIPS unless a production `.next` is
 * present, which is true only in the Build job, so anything living inside it is
 * untestable everywhere else.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

import { codeOf } from './source-blocks';

const ROOT = path.resolve(__dirname, '../..');
/** The file whose `BUDGETS_KB` is the subject. Overridable so a test can aim it elsewhere. */
export const BUDGET_FILE = path.join(ROOT, 'tests/guardrails/bundle-size-budget.test.ts');

/**
 * EVERY PAST VALUE OF `BUDGETS_KB`, OLDEST FIRST, FROM GIT (#4044).
 *
 * The derived headroom (#4041) fixed the rot but not the comparability: one
 * number at a time means the fourth consecutive bump to eat the headroom reads
 * exactly like the first. Three bumps crossed these budgets inside two days,
 * each consuming what the last left, and two sessions independently read their
 * own encounter as a one-off because nothing here could show a trend.
 *
 * ── WHY GIT AND NOT A STORED FILE ──────────────────────────────────────────
 *
 * A generated `bundle-headroom.json` would put the history back in a number
 * beside its own source, which is the trap this whole file is a monument to —
 * the `measured max` comments rotted three times. Git already holds every past
 * value, cannot be hand-edited into agreement, and needs nothing committed.
 *
 * ── WHY IT CAN COME BACK EMPTY, AND WHY THAT IS NOT A FAILURE ──────────────
 *
 * `actions/checkout` defaults to a one-commit shallow clone. The Build job —
 * the only one that runs this with a real `.next` present — therefore carries
 * `fetch-depth: 0`, and the reason is written at that step. Anywhere else
 * (a shallow job, a tarball, a worktree without history) this returns `[]` and
 * the caller says so rather than printing a trend it does not have.
 *
 * Bounded by COMMITS TOUCHING THIS FILE, not by a commit count: the raises of
 * #4003/#4020/#4025 sit 185-230 commits behind a main that moves ~58 commits a
 * day, so any depth number chosen today would quietly stop covering the window
 * it was picked for.
 */
export function budgetHistory(limit = 12, file: string = BUDGET_FILE): Array<{ sha: string; date: string; budgets: Record<string, number> }> {
    // NO EXTENSION REWRITING. An earlier draft carried a `.replace()` left over
    // from using `__filename` (which is `.js` after transpile); against the
    // source path it rewrote `…budget.test.ts` to `…budget.test.test.ts`, git
    // found nothing, and the function returned [] while printing the
    // shallow-checkout notice — a helper that could never succeed, on a full
    // clone. The probe that caught it is why `recovers real versions` below
    // asserts a COUNT rather than just "did not throw".
    const rel = path.relative(ROOT, file);
    let log: string;
    try {
        log = execFileSync(
            'git',
            ['log', `-n${limit}`, '--format=%H %ad', '--date=short', '--', rel],
            { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
    } catch {
        return [];
    }

    const out: Array<{ sha: string; date: string; budgets: Record<string, number> }> = [];
    for (const line of log.trim().split('\n').filter(Boolean)) {
        const [sha, date] = line.split(' ');
        let content: string;
        try {
            content = execFileSync('git', ['show', `${sha}:${rel}`], {
                cwd: ROOT,
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        } catch {
            continue; // the file did not exist, or was named differently, at that commit
        }
        // COMMENTS STRIPPED FIRST. This file's prose is full of figures like
        // "read 574.4 KB" and "measured 603.7", and a regex over raw source
        // would read them as budgets.
        const code = codeOf(content);
        const block = code.slice(code.indexOf('BUDGETS_KB'));
        const budgets: Record<string, number> = {};
        for (const m of block.slice(0, block.indexOf('};') + 1).matchAll(/'([^']+)'\s*:\s*(\d+)/g)) {
            budgets[m[1]] = Number(m[2]);
        }
        if (Object.keys(budgets).length > 0) out.push({ sha: sha.slice(0, 9), date, budgets });
    }
    return out.reverse(); // oldest first, so a trend reads left to right
}

/**
 * One line per bucket whose budget has MOVED, so a slide is visible where it
 * matters — beside the headroom, at the moment the gate reports it.
 */
export function budgetTrendLines(buckets: Iterable<string>, file: string = BUDGET_FILE): string[] {
    const history = budgetHistory(12, file);
    if (history.length < 2) {
        return [
            '  (no budget history available — shallow checkout; the Build job sets fetch-depth: 0)',
        ];
    }

    const lines: string[] = [];
    for (const bucket of [...buckets].sort()) {
        const series = history
            .map((h) => ({ date: h.date, kb: h.budgets[bucket] }))
            .filter((p): p is { date: string; kb: number } => typeof p.kb === 'number');
        if (series.length < 2) continue;

        // Only the CHANGES, so an unchanged budget costs no line.
        const changes = series.filter((p, i) => i === 0 || p.kb !== series[i - 1].kb);
        if (changes.length < 2) continue;

        const raises = changes.slice(1).filter((p, i) => p.kb > changes[i].kb).length;
        lines.push(
            `  ${bucket.padEnd(15)} ${changes.map((c) => c.kb).join(' -> ')}` +
                `  (${raises} raise${raises === 1 ? '' : 's'} since ${changes[0].date}` +
                `, over ${history.length} commits to this file)`,
        );
    }
    return lines.length > 0
        ? lines
        : ['  (no budget changed in the history read — nothing is sliding)'];
}

