/**
 * Cadence arithmetic happens in exactly one place (#3802).
 *
 * `utils/cadence.ts` opens by declaring itself "THE ONE PLACE THIS IS DECIDED
 * (#3136)" and records the owner decision it encodes — "monthly means the same
 * date next month, and a month that does not have that date clamps to its last
 * day. 31 January + 1 month is 28 February, not 3 March."
 *
 * Nothing asserted any of that, and by the time #3802 was filed two files had
 * drifted back out:
 *
 *   · `risk-report.ts` advanced schedules with a bare `setUTCMonth`, the exact
 *     overflow that header calls "the bug" — 31 January + 1 month landed on
 *     3 MARCH, so a month-end monthly schedule became a 3rd-of-month schedule
 *     and February got no report at all.
 *   · `task-source-reconcile.ts` held `{MONTHLY: 30, QUARTERLY: 91, ...}` and
 *     added it as milliseconds — the same shape of table #3136 deleted from
 *     `automation-runner.ts`, disagreeing with it by two days on a February
 *     roll, and driving the NEEDS_REVIEW transition on real evidence.
 *
 * A prose claim that a module is the only implementation decays silently. This
 * is the check that makes it fail loudly instead.
 */
import * as fs from 'node:fs';

import { codeOf } from '../helpers/source-blocks';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { computeNextDueAt } from '@/app-layer/utils/cadence';

const CADENCE_REL = 'src/app-layer/utils/cadence.ts';

/**
 * The ONE carve-out, by name and with its reason, because a guard whose
 * exceptions are anonymous gets widened until it passes.
 *
 * `cadence.ts` itself authorises this one: "The fixed-interval TABLE survives
 * in the runner, because its other consumer is a de-duplication lookback
 * window — 'has this already run in roughly the last month?' — where a fixed
 * span is the right tool and a calendar boundary would be wrong."
 *
 * So the runner's table is NOT a second answer to "when is this next due". It
 * answers a different question, and reconciling it with the calendar would
 * make it wrong. #3792 asked whether its 90 should agree with the 91 this
 * guard's issue deleted; the answer is no, in opposite directions.
 */
const FLAT_TABLE_CARVE_OUT = 'src/app-layer/jobs/automation-runner.ts';

const REMEDY =
    'Cadence arithmetic belongs in utils/cadence.ts and nowhere else (#3136, #3802). ' +
    'Call computeNextDueAt instead of advancing a date by months yourself or keeping a ' +
    'day/millisecond table keyed by cadence names. If you genuinely need a fixed span — a ' +
    'lookback window rather than a due date — add it to this guard BY NAME with the reason, ' +
    'the way automation-runner.ts is carved out above.';

