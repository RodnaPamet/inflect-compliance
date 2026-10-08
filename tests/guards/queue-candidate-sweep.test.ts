/**
 * Guard for the orphaned-candidate sweep (#3282).
 *
 * The script this covers CANCELS CI RUNS. Getting its predicate wrong in one
 * direction wastes runners; getting it wrong in the other **reports FAILURE on
 * an operative merge-queue candidate, which ejects a healthy PR**. So the
 * asymmetry is the thing under test, not the happy path.
 *
 * The script carries its own `--self-test`, which the workflow runs before the
 * destructive step. This file exists because that self-test lives inside the
 * artefact it grades: a refactor that deleted both the predicate and its
 * fixtures would leave the workflow green. Here the fixtures are external, and
 * the workflow contract (self-test runs BEFORE --apply, `actions: write`) is
 * asserted from the YAML rather than assumed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = 'scripts/sweep-orphaned-queue-candidates.mjs';
const WORKFLOW = path.join(ROOT, '.github/workflows/queue-candidate-sweep.yml');

interface Verdict {
    runId: number;
    pr: number | null;
    base: string | null;
    verdict: 'cancel' | 'keep';
    reason: string;
}

/**
 * Drive the predicate as a SUBPROCESS, matching this repo's idiom for `.mjs`
 * scripts (`override-freshness-population.test.ts` does the same). The jest
 * `node` project is CommonJS and cannot `import` an ESM module, and the
 * alternative — duplicating the logic in TypeScript — would grade a copy rather
 * than the artefact the workflow runs.
 */
function classifyCandidates(input: {
    queuedPrNumbers: number[] | null;
    runs: Array<{ id: number; headBranch: string; createdAt: string }>;
}): Verdict[] {
    const out = execFileSync('node', [SCRIPT, '--classify'], {
        cwd: ROOT,
        input: JSON.stringify(input),
        encoding: 'utf8',
    });
    return JSON.parse(out) as Verdict[];
}

/** The script's own fixtures, run through the same binary the workflow gates on. */
function selfTest(): string[] {
    try {
        execFileSync('node', [SCRIPT, '--self-test'], { cwd: ROOT, encoding: 'utf8' });
        return [];
    } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        return [(err.stderr ?? err.stdout ?? 'self-test failed').trim()];
    }
}

const sha = (c: string): string => c.repeat(40);
const run = (id: number, pr: number, base: string, createdAt: string) => ({
    id,
    headBranch: `gh-readonly-queue/main/pr-${pr}-${base}`,
    createdAt,
});

