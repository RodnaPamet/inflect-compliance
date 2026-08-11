/**
 * Control test cadence — the one definition of "is this control's test due".
 *
 * Two surfaces read `Control.nextDueAt` and must not disagree about it:
 *
 *   - `compliance-calendar.ts` (`loadControlEvents`) renders it on the calendar
 *   - `jobs/deadline-monitor.ts` (`scanControls`) emails the owner about it
 *
 * They DID disagree. The calendar short-circuited on
 * `isDone = r.status === 'IMPLEMENTED'` before comparing any date, so an
 * IMPLEMENTED control with a lapsed test rendered as `done` while the monitor
 * emailed the same row as overdue. Two systems, one row, opposite answers —
 * and the user looks at the calendar.
 *
 * ## What `nextDueAt` means
 *
 * It is the next TEST due date, not an implementation milestone. It is written
 * in exactly one shape — "a test just ran, roll the clock":
 *
 *     data: { lastTested: now, nextDueAt: computeNextDueAt(control.frequency, now) }
 *
 * (`usecases/control/test-plans.ts::attestControlTested`, plus the runner and
 * the task-source reconciler, all gated on an attesting PASS/FAIL verdict.)
 *
 * ## Why `ControlStatus` is not an input
 *
 * `IMPLEMENTED` is the state in which a control is *supposed* to be tested on
 * cadence — it is the reason the deadline exists, not evidence of meeting it.
 * Every other calendar source that derives `isDone` from a status names a state
 * that EXTINGUISHES the obligation the date encodes (an ARCHIVED policy has no
 * review left to do; a CLOSED finding has no remediation left). Control is the
 * one case where the status and the date describe two different obligations, so
 * no `ControlStatus` value may satisfy this clock.
 *
 * The obligation is discharged the only way it can be: by a test run, which
 * rolls `nextDueAt` into the future. So "outstanding" is a pure date question,
 * which is exactly what makes the two surfaces agree once they both ask it here.
 */

/**
 * Rows eligible for a test deadline at all.
 *
 * Soft-deleted controls have no obligations, and a control marked
 * NOT_APPLICABLE has been scoped out of the framework — neither should appear
 * on a calendar or generate mail. Shared so the two surfaces cannot drift on
 * *which rows* they consider, having already drifted on how they judge them.
 */
export const CONTROL_TEST_ELIGIBILITY = {
    deletedAt: null,
    applicability: 'APPLICABLE',
} as const;

/**
 * Is this control's test obligation still outstanding as of `now`?
 *
 * `null` means no cadence has ever been established (never attested, no
 * frequency) — there is no deadline to miss, so nothing is outstanding.
 *
 * Note what is NOT a parameter: the control's `status`. See the module
 * docblock — that was the defect.
 */
export function isControlTestOutstanding(
    nextDueAt: Date | null | undefined,
    now: Date,
): boolean {
    if (!nextDueAt) return false;
    return nextDueAt.getTime() <= now.getTime();
}

/**
 * Whether a control's test deadline should render as satisfied on a calendar.
 *
 * Always `false`, and deliberately a named function rather than a literal at
 * the call site: it is the assertion "no control state satisfies the test
 * clock", which is the fix, and it belongs next to the reasoning above. A bare
 * `false` in the loader invites exactly the `status === 'IMPLEMENTED'` guess
 * that was there before.
 */
export function isControlTestSatisfied(): boolean {
    return false;
}