/** A date advanced by whole months: `x.setMonth(x.getMonth() + n)`, UTC or not. */
const ADVANCES_BY_MONTHS = /\bset(?:UTC)?Month\s*\(\s*[A-Za-z_$][\w$]*\.get(?:UTC)?Month\s*\(\s*\)\s*\+/;

/** A table keyed by cadence names whose values are numbers: `MONTHLY: 30`. */
const CADENCE_KEYED_NUMBERS = /\b(?:MONTHLY|QUARTERLY|SEMI_ANNUALLY|ANNUALLY)\s*:\s*[0-9]/;

/** Every `.ts` under `src/`, comments masked, so prose about the bug is not the bug. */
const sources = repoFiles({ under: 'src', extensions: ['.ts'] }).map((abs) => ({
    rel: repoRelative(abs),
    code: codeOf(fs.readFileSync(abs, 'utf8')),
}));

describe('cadence arithmetic has one home', () => {
    it('sees a non-trivial population — the denominator, before any claim about it', () => {
        // An empty or tiny population would satisfy every assertion below while
        // measuring nothing, which is how a file walk silently stops guarding.
        expect(sources.length).toBeGreaterThan(400);
        expect(sources.some((f) => f.rel === CADENCE_REL)).toBe(true);
        expect(sources.some((f) => f.rel === FLAT_TABLE_CARVE_OUT)).toBe(true);
    });

    it('advances a date by whole months in cadence.ts ONLY', () => {
        const offenders = sources.filter((f) => ADVANCES_BY_MONTHS.test(f.code)).map((f) => f.rel);

        expect({ files: offenders.sort(), remedy: REMEDY }).toEqual({
            files: [CADENCE_REL],
            remedy: REMEDY,
        });
    });

    it('keeps a cadence-keyed number table only in the carved-out lookback window', () => {
        const offenders = sources.filter((f) => CADENCE_KEYED_NUMBERS.test(f.code)).map((f) => f.rel);

        expect({ files: offenders.sort(), remedy: REMEDY }).toEqual({
            files: [FLAT_TABLE_CARVE_OUT],
            remedy: REMEDY,
        });
    });

    it('both matchers fire on a violation, and neither on its legitimate neighbours', () => {
        // THE POSITIVE CONTROL. Two assertions that a list equals one filename
        // are equally satisfied by matchers that match nothing at all, so the
        // discriminating evidence is that each fires on the real shape and
        // skips the operations that merely resemble it.
        expect(ADVANCES_BY_MONTHS.test('d.setUTCMonth(d.getUTCMonth() + 3);')).toBe(true);
        expect(ADVANCES_BY_MONTHS.test('next.setMonth(next.getMonth() + months);')).toBe(true);
        // Backwards, for a lookback window — a different operation, not a due date.
        expect(ADVANCES_BY_MONTHS.test('since.setMonth(since.getMonth() - 6);')).toBe(false);
        // An ABSOLUTE month, which is not advancing by a cadence at all.
        expect(ADVANCES_BY_MONTHS.test('d.setUTCMonth(targetMonth);')).toBe(false);

        expect(CADENCE_KEYED_NUMBERS.test('MONTHLY: 30,')).toBe(true);
        expect(CADENCE_KEYED_NUMBERS.test('QUARTERLY: 90 * 24 * 60 * 60 * 1000,')).toBe(true);
        // A type union naming the cadences is not a table of numbers.
        expect(CADENCE_KEYED_NUMBERS.test("reviewCadence?: 'MONTHLY' | 'QUARTERLY';")).toBe(false);
    });
});

describe('cadence.ts can express every cadence the schema stores', () => {
    /** `ReviewCadence` as the Prisma schema declares it, not as this test remembers it. */
    const reviewCadences = (() => {
        const block = /enum\s+ReviewCadence\s*\{([^}]*)\}/.exec(codeOf(readPrismaSchema()));
        if (block === null) throw new Error('enum ReviewCadence not found in the Prisma schema');
        return block[1]
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => /^[A-Z_]+$/.test(l));
    })();

    it('reads the enum from the schema rather than restating it', () => {
        // The population again: an empty list would make the next test vacuous.
        expect(reviewCadences.length).toBeGreaterThanOrEqual(4);
        expect(reviewCadences).toContain('SEMI_ANNUALLY');
    });

    it('returns a date for every one of them — the gap that caused #3802', () => {
        // `task-source-reconcile.ts` kept its own table because cadence.ts could
        // not express SEMI_ANNUALLY, so it computed review dates elsewhere and
        // drifted. A new value added to the enum without an arm here would
        // silently return null and leave evidence with NO next review date,
        // which reads as "never due" rather than as a failure.
        const from = new Date(2026, 0, 31); // 31 January — the clamping case
        const resolved = reviewCadences.map((c) => [c, computeNextDueAt(c, from) !== null] as const);

        expect(resolved).toEqual(reviewCadences.map((c) => [c, true]));
    });

    it('clamps to month end rather than overflowing, for each of them', () => {
        // The owner decision, asserted on the date that exposes it. A bare
        // `setMonth` would land every one of these in the FOLLOWING month.
        const from = new Date(2026, 0, 31);
        const dayOfMonth = (c: string) => computeNextDueAt(c, from)?.getDate();

        expect({
            MONTHLY: dayOfMonth('MONTHLY'),
            QUARTERLY: dayOfMonth('QUARTERLY'),
            SEMI_ANNUALLY: dayOfMonth('SEMI_ANNUALLY'),
            ANNUALLY: dayOfMonth('ANNUALLY'),
        }).toEqual({
            MONTHLY: 28, // 28 Feb 2026, not 3 Mar
            QUARTERLY: 30, // 30 Apr, not 1 May
            SEMI_ANNUALLY: 31, // 31 Jul has a 31st, so no clamp
            ANNUALLY: 31, // 31 Jan 2027
        });
    });
});
