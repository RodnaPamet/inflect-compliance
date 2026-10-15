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

        // AND NOTHING ELSE SHORT-CIRCUITS THE POST. The two assertions above
        // were not enough, and a mutation proved it: prepending
        //
        //     if [ "$TOTAL" -eq 0 ]; then exit 0; fi
        //
        // before the payload leaves both of them satisfied while stopping the
        // reporter emitting on every healthy run — which makes the policy's
        // absence arm fire on every good day, and is precisely README rule 2
        // being defeated. The guard graded the shape of the POST and the
        // position of the gate, neither of which is the property.
        //
        // Counted, because the property is "there is no OTHER branch":
        //   · `exit 0` exactly once — the dry-run path, the only early exit;
        //   · `$TOTAL` read exactly once — the journal gate. A second read is
        //     something else deciding on it.
        expect(source.split('exit 0').length - 1).toBe(1);
        expect(source.split('$TOTAL').length - 1).toBe(1);
    });

    it('refuses to post a number it could not read', () => {
        // README rule 3, and the one that makes the absence arm a real signal:
        // an unreadable backlog is not an empty one, so a failed read exits
        // without posting rather than posting 0. Posting 0 there would be a
        // confident all-clear — the worst available outcome.
        // COUNTED, NOT MATCHED, and the Class D ratchet is why: this phrase
        // appears once per family, so a bare `toContain` has three satisfying
        // positions and deleting two of the three guards would leave it green.
        // The count is also the stronger assertion — it proves ALL THREE reads
        // are guarded, which is the property, rather than that one of them is.
        const refusals = source.split('emitting NOTHING — an unreadable backlog is not an empty one').length - 1;
        // Also derived. This read `declared.length` and went stale the same way
        // the exit count below did: the abandonment families (#3558's second
        // half) made it 5 against an expectation of 3. One refusal per GUARDED
        // READ is the property; the overdue families are a subset of them.
        expect(refusals).toBe(source.split('=$(check ').length - 1);
        // And each refusal EXITS rather than falling through to the POST.
        //
        // The construct, not the bare `exit 1; }`: that appears FOUR times, not
        // three — the fourth is the missing-token guard, which is a different
        // refusal for a different reason. I asserted 3 and measured 4, which is
        // the whole argument for counting a needle before trusting it.
        const refusalsThatExit = source.split('is not an empty one" >&2; exit 1; }').length - 1;
        // DERIVED FROM THE GUARDED READS, not from `declared.length`. It was the
        // latter until the abandonment families arrived (#3558's second half)
        // and made it 5 against an expectation of 3 — a literal that went stale
        // the moment the reporter grew. The property is "every guarded read
        // refuses and exits", so the denominator is the number of reads.
        const guardedReads = source.split('=$(check ').length - 1;
        expect(guardedReads).toBeGreaterThanOrEqual(declared.length);
        expect(refusalsThatExit).toBe(guardedReads);
    });
});

/**
 * The abandonment families, and the window that keeps them usable (#3558).
 *
 * `jobs/work_abandoned` counts work GIVEN UP ON — a row whose retries are
 * exhausted and whose status is terminal. It is a second metric rather than two
 * more families of `jobs/work_overdue`, because a paged human reads the policy
 * title first and "overdue" promises something that may still complete.
 *
 * THE WINDOW IS THE WHOLE DESIGN HERE, and it is not a grace period. A FAILED
 * row is already final, so there is nothing to wait for; the window bounds what
 * counts as NEW. It MUST be bounded: production holds 512 FAILED notification
 * rows written off under #3573, so an unbounded count would make this alert
 * permanently firing — which is an alert on its way to being muted, and
 * indistinguishable from the three months of silence it exists to end.
 *
 * AND THE COLUMNS DIFFER BY TABLE, which looks like an inconsistency and is
 * not. Only one of the two records a transition time:
 *
 *   · `NotificationOutbox` has no `updatedAt`, and `processOutbox`'s failure
 *     branch writes only `status` and `lastError` — `sendAfter` never moves. So
 *     `createdAt` is the only timestamp available, and it is a sound proxy
 *     because no backoff is applied.
 *   · `AuditOutbox` DOES back off (`audit-outbox-flush.ts` writes
 *     `nextAttemptAt: now + backoffMs(...)`), so that column marks the last
 *     attempt and is a real transition time.
 *
 * A future reader's instinct will be to "fix" the inconsistency by using one
 * column for both. These tests pin each to the one that is correct for its
 * table, so that edit fails.
 */
