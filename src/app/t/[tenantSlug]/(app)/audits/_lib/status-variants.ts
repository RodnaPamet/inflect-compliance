import type { StatusBadgeVariant } from '@/components/ui/status-badge';

/**
 * Canonical status → StatusBadge variant maps for the audits surface.
 *
 * Extracted here so the list and detail views can never disagree again. The
 * previous per-file maps contradicted each other:
 *   - AuditCycle: list had COMPLETE=warning + READY=success; detail had the
 *     reverse (READY=warning, COMPLETE=success).
 *   - AuditPack: cycle detail rendered EXPORTED=success; the pack page
 *     collapsed FROZEN+EXPORTED to info.
 *   - Audit: the hub used CANCELLED=warning; the cycle page used neutral.
 *
 * Resolution (one authoritative reading): a terminal "done" state is
 * `success`, an in-flight state is `info`, a pending/attention state is
 * `warning`, and an inert/initial/cancelled state is `neutral`.
 */

/** AuditCycleStatus: PLANNING → IN_PROGRESS → READY → COMPLETE */
export const AUDIT_CYCLE_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    PLANNING: 'neutral',
    IN_PROGRESS: 'info',
    READY: 'warning',
    COMPLETE: 'success',
};

/** AuditPackStatus: DRAFT → FROZEN → EXPORTED */
export const AUDIT_PACK_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    FROZEN: 'info',
    EXPORTED: 'success',
};

/** AuditStatus: PLANNED → IN_PROGRESS → COMPLETED (or CANCELLED) */
export const AUDIT_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    PLANNED: 'neutral',
    IN_PROGRESS: 'info',
    COMPLETED: 'success',
    CANCELLED: 'neutral',
};

/** ChecklistResult: NOT_TESTED / PASS / FAIL (these already agreed everywhere) */
export const CHECKLIST_RESULT_VARIANT: Record<string, StatusBadgeVariant> = {
    NOT_TESTED: 'neutral',
    PASS: 'success',
    FAIL: 'error',
};

/** Fallback for an unrecognised status value. */
export const DEFAULT_STATUS_VARIANT: StatusBadgeVariant = 'neutral';

/**
 * The status moves the audit pane offers, by current status: one step
 * forward, one step back, and Cancel while the audit is not yet done.
 *
 * The server refuses every write to a CANCELLED audit and every write to a
 * COMPLETED one except the move back to IN_PROGRESS (`auditWriteRefusal` in
 * `@/lib/audit-lifecycle`, #4531); between PLANNED and IN_PROGRESS it has no
 * transition rules, so this table is the lifecycle the page presents. The
 * step back exists so an audit moved forward by mistake can be corrected
 * without the API, and it is the only way to change a completed audit.
 *
 * CANCELLED offers nothing: reopening a cancelled audit is not a step back
 * along PLANNED → IN_PROGRESS → COMPLETED (the status it was cancelled from
 * is not recorded), and the Cancel confirmation says the page cannot undo it.
 */
export interface AuditStatusMoves {
    forward?: 'IN_PROGRESS' | 'COMPLETED';
    back?: 'PLANNED' | 'IN_PROGRESS';
    cancellable: boolean;
}

export const AUDIT_STATUS_MOVES: Record<string, AuditStatusMoves> = {
    PLANNED: { forward: 'IN_PROGRESS', cancellable: true },
    IN_PROGRESS: { forward: 'COMPLETED', back: 'PLANNED', cancellable: true },
    COMPLETED: { back: 'IN_PROGRESS', cancellable: false },
    CANCELLED: { cancellable: false },
};

/** An unrecognised status offers no move rather than guessing one. */
export const NO_STATUS_MOVES: AuditStatusMoves = { cancellable: false };
