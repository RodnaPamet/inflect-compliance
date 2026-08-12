/**
 * Work Item Status Constants — Shared Domain Logic
 *
 * Canonical definitions of work item status groupings.
 * Use these constants instead of ad-hoc inline arrays
 * to ensure consistency across:
 *   - backend query filters (repositories, monitors, jobs)
 *   - frontend filter presets (task list, dashboard)
 *   - audit/readiness scoring
 *   - notification processing
 *
 * The WorkItemStatus enum values are:
 *   OPEN | TRIAGED | IN_PROGRESS | IN_REVIEW | BLOCKED | RESOLVED | CLOSED | CANCELED
 *
 * Status lifecycle:
 *   OPEN → TRIAGED → IN_PROGRESS → IN_REVIEW → RESOLVED → CLOSED
 *                              ↘ BLOCKED ↗              → CANCELED
 *   (IN_REVIEW gates close when a reviewerUserId is set — see setTaskStatus)
 *
 * @module app-layer/domain/work-item-status
 */

/**
 * Terminal/completed statuses — items that are done and should be excluded
 * from active views, overdue calculations, and notification triggers.
 */
export const TERMINAL_WORK_ITEM_STATUSES = ['RESOLVED', 'CLOSED', 'CANCELED'] as const;

/**
 * Active/open statuses — items that are still in progress and should appear
 * in active views, overdue checks, dashboard counts, and notifications.
 *
 * This is the inverse of TERMINAL_WORK_ITEM_STATUSES.
 * Includes: OPEN, TRIAGED, IN_PROGRESS, BLOCKED
 */
export const ACTIVE_WORK_ITEM_STATUSES = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'] as const;

/**
 * All valid work item statuses.
 */
export const ALL_WORK_ITEM_STATUSES = [
    'OPEN', 'TRIAGED', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED',
    'RESOLVED', 'CLOSED', 'CANCELED',
] as const;

/**
 * The status that hands a reviewer-gated work item to its reviewer.
 *
 * Named because three surfaces key off the same value and must not
 * drift: the four-eyes gate (a completion must come FROM it), the
 * review-request notification (the transition INTO it is the moment the
 * reviewer acquires work), and the "awaiting review by <user>" list
 * filter (which selects the tasks parked in it).
 */
export const REVIEW_WORK_ITEM_STATUS = 'IN_REVIEW';

export type WorkItemStatusValue = (typeof ALL_WORK_ITEM_STATUSES)[number];
export type TerminalWorkItemStatus = (typeof TERMINAL_WORK_ITEM_STATUSES)[number];
export type ActiveWorkItemStatus = (typeof ACTIVE_WORK_ITEM_STATUSES)[number];

/**
 * Prisma-compatible filter for active/open items.
 * Usage: `where: { status: ACTIVE_STATUS_FILTER }`
 *
 * Prefer this over `{ in: ACTIVE_WORK_ITEM_STATUSES }` because
 * the notIn pattern is future-proof — new statuses added to
 * WorkItemStatus will automatically be included in active views
 * unless they are explicitly terminal.
 */
export const ACTIVE_STATUS_FILTER = {
    notIn: TERMINAL_WORK_ITEM_STATUSES as unknown as string[],
} as const;

/**
 * Check if a status string represents a terminal/completed state.
 */
