/**
 * Whose fault was a merge-queue candidate's red? (#3307)
 *
 * WHY THIS IS A MODULE AND NOT INLINE YAML
 * ────────────────────────────────────────
 * `queue-failure-attribution.yml` shipped the reporting fix #3307 asked for and
 * is live. What it had never done is RUN: measured 2026-10-25 over the last 100
 * workflow runs, 16 CI runs were on `gh-readonly-queue/...` candidate refs and
 * ZERO of them failed, so the `if:` never admitted one. Every decision below sat
 * in an inline `actions/github-script` body, unreachable by any test, waiting for
 * a first execution that would also be the first time anybody read its output —
 * which is the position #3307 exists to get out of.
 *
 * So the decisions live here, where a test can reach them, and the workflow keeps
 * only what genuinely needs the API: listing jobs, reading their logs, listing
 * the PR's files, and posting the comment.
 *
 * THE STRINGS ARE COPIED, NOT REWRITTEN. This extraction must not change a
 * single rendered character — `tests/unit/queue-failure-attribution.test.ts`
 * pins the sentences, so a later edit to the wording is a visible diff against
 * an assertion rather than a silent change to what a PR owner reads.
 *
 * WHAT IT MUST NEVER DO
 * ─────────────────────
 * Nothing. It returns a string. The workflow's safety argument — asserted by
 * `tests/guards/ci-pipeline-integrity.test.ts` — is that it cannot cancel,
 * eject, dequeue, re-run or merge, so the worst outcome of a misread is a
 * misleading sentence. Keeping the logic pure is what makes that argument
 * checkable: a module that returns text has no power to take.
 */

/**
 * The merge-queue candidate ref: `gh-readonly-queue/<base>/pr-<n>-<sha>`.
 *
 * Parsed rather than assumed. An unrecognised ref means we do not know whose PR
 * this is, and guessing would put a sentence on somebody else's.
 */
const CANDIDATE_REF =
    /^gh-readonly-queue\/(?<base>.+)\/pr-(?<pr>\d+)-(?<sha>[0-9a-f]+)$/;

/**
 * A jest failure line: `FAIL node tests/integration/x.test.ts`.
 *
 * The runner label is optional because the three projects print different ones
 * (`node`, `jsdom`, `flue`) and a shard prints none for a suite it could not
 * load.
 */
const FAIL_LINE = /\bFAIL\s+(?:node|jsdom|flue)?\s*(tests\/[^\s]+)/;

/** `{ base, pr, sha }`, or null when the ref is not a candidate ref. */
function parseCandidateRef(ref) {
    const m = CANDIDATE_REF.exec(ref ?? '');
    if (!m) return null;
    return { base: m.groups.base, pr: Number(m.groups.pr), sha: m.groups.sha };
}

/** Every `tests/...` path a log blames, de-duplicated, in first-seen order. */
function failingTestFiles(logText) {
    const out = [];
    const seen = new Set();
    for (const line of String(logText ?? '').split('\n')) {
        const m = FAIL_LINE.exec(line);
        if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            out.push(m[1]);
        }
    }
    return out;
}

/**
 * Which sentence applies. Separated from the rendering so the DECISION can be
 * asserted without matching prose.
 *
 * `CANCELLED` wins over everything: a cancelled run reports `failure` to GitHub,
 * so reading its job list as test results is the specific misattribution item 3
 * of #3307 names.
 *
 * `UNREADABLE` and `NO_FAIL_LINE` are kept apart deliberately. Both yield "no
 * file comparison was possible", but one means the logs were gone and the other
 * means the logs were read and contained no assertion failure — an OOM, a setup
 * step, an infrastructure error. Collapsing them would report an absence of
 * evidence as evidence of innocence.
 */
function verdictOf({ cancelled, failingFiles, changedFiles, logsReadable }) {
    if (cancelled) return 'CANCELLED';
    const failing = failingFiles ?? [];
    if (failing.length === 0) return logsReadable === false ? 'UNREADABLE' : 'NO_FAIL_LINE';
    const changed = new Set(changedFiles ?? []);
    const touched = failing.filter((f) => changed.has(f));
    if (touched.length === 0) return 'OUTSIDE_DIFF';
    return 'IN_DIFF';
}

