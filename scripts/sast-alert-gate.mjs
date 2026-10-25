#!/usr/bin/env node
/**
 * The SAST gate: a merge-queue candidate fails when the pull request it
 * carries introduced code-scanning alerts (#4047).
 *
 * Of the three static security gates, two blocked: npm audit and the Trivy
 * image scan. CodeQL blocked nothing. Neither CodeQL context can be required,
 * as `ci.yml`'s required-set notes explain: this workflow's own
 * `CodeQL SAST (<language>)` job deliberately skips the queue, and the
 * GitHub-managed `Analyze (<language>)` has no workflow file to give a
 * `merge_group` trigger, so requiring it would hang every merge. So on #4043
 * GitHub's `CodeQL` check reported a new HIGH alert, and the PR reached
 * position 1 in the queue with nothing in the pipeline able to stop it.
 *
 * This runs as a step of the `Security` job, which is already required and
 * already answers `merge_group`. It reads the signal that DID fire on #4043:
 * the `CodeQL` check run that GitHub's code-scanning app
 * (`github-advanced-security`) posts on the PR's head commit. That check is
 * GitHub's own comparison of the PR's analysis against the base branch. It
 * fails when the PR introduces alerts at or above the repository's threshold,
 * which is set under Settings → Code security, defaults to High for security
 * alerts, and was the threshold that fired on #4043. An alert that already
 * exists on `main` does not fail it, so one standing alert cannot block every
 * pull request.
 *
 * FAIL CLOSED (owner decision, 2026-10-25). Only `success` passes. A failed,
 * neutral, skipped, cancelled or stale check fails the candidate, naming the
 * conclusion. A check that is missing or still running is waited for, for up
 * to ten minutes, and then fails the candidate. A check that never ran is not
 * evidence the code is clean. When this was written the check was posted on
 * every pull request sampled, docs-only ones included, and had always finished
 * before the pull request entered the queue (44 seconds' margin at the
 * closest), so the wait should almost never be spent.
 *
 * `SAST_GATE_DEADLINE_MS` and `SAST_GATE_POLL_MS` exist for its test only.
 * `tests/guardrails/security-gate-strictness.test.ts` refuses a workflow that
 * sets either, so CI cannot shorten the wait into a near-miss.
 *
 * Run (merge queue only): node scripts/sast-alert-gate.mjs
 *   GITHUB_TOKEN           needs checks:read and pull-requests:read
 *   GITHUB_REPOSITORY      owner/repo
 *   MERGE_GROUP_HEAD_REF   github.event.merge_group.head_ref
 */

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY || '';
const TOKEN = process.env.GITHUB_TOKEN || '';
const QUEUE_REF = process.env.MERGE_GROUP_HEAD_REF || '';

/** The check GitHub's code-scanning app posts on a pull request's head. */
const CHECK_NAME = 'CodeQL';
const CHECK_APP = 'github-advanced-security';

const DEADLINE_MS = Number(process.env.SAST_GATE_DEADLINE_MS) || 10 * 60_000;
const POLL_MS = Number(process.env.SAST_GATE_POLL_MS) || 30_000;

function fail(message) {
    console.error(`::error title=SAST gate::${message}`);
    process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(pathname) {
    const res = await fetch(`${API}${pathname}`, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${TOKEN}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (!res.ok) throw new Error(`GET ${pathname} answered HTTP ${res.status}`);
    return res.json();
}

/**
 * A queue candidate's branch is `gh-readonly-queue/<base>/pr-<number>-<sha>`,
 * and `<base>` may itself contain slashes.
 */
const queued = /^(?:refs\/heads\/)?gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]{40}$/.exec(QUEUE_REF);
if (!REPO || !TOKEN) fail('GITHUB_REPOSITORY and GITHUB_TOKEN are required.');
if (!queued) {
    fail(
        `cannot tell which pull request this candidate carries: ` +
            `MERGE_GROUP_HEAD_REF is ${JSON.stringify(QUEUE_REF)}, not gh-readonly-queue/<base>/pr-<n>-<sha>.`,
    );
}
const prNumber = queued[1];

const deadline = Date.now() + DEADLINE_MS;
let waitingOn = 'nothing read yet';
let headSha = null;

while (Date.now() < deadline) {
    try {
        headSha ??= (await api(`/repos/${REPO}/pulls/${prNumber}`)).head.sha;
        const { check_runs: runs } = await api(
            `/repos/${REPO}/commits/${headSha}/check-runs?check_name=${CHECK_NAME}&filter=latest&per_page=100`,
        );
        // Another app or workflow job can be named `CodeQL` too; only the
        // code-scanning app's check carries the alert comparison.
        const ours = runs.filter((run) => run.app?.slug === CHECK_APP);
        if (ours.length === 0) {
            waitingOn = `no ${CHECK_NAME} check from ${CHECK_APP} on ${headSha.slice(0, 7)} yet`;
        } else if (ours.some((run) => run.status !== 'completed')) {
            waitingOn = `the ${CHECK_NAME} check on ${headSha.slice(0, 7)} is still ${ours.find((run) => run.status !== 'completed').status}`;
        } else {
            const notPassed = ours.filter((run) => run.conclusion !== 'success');
            if (notPassed.length > 0) {
                const what = notPassed.map((run) => `${run.conclusion} (${run.html_url})`).join(', ');
                fail(
                    `PR #${prNumber}: GitHub's ${CHECK_NAME} check on ${headSha.slice(0, 7)} concluded ${what}. ` +
                        `It fails when the pull request introduces code-scanning alerts at or above the ` +
                        `repository's threshold. Fix the alerts it lists, or dismiss them with a reason ` +
                        `in the Security tab, then queue the pull request again.`,
                );
            }
            console.log(
                `SAST gate PASSED: PR #${prNumber}'s ${CHECK_NAME} check on ${headSha.slice(0, 7)} succeeded, ` +
                    `so it introduces no code-scanning alert at or above the repository's threshold.`,
            );
            process.exit(0);
        }
    } catch (error) {
        waitingOn = `could not read it: ${error instanceof Error ? error.message : String(error)}`;
    }
    console.log(`SAST gate: waiting, ${waitingOn}.`);
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
}

fail(
    `PR #${prNumber}: no finished ${CHECK_NAME} check after ${Math.round(DEADLINE_MS / 60_000)} minutes ` +
        `(${waitingOn}). A check that never ran is not evidence the code is clean. If GitHub code ` +
        `scanning is degraded, queue the pull request again once it has posted the check.`,
);
