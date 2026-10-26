/**
 * The merge-queue attribution decisions (#3307).
 *
 * These ran for the first time here. The workflow that holds them shipped in
 * #4085 and is live, but measured 2026-10-25 over the last 100 workflow runs,
 * 16 CI runs were on `gh-readonly-queue/...` candidate refs and ZERO failed — so
 * its `if:` had never admitted one and none of this had ever executed. The first
 * real ejection would have been both the first run of the code and the first
 * time a PR owner read its output.
 *
 * So the point of this suite is not coverage. It is that the sentence a PR owner
 * gets at the worst moment is not also the first evidence that the code works.
 *
 * THE PROSE IS PINNED ON PURPOSE. Extracting the logic out of inline YAML must
 * not change a rendered character, and "I copied it carefully" is not a check.
 * A later reword is then a visible diff against an assertion rather than a
 * silent change to what somebody reads while being told their PR failed.
 */

import {
    attributionBody,
    failingTestFiles,
    markerFor,
    parseCandidateRef,
    verdictOf,
} from '../../scripts/lib/queue-failure-attribution.js';

describe('parseCandidateRef', () => {
    it('reads the PR number, base and sha out of a candidate ref', () => {
        expect(parseCandidateRef('gh-readonly-queue/main/pr-4313-0f3b66e2abcd')).toEqual({
            base: 'main',
            pr: 4313,
            sha: '0f3b66e2abcd',
        });
    });

    it('keeps a base branch that itself contains slashes', () => {
        // `.+` for the base, not `[^/]+`: a queue on `release/2.0` produces
        // `gh-readonly-queue/release/2.0/pr-1-abc`, and a greedy-but-anchored
        // base is what keeps the pr/sha tail intact.
        expect(parseCandidateRef('gh-readonly-queue/release/2.0/pr-7-deadbeef')).toEqual({
            base: 'release/2.0',
            pr: 7,
            sha: 'deadbeef',
        });
    });

    it('returns null for anything that is not a candidate ref', () => {
        // The live case: a `workflow_run` on main. Returning null is what stops
        // the job putting a sentence on somebody else's PR.
        for (const ref of ['main', 'fix/3307', '', undefined, 'gh-readonly-queue/main/pr-x-abc']) {
            expect(parseCandidateRef(ref as string)).toBeNull();
        }
    });
});

describe('failingTestFiles', () => {
    it('reads every runner label jest prints, and none', () => {
        const log = [
            'FAIL node tests/integration/a.test.ts',
            'FAIL jsdom tests/rendered/b.test.tsx',
            'FAIL flue tests/flue/c.test.ts',
            'FAIL tests/unit/d.test.ts',
        ].join('\n');
        expect(failingTestFiles(log)).toEqual([
            'tests/integration/a.test.ts',
            'tests/rendered/b.test.tsx',
            'tests/flue/c.test.ts',
            'tests/unit/d.test.ts',
        ]);
    });

    it('de-duplicates, because jest prints each suite-level failure twice', () => {
        // Not a hypothesis: miscounting those doubled lines as separate suites
        // is a mistake made while draining #3343.
        const log = 'FAIL node tests/a.test.ts\nFAIL node tests/a.test.ts';
        expect(failingTestFiles(log)).toEqual(['tests/a.test.ts']);
    });

    it('finds nothing in a log with no FAIL line, and does not throw on empty input', () => {
        expect(failingTestFiles('Tests: 9282 passed\nexit code 134')).toEqual([]);
        expect(failingTestFiles('')).toEqual([]);
        expect(failingTestFiles(undefined as unknown as string)).toEqual([]);
    });
});

describe('verdictOf', () => {
    it('treats a cancellation as its own answer, ahead of every other signal', () => {
        // Item 3 of #3307. A cancelled run reports `failure` to GitHub, so a
        // cancelled candidate WITH failing files must not read as a test
        // failure — the cancellation is the cause.
        expect(verdictOf({
            cancelled: true,
            failingFiles: ['tests/a.test.ts'],
            changedFiles: ['tests/a.test.ts'],
            logsReadable: true,
        })).toBe('CANCELLED');
    });

    it('separates "logs unreadable" from "logs read, no assertion failed"', () => {
        // Both produce no file comparison, and collapsing them would report an
        // absence of evidence as evidence of innocence.
        expect(verdictOf({ cancelled: false, failingFiles: [], changedFiles: [], logsReadable: false })).toBe('UNREADABLE');
        expect(verdictOf({ cancelled: false, failingFiles: [], changedFiles: [], logsReadable: true })).toBe('NO_FAIL_LINE');
    });

    it('says OUTSIDE_DIFF only when NO failing suite is in the diff', () => {
        expect(verdictOf({
            cancelled: false,
            failingFiles: ['tests/integration/bowtie-api.test.ts'],
            changedFiles: ['docs/sub-processors.md'],
            logsReadable: true,
        })).toBe('OUTSIDE_DIFF');
    });

    it('says IN_DIFF as soon as ONE failing suite is in the diff', () => {
        // Asymmetric on purpose: one of yours failing is yours to read, however
        // many of a queue-mate's also failed.
        expect(verdictOf({
            cancelled: false,
            failingFiles: ['tests/a.test.ts', 'tests/b.test.ts'],
            changedFiles: ['tests/b.test.ts'],
            logsReadable: true,
        })).toBe('IN_DIFF');
    });
});

