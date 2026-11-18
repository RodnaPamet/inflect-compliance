#!/usr/bin/env node
/**
 * Fail when a commit in a range carries an email GitHub could credit to a
 * stranger — as author, committer, or `Co-authored-by:` trailer.
 *
 * The rule and the incident behind it are in `./lib/commit-identities.js`.
 *
 * Usage (from the repository root):
 *   node scripts/check-commit-identities.mjs <base> <head>
 *
 * Checks the commits reachable from <head> and not from <base>, i.e. the
 * commits a pull request (or a merge-queue candidate) would add to <base>.
 * Exits 0 when every identity passes, 1 when one does not, 2 on a usage or git
 * error. Annotates each failure for GitHub Actions and, when
 * $GITHUB_STEP_SUMMARY is set, writes a table to the job summary.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import identities from './lib/commit-identities.js';

const { findIdentityProblems, parseGitLog, GIT_LOG_FORMAT } = identities;

const [base, head] = process.argv.slice(2);
if (!base || !head) {
    console.error('usage: node scripts/check-commit-identities.mjs <base> <head>');
    process.exit(2);
}

let raw;
try {
    raw = execFileSync('git', ['log', `--format=${GIT_LOG_FORMAT}`, `${base}..${head}`], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
} catch (err) {
    console.error(`::error title=Commit identities::could not read ${base}..${head}: ${err.message}`);
    process.exit(2);
}

const commits = parseGitLog(raw);
const problems = findIdentityProblems(commits);

const escape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
/** A markdown table cell: backslashes first, so the `|` escape cannot be undone; no line breaks. */
const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

for (const p of problems) {
    console.log(
        `::error title=Unclaimable ${p.role} email::${escape(
            `${p.sha.slice(0, 9)} "${p.subject}" — ${p.role} ${p.name} <${p.email}>: ${p.reason}`,
        )}`,
    );
}

const fix = [
    'Set a real address before committing again, e.g. your GitHub noreply address',
    '(Settings → Emails): `git config user.email "<id>+<login>@users.noreply.github.com"`.',
    'Then rewrite this branch\'s commits with it:',
    '`git rebase --exec "git commit --amend --no-edit --reset-author" <base>` and force-push the branch,',
    'and correct any `Co-authored-by:` line by hand (`git rebase -i` → reword).',
];

if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['## Commit identities', ''];
    if (problems.length === 0) {
        lines.push(`All identities on ${commits.length} commit(s) pass.`);
    } else {
        lines.push(
            `${problems.length} identity(ies) on ${commits.length} commit(s) use an email anybody could claim on GitHub,`,
            'which would credit a stranger as a contributor once squash-merged.',
            '',
            '| commit | role | identity | why |',
            '| --- | --- | --- | --- |',
            ...problems.map(
                (p) => `| \`${p.sha.slice(0, 9)}\` | ${p.role} | ${cell(`${p.name} <${p.email}>`)} | ${cell(p.reason)} |`,
            ),
            '',
            ...fix,
        );
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

if (problems.length > 0) {
    console.log('');
    console.log(fix.join('\n'));
    process.exit(1);
}
console.log(`Commit identities: ${commits.length} commit(s) in ${base}..${head}, every identity passes.`);
