/**
 * BullMQ custom job ids: the rule, mirrored safely, and nobody hand-rolling one.
 *
 * #3554 — scheduled control tests did not run in production for SEVEN AND A
 * HALF DAYS. `control-test-scheduler` hand-rolled
 * `jobId = ctr:{planId}:{scheduledForIso}`; the ISO timestamp's own colons
 * pushed the id to five colon-separated segments, and BullMQ threw
 * `Custom Id cannot contain :` on every enqueue — about 4,300 of them, 24 an
 * hour, unbroken.
 *
 * THE SAME DEFECT HAD ALREADY HAPPENED ONCE. #2175 ("the leaver dispatch has
 * never enqueued a single pass") diagnosed it, documented the rule in
 * `fan-out.ts`, and encoded the lesson as `split(':')).toHaveLength(3)` in the
 * two dispatch tests it fixed. It was never turned into a property of the
 * codebase, so the one enqueue site that did not use the helper kept its bug.
 *
 * AND THE RULE IS ABOUT TO GET STRICTER. The installed BullMQ carries its own
 * note directly above the check:
 *
 *     // TODO: replace this check in next breaking check with include(':')
 *     // By using split we are still keeping compatibility with old repeatable jobs
 *
 * So the three-segment carve-out is scheduled for removal, which means
 * `dispatchJobId`'s two-colon format — eight call sites — breaks on BullMQ's
 * next major. That is why `scheduledJobId` is colon-free rather than merely
 * three-segment, and why the needle below pins the `!== 3`: the day it goes,
 * this test fails and gives notice, instead of production doing it again.
 *
 * Three things are held here, because the first alone guarantees a third
 * occurrence:
 *
 *   1. OUR PREDICATE STILL MATCHES THE INSTALLED LIBRARY. A hand-written mirror
 *      of a dependency's rule goes stale with nothing failing.
 *   2. THE PREDICATE ACTUALLY REJECTS THE REAL ID. The exact string production
 *      rejected is in the table below.
 *   3. NO ENQUEUE SITE BUILDS AN ID BY HAND. A template literal is how both
 *      occurrences were written.
 */

import * as fs from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import { dispatchJobId, isValidBullMqJobId, scheduledJobId } from '@/app-layer/jobs/fan-out';