describe('#3282 — the sweep never cancels a candidate that can still merge', () => {
    it('an UNREADABLE queue cancels nothing — unknown is not empty', () => {
        // The failure that would eject every PR in the queue at once. A GraphQL
        // error, a rate limit or a transport failure must be distinguishable
        // from "the queue is empty", and only `null` means unknown.
        const v = classifyCandidates({
            queuedPrNumbers: null,
            runs: [
                run(1, 100, sha('a'), '2026-01-01T00:00:00Z'),
                run(2, 200, sha('b'), '2026-01-01T00:01:00Z'),
            ],
        });
        expect(v).toHaveLength(2);
        expect(v.every((x) => x.verdict === 'keep')).toBe(true);
        expect(v[0].reason).toMatch(/queue-unknown/);
    });

    it('a GENUINELY empty queue does cancel — the two cases are distinct', () => {
        // The negative control for the test above. If `null` and `[]` behaved
        // the same, the assertion above would pass for the wrong reason and the
        // sweep would never cancel anything.
        const v = classifyCandidates({
            queuedPrNumbers: [],
            runs: [run(1, 100, sha('a'), '2026-01-01T00:00:00Z')],
        });
        expect(v[0].verdict).toBe('cancel');
        expect(v[0].reason).toMatch(/pr-not-in-queue/);
    });

    it('of TWO candidates for one queued PR, the newest survives and the older goes', () => {
        // The case the issue names, observed live: #3246 held candidates created
        // 12:56:33 and 12:57:48 simultaneously, and #3273 held three at once.
        // The older is as dead as an ejected run, and `base != main` cannot
        // detect it — an entry at position N is built on main plus the N-1
        // entries ahead, so no single expected base exists.
        const v = classifyCandidates({
            queuedPrNumbers: [333],
            runs: [
                run(10, 333, sha('b'), '2026-01-01T00:00:00Z'),
                run(11, 333, sha('c'), '2026-01-01T00:01:00Z'),
                run(12, 333, sha('d'), '2026-01-01T00:00:30Z'),
            ],
        });
        const kept = v.filter((x) => x.verdict === 'keep');
        expect(kept).toHaveLength(1);
        expect(kept[0].runId).toBe(11);
        expect(v.filter((x) => x.verdict === 'cancel')).toHaveLength(2);
    });

    it('the RECORDED incident from the live API classifies correctly', () => {
        // RECORDED, NOT HAND-BUILT, and that distinction is the whole lesson.
        // The hand-built fixtures composed refs as `pr-<n>-<base>` with a
        // different base per run, so a same-ref pair was UNREPRESENTABLE — the
        // mutation proof certified a branch over inputs production never
        // produces. The real population always contained the counterexample:
        // this repo puts three workflows on every `merge_group` candidate.
        //
        // These are the two actual runs from the 2026-10-08 incident, pulled
        // from the API. Regenerate with:
        //   gh api repos/<o>/<r>/actions/runs/<id> --jq '{id,name,headBranch:.head_branch,createdAt:.created_at}'
        const fx = JSON.parse(
            fs.readFileSync(
                path.join(ROOT, 'tests/guards/fixtures/merge-group-same-ref-3277.json'),
                'utf-8',
            ),
        ) as {
            queuedPrNumbers: number[];
            runs: Array<{ id: number; name: string; headBranch: string; createdAt: string }>;
            expect: { cancel: number; keep: number };
        };

        // The fixture must actually contain the shape it claims to, or it grades
        // nothing — two runs, DIFFERENT workflows, IDENTICAL ref.
        expect(fx.runs).toHaveLength(2);
        expect(new Set(fx.runs.map((r) => r.headBranch)).size).toBe(1);
        expect(new Set(fx.runs.map((r) => r.name)).size).toBe(2);
        expect(fx.runs.map((r) => r.name).sort()).toEqual(['CI', 'Integration Stress']);

        const v = classifyCandidates({
            queuedPrNumbers: fx.queuedPrNumbers,
            runs: fx.runs.map((r) => ({
                id: r.id,
                headBranch: r.headBranch,
                createdAt: r.createdAt,
            })),
        });
        expect(v.filter((x) => x.verdict === 'cancel')).toHaveLength(fx.expect.cancel);
        expect(v.filter((x) => x.verdict === 'keep')).toHaveLength(fx.expect.keep);
    });

    it('SEVERAL WORKFLOWS ON ONE REF are all kept — the case that broke a PR', () => {
        // THE REGRESSION. A merge-group candidate fans out across several
        // workflows on the SAME ref — measured, 33 refs in this repo carry
        // `CI`, `Integration Stress` and `Bundle Analyze` apiece. The original
        // predicate compared RUN IDS (`newest.id !== r.id`), so it kept one
        // sibling and called the rest superseded. When `CI` was among the
        // losers, cancelling it reported FAILURE on the live entry and took
        // #3277 to UNMERGEABLE while it merged cleanly onto main.
        //
        // The old fixtures could not express this: they built every ref as
        // `pr-<n>-<base>` with a DIFFERENT base per run, so a same-ref pair was
        // unrepresentable and the suite was green over a case that cannot occur.
        const sameRef = sha('f');
        const v = classifyCandidates({
            queuedPrNumbers: [777],
            runs: [
                run(100, 777, sameRef, '2026-01-01T00:00:00Z'),
                run(101, 777, sameRef, '2026-01-01T00:00:00Z'),
                run(102, 777, sameRef, '2026-01-01T00:00:01Z'),
            ],
        });
        expect(v.filter((x) => x.verdict === 'keep')).toHaveLength(3);
        expect(v.filter((x) => x.verdict === 'cancel')).toHaveLength(0);
    });

    it('the newest REF keeps every run on it, and a slow sibling cannot reorder refs', () => {
        // Supersession is a property of REFS, not runs. The old ref here has a
        // sibling that started LATER than anything on the new ref, so comparing
        // the latest run per PR would rank the old ref newest and cancel the
        // live candidate's three runs instead.
        const v = classifyCandidates({
            queuedPrNumbers: [888],
            runs: [
                run(200, 888, sha('0'), '2026-01-01T00:00:00Z'),
                run(201, 888, sha('0'), '2026-01-01T00:00:09Z'), // slow, OLD ref
                run(202, 888, sha('1'), '2026-01-01T00:00:05Z'),
                run(203, 888, sha('1'), '2026-01-01T00:00:05Z'),
                run(204, 888, sha('1'), '2026-01-01T00:00:06Z'),
            ],
        });
        expect(v.filter((x) => x.verdict === 'keep')).toHaveLength(3);
        expect(v.filter((x) => x.verdict === 'cancel')).toHaveLength(2);
        const byId = new Map(v.map((x) => [x.runId, x]));
        const verdictOf = (id: number): string => {
            const hit = byId.get(id);
            if (hit === undefined) throw new Error(`no verdict for run ${id}`);
            return hit.verdict;
        };
        expect(verdictOf(201)).toBe('cancel');
        expect(verdictOf(204)).toBe('keep');
    });

    it('ties on createdAt still leave exactly one survivor', () => {
        // A strict `>` on a timestamp alone never fires on equal values, so both
        // would be kept — or, with the comparison inverted, both cancelled. The
        // id breaks the tie, which makes the order total.
        const v = classifyCandidates({
            queuedPrNumbers: [666],
            runs: [
                run(50, 666, sha('0'), '2026-01-01T00:00:00Z'),
                run(51, 666, sha('1'), '2026-01-01T00:00:00Z'),
            ],
        });
        // COUNT IS NOT ENOUGH, and a mutation run proved it: deleting the
        // `r.id > prev.id` tie-break still leaves exactly one survivor — the
        // WRONG one (the first seen rather than the highest id). Asserting the
        // length alone passed against the broken predicate.
        const kept = v.filter((x) => x.verdict === 'keep');
        expect(kept).toHaveLength(1);
        expect(kept[0].runId).toBe(51);
    });

    it('an unrecognised ref is kept, not swept', () => {
        // A ref-format change upstream would otherwise turn this sweep into an
        // outage. Never cancel what you cannot identify.
        const v = classifyCandidates({
            queuedPrNumbers: [],
            runs: [
                { id: 40, headBranch: 'refs/heads/main', createdAt: '2026-01-01T00:00:00Z' },
                { id: 41, headBranch: 'gh-readonly-queue/main/pr-x-nope', createdAt: '2026-01-01T00:00:00Z' },
            ],
        });
        expect(v.every((x) => x.verdict === 'keep')).toBe(true);
        expect(v[0].reason).toMatch(/unparseable-ref/);
    });

    it('the operative candidate of a queued PR is kept even when others are swept', () => {
        // The combined shape, which is what the live tree actually looks like:
        // one merged PR's leftover, one superseded sibling, one live entry.
        const v = classifyCandidates({
            queuedPrNumbers: [3273, 3276],
            runs: [
                run(1, 3264, sha('a'), '2026-01-01T00:00:00Z'), // merged, leftover
                run(2, 3273, sha('b'), '2026-01-01T00:01:00Z'), // superseded
                run(3, 3273, sha('c'), '2026-01-01T00:02:00Z'), // operative
                run(4, 3276, sha('d'), '2026-01-01T00:02:00Z'), // operative
            ],
        });
        const byId = new Map(v.map((x) => [x.runId, x]));
        // Throws rather than returning undefined: a missing run id means the
        // predicate dropped an input, which should fail loudly and by name
        // rather than as `Object is possibly undefined`.
        const verdictOf = (id: number): string => {
            const hit = byId.get(id);
            if (hit === undefined) throw new Error(`no verdict returned for run ${id}`);
            return hit.verdict;
        };
        expect(verdictOf(1)).toBe('cancel');
        expect(verdictOf(2)).toBe('cancel');
        expect(verdictOf(3)).toBe('keep');
        expect(verdictOf(4)).toBe('keep');
    });

    it("the script's own self-test passes, and is reachable from here", () => {
        // Not redundant with the above: this asserts the fixtures the WORKFLOW
        // gates on actually pass, so the two cannot drift apart.
        expect(selfTest()).toEqual([]);
    });
});

