/**
 * Which writes an internal audit still accepts, by its status (#4531).
 *
 * Owner decision, 2026-10-30: a COMPLETED or CANCELLED audit is read-only, on
 * the server as well as the page.
 *
 *   - COMPLETED accepts ONE write: the status move back to IN_PROGRESS. To
 *     change a completed audit, a person reopens it first, and the reopening
 *     is its own audited update rather than a side effect of an edit.
 *   - CANCELLED accepts nothing. Reopening a cancelled audit is not a step back
 *     along PLANNED → IN_PROGRESS → COMPLETED (the status it was cancelled from
 *     is not recorded), and the page's cancel confirmation already says it
 *     cannot be undone.
 *
 * Before this, every field, every checklist result and every status was
 * writable whatever the status, so recording a FAIL on a cancelled audit still
 * raised a finding and a remediation task.
 *
 * NO IMPORTS, so the audits page can read the same rule the usecase applies.
 */

/** The refusal reasons, in `error.details.reason`. */
export const AUDIT_COMPLETED_READ_ONLY = 'AUDIT_COMPLETED_READ_ONLY' as const;
export const AUDIT_CANCELLED_READ_ONLY = 'AUDIT_CANCELLED_READ_ONLY' as const;

export type AuditReadOnlyReason = typeof AUDIT_COMPLETED_READ_ONLY | typeof AUDIT_CANCELLED_READ_ONLY;

/** True when an audit in this status accepts no edit to its fields or checklist. */
export function isAuditReadOnly(status: string): boolean {
    return status === 'COMPLETED' || status === 'CANCELLED';
}

/**
 * Why an update to an audit in `currentStatus` is refused, or null when it is
 * allowed. `update` is the parsed request body; a key whose value is
 * `undefined` is not being written and does not count.
 *
 * An update that writes nothing is not refused: it changes nothing.
 */
export function auditWriteRefusal(
    currentStatus: string,
    update: Readonly<Record<string, unknown>>,
): AuditReadOnlyReason | null {
    const written = Object.keys(update).filter((k) => update[k] !== undefined);
    if (written.length === 0) return null;
    if (currentStatus === 'CANCELLED') return AUDIT_CANCELLED_READ_ONLY;
    if (currentStatus === 'COMPLETED') {
        const reopening = written.length === 1 && written[0] === 'status' && update.status === 'IN_PROGRESS';
        return reopening ? null : AUDIT_COMPLETED_READ_ONLY;
    }
    return null;
}

/** Read a parsed API error body's read-only reason, or null for any other refusal. */
export function auditReadOnlyReasonOf(body: unknown): AuditReadOnlyReason | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details?.reason;
    return reason === AUDIT_COMPLETED_READ_ONLY || reason === AUDIT_CANCELLED_READ_ONLY ? reason : null;
}
