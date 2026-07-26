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