describe('#3282 — the workflow contract', () => {
    const yml = fs.readFileSync(WORKFLOW, 'utf-8');

    it('grants actions: write and nothing broader', () => {
        expect(yml).toMatch(/^\s*actions:\s*write$/m);
        expect(yml).toMatch(/^\s*contents:\s*read$/m);
        expect(yml).not.toMatch(/^\s*contents:\s*write$/m);
    });

    it('runs --self-test BEFORE --apply', () => {
        // Order is the whole safety argument: if --apply could run first, a
        // broken predicate would reach the cancel call.
        //
        // MATCHED ON THE `run:` LINES, not on the raw text. A mutation run that
        // moved the self-test step AFTER the sweep left this test green, because
        // `indexOf('--self-test')` found the mention in this workflow's own
        // DOCBLOCK — which sits above both steps and never moves. The needle was
        // reading a comment about the safety property rather than the property.
        const runLines = yml
            .split('\n')
            .map((l, i) => ({ l: l.trim(), i }))
            .filter((x) => x.l.startsWith('run:') || x.l.startsWith('- run:'));
        const selfTestLine = runLines.find((x) => x.l.includes('--self-test'));
        const applyLine = runLines.find((x) => x.l.includes('--apply'));
        expect(selfTestLine).toBeDefined();
        expect(applyLine).toBeDefined();
        expect(selfTestLine!.i).toBeLessThan(applyLine!.i);
    });

    it('is driven by an event that FIRES, and NOT by pull_request', () => {
        // REWRITTEN (#3291, round 2). This assertion used to read:
        //
        //     expect(yml).toMatch(/schedule:/);
        //     expect(yml).toMatch(/cron:/);
        //
        // which asserts a cron EXISTS and never that it can RUN. It passed
        // over `*/15 * * * *`, which fired zero times, and then over
        // `7,37 * * * *`, which also fired zero times — two rounds of #3291
        // with this guard green throughout. Capable of failing, aimed one
        // level off the thing that mattered.
        //
        // The comment it carried is also now false. It said "ejection and
        // supersession fire no webhook at all, so the schedule was always
        // going to be the real trigger". True of `pull_request`; false of
        // `workflow_run`, which observes a CI run reaching a conclusion and
        // therefore sees all three orphan sources. That is why the sweep is
        // now event-driven with the cron demoted to a daily floor.
        //
        // Cadence is enforced centrally, over every cron in the repo, by
        // `tests/guardrails/merge-queue-trigger-coverage.test.ts`. Here the
        // subject is narrower: this workflow must not be schedule-ONLY again,
        // because its value is latency and a human-only fallback cannot
        // deliver it at 3am.
        expect(yml).toMatch(/schedule:/);
        expect(yml).toMatch(/cron:/);
        expect(yml).toMatch(/^\s*workflow_run:/m);

        // The ABSENCE is the assertion. A `pull_request` trigger here publishes
        // a check context that the merge queue waits for on the merge_group
        // candidate and that this workflow would never produce — the hang
        // invariant in `tests/guardrails/merge-queue-trigger-coverage.test.ts`.
        // I added that trigger first and the guard caught it; pinning it so the
        // same mistake cannot be made again by someone optimising latency.
        expect(yml).not.toMatch(/^\s*pull_request:/m);
    });

    it('does not set cancel-in-progress true on itself', () => {
        // A sweep cancelling its own predecessor mid-flight would leave half the
        // orphans alive and report success.
        expect(yml).not.toMatch(/cancel-in-progress:\s*true/);
    });
});
