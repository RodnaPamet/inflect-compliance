/**
 * The overdue-work reporter's grace periods, derived from `SCHEDULED_JOBS`.
 *
 * `infra/reporters/work-overdue-reporter.sh` reports a family as overdue once
 * its scheduling column is later than a GRACE PERIOD in the past. Each grace is
 * three times the cadence of the job that is supposed to drain that family, so
 * two consecutive missed runs plus margin are needed before anything is
 * reported — one slow tick is not a page.
 *
 * THAT RATIO IS THE WHOLE DESIGN, AND IT IS A SHELL SCRIPT, so nothing in the
 * type system holds it. A cadence change without a grace change is exactly the
 * edit that makes a monitor cry wolf: drop `audit-outbox-flush` to hourly and a
 * 15-minute grace reports every healthy run as late, which is how an alert
 * gets muted and the thing it watches becomes invisible again.
 *
 * This is the same mechanism `fan-out-bucket-matches-schedule.test.ts` uses for
 * the dedupe buckets, for the same reason and against the same registry.
 *
 * WHY A SOURCE READ RATHER THAN A SHARED CONSTANT: the consumer is a bash
 * script that runs on the VM with no node available, so it cannot import
 * anything. The contract is three comment lines in a fixed shape, and this test
 * is what makes them binding.
 */

import * as fs from 'fs';
import * as path from 'path';

import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';

const REPORTER = 'infra/reporters/work-overdue-reporter.sh';

/** The job that is supposed to drain each family. */
const DRAINER: Readonly<Record<string, string>> = {
    control_test_plan: 'control-test-scheduler',
    audit_outbox: 'audit-outbox-flush',
    notification_outbox: 'notification-outbox-flush',
};

/** Minimum grace, as a multiple of the drainer's cadence. */
const MIN_RATIO = 3;

const source = fs.readFileSync(
    path.resolve(__dirname, '../..', REPORTER),
    'utf-8',
);

interface Declared {
    readonly family: string;
    readonly grace: number;
    readonly cadence: number;
}

/** The `family=… grace_minutes=… cadence_minutes=…` contract lines. */
const declared: readonly Declared[] = [
    ...source.matchAll(
        /family=([a-z_]+)\s+grace_minutes=(\d+)\s+cadence_minutes=(\d+)/g,
    ),
].map((m) => ({ family: m[1], grace: Number(m[2]), cadence: Number(m[3]) }));

/** Minutes between runs of a `*\/N * * * *` cron pattern, else null. */
function cadenceMinutesOf(jobName: string): number | null {
    const job = SCHEDULED_JOBS.find((j) => j.name === jobName);
    if (!job) return null;
    const minuteField = job.pattern.trim().split(/\s+/)[0];
    const every = /^\*\/(\d+)$/.exec(minuteField);
    return every ? Number(every[1]) : null;
}

describe('the overdue-work reporter declares a grace per family (#3558)', () => {
    it('declares exactly the three families it reports, and no others', () => {
        // THE DENOMINATOR. A regex that matched nothing would make every
        // assertion below pass over an empty array — the way this guard would
        // silently stop guarding if the contract's shape were reformatted.
        expect(declared.map((d) => d.family).sort()).toEqual(
            Object.keys(DRAINER).sort(),
        );
    });

    it('posts a series for every family it declares', () => {
        // The other half of the completeness check: a family declared in the
        // contract but never posted would have a grace nobody applies, and a
        // family posted but not declared would have a grace nobody checks.
        const posted = [...source.matchAll(/series_for ([a-z_]+)\s/g)].map((m) => m[1]);
        expect([...new Set(posted)].sort()).toEqual(Object.keys(DRAINER).sort());
    });

    it('names a cadence that SCHEDULED_JOBS actually declares', () => {
        // Derived, so the contract cannot drift from the registry unnoticed.
        // Mapped rather than looped so a failure names every mismatch at once.
        expect(
            declared.map((d) => [d.family, d.cadence]),
        ).toEqual(
            declared.map((d) => [d.family, cadenceMinutesOf(DRAINER[d.family])]),
        );
    });

    it('gives every family at least three cadences of grace', () => {
        // Two consecutive missed runs plus margin. Below three, a single slow
        // tick reports healthy work as late.
        expect(
            declared
                .filter((d) => d.grace < d.cadence * MIN_RATIO)
                .map((d) => `${d.family}: grace ${d.grace}m vs cadence ${d.cadence}m`),
        ).toEqual([]);
    });

    it('uses each declared grace in the query for that family', () => {
        // THE ASSERTION THAT MAKES THE OTHERS MEAN ANYTHING. The contract is a
        // comment; the queries are what run. A grace raised in the comment and
        // left alone in the SQL would pass every check above.
        //
        // Counted rather than merely matched: the control-test family appears
        // in two queries (the count and the detail listing), so a single
        // `toContain` would be satisfied by whichever one survived an edit.
        const occurrences = (needle: string) =>
            source.split(needle).length - 1;
        for (const d of declared) {
            expect(occurrences(`interval '${d.grace} minutes'`)).toBeGreaterThan(0);
        }
        // And the two 15-minute families plus the control-test detail query
        // mean `15 minutes` appears three times; 30 appears once.
        expect(occurrences("interval '15 minutes'")).toBe(3);
        expect(occurrences("interval '30 minutes'")).toBe(1);
    });

    it('emits on the healthy path, so absence stays distinguishable', () => {
        // README rule 2 — `0` is a value. The reporter must POST all three
        // series unconditionally; only the DETAIL listing is gated on a
        // non-zero total. A reporter that posted nothing when healthy would
        // make the policy's absence arm fire on every good day.
        expect(source).toContain('PAYLOAD="{\\"timeSeries\\":[$(series_for');
        // The gate is on the journal detail, not on the POST.
        expect(source).toMatch(/if \[ "\$TOTAL" -gt 0 \]; then\n\s+echo "OVERDUE/);
    });

    it('refuses to post a number it could not read', () => {
        // README rule 3, and the one that makes the absence arm a real signal:
        // an unreadable backlog is not an empty one, so a failed read exits
        // without posting rather than posting 0. Posting 0 there would be a
        // confident all-clear — the worst available outcome.
        expect(source).toContain('emitting NOTHING — an unreadable backlog is not an empty one');
        // Three families, three guarded reads, three exits.
        expect(source.split('exit 1; }').length - 1).toBeGreaterThanOrEqual(3);
    });
});
