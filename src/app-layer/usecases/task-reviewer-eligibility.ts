/**
 * Who may be named a task's reviewer (#4278, owner decision: option a).
 *
 * The reviewer is the only person who can complete a reviewer-gated task
 * (`checkReviewerSignOffGate`), and completing it is a status change, which
 * `setTaskStatus` refuses to anyone `assertCanWriteTasks` refuses. A Reader,
 * Auditor or AI admin named reviewer could therefore never sign the task off:
 * it could only be cancelled or given another reviewer. So the reviewer must
 * be a member who could make that status change — the coarse write tier AND
 * the granular `tasks.edit` key, the same pair `assertCanWriteTasks` checks
 * for the caller, resolved here for ANOTHER member.
 *
 * Read by the create / update write paths (the rule) and by the reviewer
 * picker's roster (`listAssignableUsers({ taskReviewersOnly })`), so the
 * picker offers exactly the people the write accepts.
 */
import type { Role } from '@prisma/client';
import { computePermissions } from '@/lib/tenant-context';
import { permissionsForMembership } from '@/lib/permissions';

/** The membership columns the rule reads. */
export const REVIEWER_ELIGIBILITY_SELECT = {
    role: true,
    customRole: { select: { permissionsJson: true, baseRole: true } },
} as const;

export interface ReviewerEligibilityMembership {
    role: Role;
    customRole: { permissionsJson: unknown; baseRole: Role } | null;
}

/**
 * Could this member change a task's status — and so sign it off? The coarse
 * tier is the effective role's (a custom role's base, as `getTenantCtx`
 * resolves it); the key is the membership's resolved `tasks.edit`.
 */
export function memberCanSignOffTasks(membership: ReviewerEligibilityMembership): boolean {
    const effectiveRole = membership.customRole?.baseRole ?? membership.role;
    return (
        computePermissions(effectiveRole).canWrite &&
        permissionsForMembership(membership).tasks.edit === true
    );
}

/** The refusal's named reason, in `details.reason`. */
export const REVIEWER_CANNOT_SIGN_OFF = 'REVIEWER_CANNOT_EDIT_TASKS';

export const REVIEWER_CANNOT_SIGN_OFF_MESSAGE =
    "A task's reviewer must be someone whose role can edit tasks — signing a task off is a " +
    'status change, which Readers, Auditors and AI admins cannot make.';