export function isTerminalStatus(status: string): status is TerminalWorkItemStatus {
    return (TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(status);
}

/**
 * Check if a status string represents an active/in-progress state.
 */
export function isActiveStatus(status: string): status is ActiveWorkItemStatus {
    return (ACTIVE_WORK_ITEM_STATUSES as readonly string[]).includes(status);
}

// ─────────────────────────────────────────────────────────────────────
// Audit Coherence S8 (2026-05-24) — explicit work-item state machine.
//
// Pre-S8, `setTaskStatus` / `setIssueStatus` accepted any string and
// wrote it through to the row. That left a few illegal shapes
// representable by the API: skipping OPEN entirely, re-opening a
// CLOSED row, re-opening a CANCELED row, sending RESOLVED back to
// OPEN. The lifecycle comment at the top of this file documented
// the intended graph; this table makes it executable.
//
// `assertLegalTransition(from, to)` is the canonical guard — usecases
// MUST call it before writing the new status. A `from === to` no-op
// is rejected by the same gate (no audit row for "I'm sending the
// same status I already had").
//
// Legal transitions captured below:
//   OPEN → TRIAGED · IN_PROGRESS · BLOCKED · RESOLVED · CANCELED
//          (RESOLVED short-circuit allows "fixed during triage")
//   TRIAGED → IN_PROGRESS · BLOCKED · RESOLVED · CANCELED
//   IN_PROGRESS → BLOCKED · RESOLVED · CANCELED · TRIAGED
//                 (move back to TRIAGED is "needs re-scoping")
//   BLOCKED → IN_PROGRESS · TRIAGED · CANCELED
//   RESOLVED → CLOSED · IN_PROGRESS
//              (re-open is allowed before close — common when QA
//               or auditors reject the resolution)
//   CLOSED → (terminal — no transitions out)
//   CANCELED → (terminal — no transitions out)
// ─────────────────────────────────────────────────────────────────────
export const WORK_ITEM_TRANSITIONS: Record<
    WorkItemStatusValue,
    ReadonlySet<WorkItemStatusValue>
> = {
    // CLOSED is now reachable directly from every active status. The
    // UI retired RESOLVED as a redundant intermediate (it stays in the
    // enum + the graph for legacy RESOLVED rows, which can still
    // advance to CLOSED), so an active task closes in one step.
    // IN_REVIEW is reachable from every active state (submit for sign-off)
    // and leads to a terminal close, a bounce back to IN_PROGRESS (reviewer
    // rejects), or CANCELED. When a task carries a reviewerUserId the
    // reviewer gate in `setTaskStatus` additionally REQUIRES the close to
    // pass through IN_REVIEW and be driven by the reviewer — the graph
    // permits the shapes; the gate enforces the sign-off.
    OPEN: new Set(['TRIAGED', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'RESOLVED', 'CLOSED', 'CANCELED']),
    TRIAGED: new Set(['IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'RESOLVED', 'CLOSED', 'CANCELED']),
    IN_PROGRESS: new Set(['BLOCKED', 'IN_REVIEW', 'RESOLVED', 'CLOSED', 'CANCELED', 'TRIAGED']),
    IN_REVIEW: new Set(['IN_PROGRESS', 'TRIAGED', 'RESOLVED', 'CLOSED', 'CANCELED']),
    BLOCKED: new Set(['IN_PROGRESS', 'IN_REVIEW', 'TRIAGED', 'CLOSED', 'CANCELED']),
    RESOLVED: new Set(['CLOSED', 'IN_PROGRESS']),
    CLOSED: new Set(),
    CANCELED: new Set(),
};

export type WorkItemTransitionError =
    | { kind: 'unknown_from'; from: string }
    | { kind: 'unknown_to'; to: string }
    | { kind: 'no_op'; status: string }
    | { kind: 'illegal'; from: string; to: string };

/**
 * Pure-function transition check. Returns `null` on a legal
 * transition, or a discriminated error variant the caller can
 * forward to `badRequest()` with a precise message.
 */
export function checkWorkItemTransition(
    from: string,
    to: string,
): WorkItemTransitionError | null {
    if (!(from in WORK_ITEM_TRANSITIONS)) {
        return { kind: 'unknown_from', from };
    }
    if (!(to in WORK_ITEM_TRANSITIONS)) {
        return { kind: 'unknown_to', to };
    }
    if (from === to) {
        return { kind: 'no_op', status: from };
    }
    const allowed = WORK_ITEM_TRANSITIONS[from as WorkItemStatusValue];
    if (!allowed.has(to as WorkItemStatusValue)) {
        return { kind: 'illegal', from, to };
    }
    return null;
}

/**
 * Render a transition error into a human-readable message.
 * Used by the usecase shim to keep the wording consistent across
 * task + issue setStatus paths.
 */
export function formatTransitionError(
    err: WorkItemTransitionError,
): string {
    switch (err.kind) {
        case 'unknown_from':
            return `Unknown current status "${err.from}"; cannot validate transition.`;
        case 'unknown_to':
            return `Unknown target status "${err.to}".`;
        case 'no_op':
            return `Status is already ${err.status}.`;
        case 'illegal':
            return `Illegal work-item transition: ${err.from} → ${err.to}.`;
    }
}
