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
 * The TaskStatus enum values are:
 *   OPEN | TRIAGED | IN_PROGRESS | IN_REVIEW | BLOCKED | RESOLVED | CLOSED | CANCELED
 *
 * Status lifecycle:
 *   OPEN → TRIAGED → IN_PROGRESS → IN_REVIEW → RESOLVED → CLOSED
 *                              ↘ BLOCKED ↗              → CANCELED
 *   (IN_REVIEW gates close when a reviewerUserId is set — see setTaskStatus)
 *
 * @module app-layer/domain/task-status
 */

/**
 * Terminal/completed statuses — items that are done and should be excluded
 * from active views, overdue calculations, and notification triggers.
 */
export const TERMINAL_TASK_STATUSES = ['RESOLVED', 'CLOSED', 'CANCELED'] as const;

/**
 * Active/open statuses — items that are still in progress and should appear
 * in active views, overdue checks, dashboard counts, and notifications.
 *
 * This is the inverse of TERMINAL_TASK_STATUSES.
 * Includes: OPEN, TRIAGED, IN_PROGRESS, BLOCKED
 */
export const ACTIVE_TASK_STATUSES = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'] as const;

/**
 * All valid work item statuses.
 */
export const ALL_TASK_STATUSES = [
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
export const REVIEW_TASK_STATUS = 'IN_REVIEW';

export type TaskStatusValue = (typeof ALL_TASK_STATUSES)[number];
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];
export type ActiveTaskStatus = (typeof ACTIVE_TASK_STATUSES)[number];

/**
 * Prisma-compatible filter for active/open items.
 * Usage: `where: { status: ACTIVE_STATUS_FILTER }`
 *
 * Prefer this over `{ in: ACTIVE_TASK_STATUSES }` because
 * the notIn pattern is future-proof — new statuses added to
 * TaskStatus will automatically be included in active views
 * unless they are explicitly terminal.
 */
export const ACTIVE_STATUS_FILTER = {
    notIn: TERMINAL_TASK_STATUSES as unknown as string[],
} as const;

/**
 * Check if a status string represents a terminal/completed state.
 */
export function isTerminalStatus(status: string): status is TerminalTaskStatus {
    return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * Check if a status string represents an active/in-progress state.
 */
export function isActiveStatus(status: string): status is ActiveTaskStatus {
    return (ACTIVE_TASK_STATUSES as readonly string[]).includes(status);
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
export const TASK_TRANSITIONS: Record<
    TaskStatusValue,
    ReadonlySet<TaskStatusValue>
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

export type TaskTransitionError =
    | { kind: 'unknown_from'; from: string }
    | { kind: 'unknown_to'; to: string }
    | { kind: 'no_op'; status: string }
    | { kind: 'illegal'; from: string; to: string };

/**
 * Pure-function transition check. Returns `null` on a legal
 * transition, or a discriminated error variant the caller can
 * forward to `badRequest()` with a precise message.
 */
export function checkTaskTransition(
    from: string,
    to: string,
): TaskTransitionError | null {
    if (!(from in TASK_TRANSITIONS)) {
        return { kind: 'unknown_from', from };
    }
    if (!(to in TASK_TRANSITIONS)) {
        return { kind: 'unknown_to', to };
    }
    if (from === to) {
        return { kind: 'no_op', status: from };
    }
    const allowed = TASK_TRANSITIONS[from as TaskStatusValue];
    if (!allowed.has(to as TaskStatusValue)) {
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
    err: TaskTransitionError,
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