describe('our predicate still matches the installed BullMQ (#3554)', () => {
    // ASKED OF NODE, NOT SPELLED. The first cut of this file joined the repo
    // root to a literal `node_modules/...` path, and
    // `dependency-paths-are-resolved` rejected it — correctly, and for a better
    // reason than the one I would have given:
    //
    //   a literal string join does no upward walk, so such a path exists only
    //   in a checkout that owns its install. A `.claude/worktrees/<id>/`
    //   checkout has no `node_modules` of its own, so these fail — OR, WORSE,
    //   SKIP THEMSELVES GREEN BEHIND AN `existsSync` GUARD — for worktree users
    //   while passing in CI.
    //
    // That second clause described this file exactly: it read the source
    // through `existsSync(p) ? read(p) : ''`, so in a worktree every needle
    // below would have matched nothing and PASSED, and the one thing this guard
    // exists to notice — BullMQ changing its rule — would have gone unnoticed
    // in precisely the checkouts most sessions run in.
    //
    // `require.resolve` walks up, honours the package's `exports` map, and
    // THROWS when the file is absent rather than yielding a falsy default. The
    // throw is the feature: a guard that cannot find its subject must fail,
    // not pass quietly.
    const jobJsPath = require.resolve('bullmq/dist/cjs/classes/job.js');
    // MASKED, and this file is the reason the rule exists rather than an
    // incidental application of it. `raw-source-assertion-ratchet` holds that
    // an assertion over unmasked source can be satisfied by a COMMENT, so
    // "delete the code, keep the note explaining it" is a green diff — and the
    // very lines this guard reads are:
    //
    //     // TODO: replace this check in next breaking check with include(':')
    //     // By using split we are still keeping compatibility with old
    //     // repeatable jobs
    //     if (jobId.includes(':') && jobId.split(':').length !== 3) { throw }
    //
    // A note saying the check is going, sitting directly above the check. If
    // BullMQ removed the `if` and left the comment, an unmasked read would
    // still find `include(':')` in the prose and this guard would report that
    // the rule is unchanged — the precise inversion it exists to prevent.
    //
    // `codeOf` blanks comments, keeps string literals (so the thrown message
    // is still matchable) and preserves offsets.
    const src = codeOf(fs.readFileSync(jobJsPath, 'utf8'));

    it('reads a real, substantial copy of the library source', () => {
        // The denominator for every needle below. An empty read now throws, but
        // a TRUNCATED one would satisfy some needles and not others, which is
        // harder to diagnose than a hard failure.
        expect(src.length).toBeGreaterThan(1000);
        expect(jobJsPath).toContain('bullmq');
    });

    it('is reading CODE, not prose — the TODO above the check is masked out', () => {
        // The mask, proved rather than trusted. BullMQ's own comment contains
        // `include(':')`, one character from the needle below it, so a mask
        // that silently stopped working would not be visible in any other
        // assertion here.
        expect(src).not.toContain('next breaking check');
        expect(src).toContain("'Custom Id cannot contain :'");
    });

    it('still rejects on exactly the condition we mirror', () => {
        // The shape, not the formatting: minified or re-emitted output changes
        // whitespace and temp-variable names, so the assertion names the two
        // operations that decide the rule.
        expect(src).toContain("'Custom Id cannot contain :'");
        expect(src).toMatch(/jobId\.includes\(':'\)/);
        // THE THREE IS THE WHOLE RULE. If BullMQ ever bans colons outright —
        // which its error message reads as though it intends to — this needle
        // goes and this test fails, which is the notice we want. `dispatchJobId`
        // emits exactly two colons and would stop working that day.
        // The `)` in the middle is TypeScript's optional-chaining downlevel
        // emit (`(_e = …?.jobId) === null ? void 0 : _e?.split(':').length) !== 3`),
        // not formatting slack — the needle tolerates it rather than
        // pretending the shipped text is the authored text.
        expect(src).toMatch(/split\(':'\)\.length\)?\s*!==\s*3/);
    });

    it('agrees with the library on every id shape we can construct', () => {
        // A differential check rather than a restatement: the expectation is
        // computed from the rule as the library states it, so this fails if our
        // predicate drifts from it in either direction.
        const cases: readonly string[] = [
            'plain',
            'ctr-abc-1760000000000',
            'a:b:c',
            'a:b',
            'a:b:c:d',
            // The real #3554 id, with a real cuid and a real ISO instant.
            'ctr:cmosxcqt0000abcd1234bxyi:2026-10-07T09:09:37.694Z',
            ':',
            '::',
            ':::',
            'a::b',
        ];
        const libraryWouldAccept = (id: string) => !(id.includes(':') && id.split(':').length !== 3);
        // Mapped rather than looped so a failure prints every disagreement at
        // once, and so the subject is not a for-of binding.
        expect(cases.map((id) => [id, isValidBullMqJobId(id)])).toEqual(
            cases.map((id) => [id, libraryWouldAccept(id)]),
        );
    });

    it('rejects the id that caused the outage, and accepts its replacement', () => {
        // The two strings the incident actually turned on, asserted directly —
        // so this file names what it is about even if every needle above is
        // rewritten.
        const planId = 'cmosxcqt0000abcd1234bxyi';
        const instant = Date.parse('2026-10-07T09:09:37.694Z');
        expect(isValidBullMqJobId(`ctr:${planId}:${new Date(instant).toISOString()}`)).toBe(false);
        expect(isValidBullMqJobId(scheduledJobId('ctr', planId, instant))).toBe(true);
    });
});