describe('the abandonment families are bounded and correctly keyed (#3558)', () => {
    interface Abandoned {
        readonly family: string;
        readonly hours: number;
        readonly column: string;
    }

    /** The `family=… window_hours=… column=…` contract lines. */
    const abandoned: readonly Abandoned[] = [
        ...source.matchAll(/family=([a-z_]+)\s+window_hours=(\d+)\s+column=(\w+)/g),
    ].map((m) => ({ family: m[1], hours: Number(m[2]), column: m[3] }));

    /**
     * Every `status = 'FAILED'` read, with the table and bounding column it
     * uses — parsed rather than pattern-matched, so the assertions below are
     * about a small structure instead of the whole file.
     *
     * Source order: the notification COUNT query, the notification DETAIL
     * listing, then the audit COUNT query.
     */
    const failedQueries = (() => {
        const lines = source.split('\n');
        const out: { table: string; column: string; hours: number }[] = [];
        lines.forEach((line, i) => {
            if (!/status = 'FAILED'/.test(line)) return;
            const near = lines.slice(Math.max(0, i - 4), i + 4).join('\n');
            out.push({
                table: /(NotificationOutbox|AuditOutbox)/.exec(near)?.[1] ?? '(no table)',
                column: /(createdAt|nextAttemptAt)/.exec(near)?.[1] ?? '(no column)',
                hours: Number(/interval '(\d+) hours'/.exec(near)?.[1] ?? 0),
            });
        });
        return out;
    })();

    it('declares exactly the two abandonment families', () => {
        // THE DENOMINATOR. A reformatted contract line would make every
        // assertion below pass over an empty array.
        expect(abandoned.map((a) => a.family).sort()).toEqual([
            'audit_abandoned',
            'notification_abandoned',
        ]);
    });

    it('posts both of them to the work_abandoned metric, not work_overdue', () => {
        // The split is the point. Posting an abandonment family to the overdue
        // metric would put it under a policy whose title and documentation
        // describe something else.
        const posted = [...source.matchAll(/series_abandoned ([a-z_]+)\s/g)].map((m) => m[1]);
        expect([...new Set(posted)].sort()).toEqual(['audit_abandoned', 'notification_abandoned']);
        // And the overdue builder must not be used for them.
        // MAPPED, not looped: `expect(source)` inside a for-of makes the
        // subject a loop binding the Class D analyser cannot resolve, which
        // counts the assertion as a blind spot — and this names every offender
        // at once instead of stopping at the first.
        const viaOverdue = abandoned
            .map((a) => `series_for ${a.family}`)
            .filter((needle) => source.includes(needle));
        expect(viaOverdue).toEqual([]);
    });

    it('BOUNDS every abandonment query with its declared window', () => {
        // THE ASSERTION THAT MATTERS MOST. An unbounded `status = 'FAILED'`
        // count would be 512 on the day this ships and would never fall, so the
        // alert would fire forever and be muted within a week — leaving exactly
        // the silence #3573 documents.
        //
        // Counted per declared window, so dropping the interval from one query
        // while leaving the other cannot pass.
        // EVERY parsed FAILED read carries a window. `hours: 0` is what the
        // parser yields when no interval sits near the read, so an unbounded
        // count surfaces as a zero rather than as a missing entry.
        expect(failedQueries.filter((q) => q.hours === 0)).toEqual([]);
        // And each window used is one the contract declares.
        const declaredHours = new Set(abandoned.map((a) => a.hours));
        expect(failedQueries.filter((q) => !declaredHours.has(q.hours))).toEqual([]);
        // Three reads: two counts and the notification detail listing. Counted,
        // so a fourth FAILED read cannot arrive unbounded and unnoticed.
        expect(failedQueries).toHaveLength(3);
    });

    it('keys each table on the column that table actually records', () => {
        // The inconsistency that is not one. Pinned per family so "tidying" it
        // to one column fails — using `createdAt` on AuditOutbox would discard
        // a real transition time, and `nextAttemptAt` on NotificationOutbox
        // would read a column the failure path never writes.
        const byFamily = new Map(abandoned.map((a) => [a.family, a.column]));
        expect(byFamily.get('notification_abandoned')).toBe('createdAt');
        expect(byFamily.get('audit_abandoned')).toBe('nextAttemptAt');
        // ASSERTED ON THE PARSED QUERIES, not on a pattern over the file. The
        // first cut used `toMatch(/Table[\s\S]{0,180}column/)` twice, which is
        // two INTERIOR SPANS — and `assertion-span-reach-ratchet` counts those,
        // correctly: a span of arbitrary width can wander into a neighbouring
        // statement and match the wrong one. Parsing first makes the subject a
        // small structure instead of the whole file, and the assertion exact
        // instead of approximate.
        //
        // It also sidesteps the escaping that bit twice here: the SQL lives in
        // a bash heredoc where every identifier quote is backslash-escaped, so
        // a pattern written with bare quotes matches NOTHING — silently, which
        // reads exactly like a passing test.
        // SORTED, because source order is incidental. My first cut pinned the
        // order I had assumed — notification count, notification detail, audit
        // count — and the file's real order puts the audit COUNT second,
        // because both counts sit together above `TOTAL=` while the detail
        // listing lives in the journal block further down. Pinning that would
        // have been pinning an accident: moving a read would fail a test about
        // columns.
        const key = (q: { table: string; column: string; hours: number }) =>
            `${q.table}.${q.column}@${q.hours}h`;
        expect(failedQueries.map(key).sort()).toEqual(
            [
                'AuditOutbox.nextAttemptAt@24h',
                'NotificationOutbox.createdAt@24h',
                'NotificationOutbox.createdAt@24h',
            ].sort(),
        );
    });

    it('prints the error on a page, never the recipient', () => {
        // `dedupeKey` embeds the address (#3577) and `toEmail` IS the address. A
        // page is read by whoever is on call, who needs the CAUSE — one error
        // explained all 520 — and is not necessarily entitled to the recipient
        // list.
        // COMMENTS STRIPPED FIRST, because the comment explaining this very
        // exclusion names `dedupeKey` — so the unmasked check failed on its own
        // rationale. A scar, not a wound, and the third time this session that
        // prose about a forbidden token tripped the check for it.
        const detail = source
            .slice(source.indexOf('ABANDONED work in the last 24h'))
            .split('\n')
            .filter((l) => !l.trim().startsWith('#'))
            .join('\n');
        expect(detail).toContain('lastError');
        expect(detail).not.toContain('dedupeKey');
        expect(detail).not.toContain('toEmail');
    });

    it('refuses to post an abandonment count it could not read', () => {
        // README rule 3 extended to the new reads: five families, five guarded
        // reads, five refusals that exit. Counted, because the phrase appears
        // once per family and a bare match would survive dropping four.
        const refusals =
            source.split('is not an empty one" >&2; exit 1; }').length - 1;
        expect(refusals).toBe(declared.length + abandoned.length);
        expect(refusals).toBe(5);
    });
});
