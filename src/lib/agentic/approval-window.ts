/**
 * HOW LONG A HUMAN HAS TO CLEAR A CHECKPOINT — chosen, not inherited.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 *
 * A `HUMAN_CHECKPOINT` parks a run at AWAITING_APPROVAL so a person can look
 * at it. Nothing said how long they had. What actually bounded the wait was
 * `ENGINE_CAPS.WALL_CLOCK_MS` — sixty minutes, measured from the run's
 * original start and read off the clock rather than accumulated — because
 * `resumeWorkflowRun` hands the engine that same base. So an approval that
 * took longer than an hour made the run unresumable, and the runs list offers
 * a Resume button on exactly those rows.
 *
 * Measured 2026-09-24: resuming a run parked ~3.6 hours earlier halted
 * instantly with "RUNTIME_MS cap of 3600000 … 12847343 already spent; 0 more
 * asked for and NONE granted". Both shipped canned workflows carry a
 * checkpoint, so both are subject to it.
 *
 * Two different questions had been answered by one number:
 *
 *   · how long may the ENGINE run unattended     → WALL_CLOCK_MS, minutes
 *   · how long may a run WAIT FOR A PERSON       → this module, days
 *
 * Conflating them meant the second was bounded by a value chosen for the
 * first, which is how "a reviewer took the afternoon" became "the run is
 * dead".
 *
 * ── WHY THE WINDOW IS MANDATORY ─────────────────────────────────────────────
 *
 * `CheckpointStepDef.approvalWindow` is REQUIRED, with no default. A default
 * would be a fourth way to answer the question implicitly, and the whole
 * defect above is an implicit answer. Somebody authoring a checkpoint is
 * deciding how long that decision may take — a pack review is not a policy
 * sign-off — and a workflow that cannot say is a workflow whose author has
 * not thought about it. tsc finds every declaration.
 *
 * ── THE CLOCK STARTS WHEN THE RUN PARKS, AND NEVER RESTARTS ─────────────────
 *
 * Pinned onto the run as `approvalExpiresAt` at the moment it parks, exactly
 * as `proposal-expiry.ts` pins a proposal's deadline at propose time and for
 * the same reason it gives: a window that restarts on partial progress can be
 * held open forever by one person. A run that parks, is resumed, and parks
 * again at a LATER checkpoint gets a fresh window for that checkpoint — a new
 * decision by a new person — but a single checkpoint's clock runs once.
 */

/**
 * The windows an author may choose from. A closed set rather than a free
 * duration: "how long is reasonable" is a governance judgement with a handful
 * of defensible answers, and an arbitrary number invites 90 days by typo.
 */
export const APPROVAL_WINDOWS = ['24h', '48h', '5d', '7d', '30d'] as const;

export type ApprovalWindow = (typeof APPROVAL_WINDOWS)[number];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Each window in milliseconds.
 *
 * Spelled as arithmetic rather than as a constant, so a reader checks the
 * label against the sum rather than trusting that 432000000 is five days.
 */
export const APPROVAL_WINDOW_MS: Readonly<Record<ApprovalWindow, number>> = {
    '24h': 24 * HOUR_MS,
    '48h': 48 * HOUR_MS,
    '5d': 5 * DAY_MS,
    '7d': 7 * DAY_MS,
    '30d': 30 * DAY_MS,
};

/** The deadline to pin onto a run that parks at `parkedAt` under `window`. */
export function approvalDeadline(window: ApprovalWindow, parkedAt: Date): Date {
    return new Date(parkedAt.getTime() + APPROVAL_WINDOW_MS[window]);
}

/**
 * Has the window closed?
 *
 * A NULL `approvalExpiresAt` is NOT expired — the same direction
 * `proposal-expiry.ts` takes for the same reason: rows written before this
 * column existed carry null, and reading absence as "expired" would
 * retroactively kill every parked run on the deploy that shipped it. The
 * window is a bound this feature ADDS; it cannot be applied to decisions
 * taken under no bound at all.
 *
 * The interval is CLOSED, matching proposals: a run is expired exactly AT
 * `approvalExpiresAt`, not a millisecond after. One convention for both
 * deadlines, so nobody has to remember which end is open.
 */
export function isApprovalExpired(
    approvalExpiresAt: Date | null | undefined,
    now: Date,
): boolean {
    if (!approvalExpiresAt) return false;
    return approvalExpiresAt.getTime() <= now.getTime();
}