/** The comment body. Pure: every figure it needs is an argument. */
function attributionBody(input) {
    const {
        ref,
        runUrl,
        conclusion,
        baseBranch,
        failingFiles = [],
        changedFiles = [],
        logsReadable = true,
        failedJobs = [],
        stillRunningCount = 0,
    } = input;

    const changedSet = new Set(changedFiles);
    const touched = failingFiles.filter((f) => changedSet.has(f));
    const untouched = failingFiles.filter((f) => !changedSet.has(f));
    const verdict = verdictOf({ cancelled: conclusion === 'cancelled', failingFiles, changedFiles, logsReadable });

    const lines = [];
    lines.push('### Merge-queue candidate did not pass');
    lines.push('');
    lines.push(`This PR's \`Test\` check may read red. That red belongs to a **merge-queue candidate**, not to a run of your branch. Candidate: [\`${ref}\`](${runUrl}) → \`${conclusion}\`.`);
    lines.push('');

    if (verdict === 'CANCELLED') {
        lines.push('**The candidate was CANCELLED, which is not a failing test.** A cancelled merge-queue run reports `failure` to GitHub, and the Queue Candidate Sweep cancels candidates whose queue entry is already gone. If your entry was removed for another reason, that removal is the cause and this cancellation is a consequence of it.');
    } else if (verdict === 'NO_FAIL_LINE') {
        lines.push('**No `FAIL <path>` line was found in the failed jobs\' logs**, so this was probably not an assertion failure — an OOM (exit 134), a setup step, or an infrastructure error. The failing jobs are listed below; their logs are the next place to look.');
    } else if (verdict === 'UNREADABLE') {
        lines.push('**The failed jobs\' logs could not be read**, so no comparison against your diff was possible. This is not evidence either way about your changes.');
    } else if (verdict === 'OUTSIDE_DIFF') {
        lines.push(`**Every failing suite is outside this PR's diff.** The failing ${untouched.length === 1 ? 'suite is' : 'suites are'} not among the ${changedFiles.length} file(s) this PR changes, so the most likely causes are a queue-mate's changes, the base the candidate was built on, or infrastructure — not this diff.`);
        lines.push('');
        lines.push('Failing, and untouched by this PR:');
        for (const f of untouched.slice(0, 10)) lines.push(`- \`${f}\``);
    } else if (verdict === 'IN_DIFF') {
        lines.push(`**At least one failing suite IS in this PR's diff**, so this one is worth reading as yours:`);
        for (const f of touched.slice(0, 10)) lines.push(`- \`${f}\``);
        if (untouched.length) {
            lines.push('');
            lines.push('Also failing, but outside the diff:');
            for (const f of untouched.slice(0, 10)) lines.push(`- \`${f}\``);
        }
    }

    if (failedJobs.length) {
        lines.push('');
        lines.push('Failed jobs:');
        for (const j of failedJobs.slice(0, 12)) lines.push(`- [${j.name}](${j.html_url}) — \`${j.conclusion}\``);
    }
    if (stillRunningCount) {
        lines.push('');
        lines.push(`${stillRunningCount} job(s) were still running when the candidate ended — a candidate can be ejected before its siblings finish, so a short job list here is not the whole picture.`);
    }
    lines.push('');
    lines.push(`Base: \`${baseBranch}\`. Why the entry left the queue is recorded on this PR's **timeline** as \`removed_from_merge_queue\` — not in its checks, which is the gap #3307 exists for.`);
    lines.push('');
    lines.push('<sub>Posted by Queue Failure Attribution (#3307). This workflow only comments — it cannot eject, cancel or merge anything.</sub>');

    return lines.join('\n');
}

/** One comment per candidate RUN, so a re-run of the workflow updates it. */
const markerFor = (runId) => `<!-- queue-failure-attribution:${runId} -->`;

module.exports = {
    CANDIDATE_REF,
    FAIL_LINE,
    parseCandidateRef,
    failingTestFiles,
    verdictOf,
    attributionBody,
    markerFor,
};