describe('attributionBody', () => {
    const base = {
        ref: 'gh-readonly-queue/main/pr-3246-abc123',
        runUrl: 'https://github.com/o/r/actions/runs/99',
        conclusion: 'failure',
        baseBranch: 'main',
        logsReadable: true,
        failedJobs: [],
        stillRunningCount: 0,
    };

    it('always names the candidate rather than the branch', () => {
        const body = attributionBody({ ...base, failingFiles: [], changedFiles: [] });
        expect(body).toContain('### Merge-queue candidate did not pass');
        expect(body).toContain(
            "That red belongs to a **merge-queue candidate**, not to a run of your branch.",
        );
        expect(body).toContain('[`gh-readonly-queue/main/pr-3246-abc123`](https://github.com/o/r/actions/runs/99)');
    });

    it('renders #3307\'s worked example: a docs diff blamed for a bow-tie suite', () => {
        // The real one. #3246 was a four-file documentation diff ejected on
        // `tests/integration/bowtie-api.test.ts`, and two sessions spent part of
        // a day establishing what this paragraph says.
        const body = attributionBody({
            ...base,
            failingFiles: ['tests/integration/bowtie-api.test.ts'],
            changedFiles: [
                'docs/_status/doc-classification.json',
                'docs/legacy-access-recertification-design.md',
                'docs/legacy-access-recertification-phases.md',
                'docs/sub-processors.md',
            ],
        });
        expect(body).toContain("**Every failing suite is outside this PR's diff.**");
        expect(body).toContain('The failing suite is not among the 4 file(s) this PR changes');
        expect(body).toContain('- `tests/integration/bowtie-api.test.ts`');
        expect(body).not.toContain('IS in this PR');
    });

    it('pluralises the suite count, since the singular reads as a bug', () => {
        const body = attributionBody({
            ...base,
            failingFiles: ['tests/a.test.ts', 'tests/b.test.ts'],
            changedFiles: ['docs/x.md'],
        });
        expect(body).toContain('The failing suites are not among the 1 file(s)');
    });

    it('owns the failure when a failing suite IS in the diff, and still lists the rest', () => {
        const body = attributionBody({
            ...base,
            failingFiles: ['tests/mine.test.ts', 'tests/theirs.test.ts'],
            changedFiles: ['tests/mine.test.ts'],
        });
        expect(body).toContain("**At least one failing suite IS in this PR's diff**");
        expect(body).toContain('- `tests/mine.test.ts`');
        expect(body).toContain('Also failing, but outside the diff:');
        expect(body).toContain('- `tests/theirs.test.ts`');
    });

    it('says a cancellation is not a failing test', () => {
        const body = attributionBody({ ...base, conclusion: 'cancelled', failingFiles: [], changedFiles: [] });
        expect(body).toContain('**The candidate was CANCELLED, which is not a failing test.**');
        expect(body).not.toContain('outside this PR');
    });

    it('distinguishes unreadable logs from a clean log with no FAIL line', () => {
        const unreadable = attributionBody({ ...base, failingFiles: [], changedFiles: [], logsReadable: false });
        expect(unreadable).toContain("**The failed jobs' logs could not be read**");
        expect(unreadable).toContain('This is not evidence either way about your changes.');

        const noFail = attributionBody({ ...base, failingFiles: [], changedFiles: [], logsReadable: true });
        expect(noFail).toContain('**No `FAIL <path>` line was found');
        expect(noFail).toContain('an OOM (exit 134), a setup step, or an infrastructure error');
    });

    it('reports jobs still running, because a candidate can be ejected before its siblings finish', () => {
        const body = attributionBody({
            ...base,
            failingFiles: [],
            changedFiles: [],
            failedJobs: [{ name: 'Ratchets', html_url: 'https://x/1', conclusion: 'failure' }],
            stillRunningCount: 4,
        });
        expect(body).toContain('- [Ratchets](https://x/1) — `failure`');
        expect(body).toContain('4 job(s) were still running when the candidate ended');
    });

    it('points at the timeline, which is where the removal reason actually is', () => {
        const body = attributionBody({ ...base, failingFiles: [], changedFiles: [] });
        expect(body).toContain('recorded on this PR\'s **timeline** as `removed_from_merge_queue`');
        expect(body).toContain('it cannot eject, cancel or merge anything');
    });

    it('caps the file lists, so a shard-wide failure cannot post a wall', () => {
        const many = Array.from({ length: 25 }, (_, i) => `tests/f${i}.test.ts`);
        const body = attributionBody({ ...base, failingFiles: many, changedFiles: [] });
        expect(body).toContain('- `tests/f9.test.ts`');
        expect(body).not.toContain('- `tests/f10.test.ts`');
    });
});

describe('markerFor', () => {
    it('keys the comment on the candidate run, so a re-run updates rather than appends', () => {
        expect(markerFor(12345)).toBe('<!-- queue-failure-attribution:12345 -->');
    });
});
