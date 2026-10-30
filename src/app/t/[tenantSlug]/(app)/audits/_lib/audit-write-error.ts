import { apiErrorMessage } from '@/lib/api-error';
import { auditReadOnlyReasonOf, type AuditReadOnlyReason } from '@/lib/audit-lifecycle';

/**
 * The `audits` message key for each read-only refusal (#4531). The server's
 * sentence is English; these are the page's own, in the viewer's language.
 */
export const READ_ONLY_MESSAGE_KEY: Record<AuditReadOnlyReason, string> = {
    AUDIT_COMPLETED_READ_ONLY: 'detail.readOnlyCompleted',
    AUDIT_CANCELLED_READ_ONLY: 'detail.readOnlyCancelled',
};

/**
 * A refused `PUT /audits/{id}`, carrying the server's reason when it gave one.
 *
 * The hub's status buttons, checklist pickers and edit dialog share one write.
 * It used to throw a bare `Error('audit_write_failed')` without reading the
 * response, so every refusal — a 403 included — reached the user as the
 * caller's generic sentence ("Failed to update audit status."), and a role
 * the server refused never learned why.
 */
export class AuditWriteError extends Error {
    /** The server's sentence from the error envelope, or null when it gave none. */
    readonly reason: string | null;
    /** Set when the audit is completed or cancelled and so refused the write. */
    readonly readOnlyReason: AuditReadOnlyReason | null;

    constructor(reason: string | null, readOnlyReason: AuditReadOnlyReason | null = null) {
        super(reason ?? 'audit_write_failed');
        this.name = 'AuditWriteError';
        this.reason = reason;
        this.readOnlyReason = readOnlyReason;
    }
}

/** Read a non-2xx response's envelope into an `AuditWriteError`. */
export async function auditWriteErrorFrom(res: Response): Promise<AuditWriteError> {
    const body: unknown = await res.json().catch(() => null);
    // An empty fallback, so "the server gave no reason" stays distinguishable
    // from a reason: the caller supplies its own sentence for that case.
    const reason = apiErrorMessage(body, '');
    return new AuditWriteError(reason === '' ? null : reason, auditReadOnlyReasonOf(body));
}

/**
 * What to tell the user about a failed write: the server's reason when it gave
 * one, else the caller's own sentence. A request that never reached the server
 * (`fetch` threw) carries no server reason, so it gets the fallback too.
 */
export function auditWriteFailureMessage(
    err: unknown,
    fallback: string,
    /** The `audits` translator, for the read-only refusals' own sentences. */
    t?: (key: string) => string,
): string {
    if (err instanceof AuditWriteError && err.readOnlyReason && t) return t(READ_ONLY_MESSAGE_KEY[err.readOnlyReason]);
    return err instanceof AuditWriteError && err.reason ? err.reason : fallback;
}