describe('both id factories emit ids BullMQ accepts (#3554)', () => {
    it('scheduledJobId is colon-free, so it survives a stricter BullMQ', () => {
        // Stronger than "valid today": the three-segment carve-out is a
        // back-compat accident, and an id with no colon at all does not depend
        // on it continuing to exist.
        const id = scheduledJobId('ctr', 'cmosxcqt0000abcd1234bxyi', 1760000000000);
        expect(id).not.toContain(':');
        expect(isValidBullMqJobId(id)).toBe(true);
    });

    it('scheduledJobId carries the instant, so two runs of one plan differ', () => {
        // The dedupe contract. A factory that dropped the instant would make
        // every run of a plan the same job and silently skip all but the first
        // — a quieter version of the same outage.
        const a = scheduledJobId('ctr', 'plan1', 1760000000000);
        const b = scheduledJobId('ctr', 'plan1', 1760000060000);
        expect(a).not.toEqual(b);
    });

    it('scheduledJobId refuses a colon-bearing key instead of emitting a bad id', () => {
        // The reintroduction path: a caller passing a composite key is exactly
        // how #2175 happened at the leaver dispatch.
        expect(() => scheduledJobId('ctr', 'tenant:plan', 1760000000000)).toThrow(/colon/);
        expect(() => scheduledJobId('a:b', 'plan', 1760000000000)).toThrow(/colon/);
    });

    it('scheduledJobId refuses a non-finite instant', () => {
        // `new Date(undefined).getTime()` is NaN, which would otherwise produce
        // the id `ctr-plan1-NaN` — valid, stable, and wrong for every run.
        expect(() => scheduledJobId('ctr', 'plan1', Number.NaN)).toThrow(/finite/);
    });

    it('dispatchJobId still emits exactly three segments', () => {
        // The format #2175 settled on. Asserted here too because this file is
        // where the rule lives now, and because a change to that format must
        // fail somewhere that explains why.
        const id = dispatchJobId('identity-sync', 'conn1', 86_400_000, 1760000000000);
        expect(id.split(':')).toHaveLength(3);
        expect(isValidBullMqJobId(id)).toBe(true);
    });
});

describe('no enqueue site builds a job id by hand (#3554)', () => {
    /**
     * The population: every `.ts` under `src/`, comments masked.
     *
     * Masking matters here more than usual — `fan-out.ts`, `queue.ts`,
     * `control-test-scheduler.ts` and this rule's own prose all quote the
     * broken id in their docstrings, which is the "a scar is not a wound"
     * failure: the hits would all be explanations of the fix.
     */
    const sources = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).map((abs) => ({
        rel: repoRelative(abs),
        code: codeOf(fs.readFileSync(abs, 'utf8')),
    }));

    it('has a population to scan at all', () => {
        // The denominator. A guard whose scan returns nothing passes every
        // assertion below while covering no code.
        expect(sources.length).toBeGreaterThan(200);
        // And the file this rule is about is really in it.
        expect(sources.map((f) => f.rel)).toContain('src/app-layer/jobs/control-test-scheduler.ts');
    });

    it('assigns no jobId from a template literal or a concatenation', () => {
        // THE RULE, AND WHY IT IS SPELLED THIS WAY. Both occurrences of this
        // defect were written as a template literal:
        //
        //     jobId: `ctr:${plan.id}:${scheduledForIso}`
        //     jobId: dispatchJobId(`${tenantId}:${provider}`, …)   ← #2175
        //
        // A legitimate site passes a factory CALL (`dispatchJobId(…)`,
        // `scheduledJobId(…)`) or an identifier (`job.id` in an API response,
        // `z.string()` in a DTO). None of those start with a backtick or a
        // quote, and none need a `+`. So "the value is literal text" is exactly
        // the hand-rolling ban, and it does not need to know which sites are
        // enqueues.
        const offenders: string[] = [];
        for (const file of sources) {
            const lines = file.code.split('\n');
            lines.forEach((line, i) => {
                const m = /\bjobId:\s*(.+)$/.exec(line);
                if (!m) return;
                const value = m[1].trim();
                const literal = value.startsWith('`') || value.startsWith("'") || value.startsWith('"');
                const concatenated = /^[`'"].*\+/.test(value);
                if (literal || concatenated) offenders.push(`${file.rel}:${i + 1}  ${value.slice(0, 70)}`);
            });
        }
        // Compared as an array so the failure NAMES every site rather than
        // stopping at a count.
        expect(offenders).toEqual([]);
    });
});
