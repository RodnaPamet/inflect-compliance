import { apiErrorMessage } from '@/lib/api-error';

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

    constructor(reason: string | null) {
        super(reason ?? 'audit_write_failed');
        this.name = 'AuditWriteError';
        this.reason = reason;
    }
}

/** Read a non-2xx response's envelope into an `AuditWriteError`. */
export async function auditWriteErrorFrom(res: Response): Promise<AuditWriteError> {
    const body: unknown = await res.json().catch(() => null);
    // An empty fallback, so "the server gave no reason" stays distinguishable
    // from a reason: the caller supplies its own sentence for that case.
    const reason = apiErrorMessage(body, '');
    return new AuditWriteError(reason === '' ? null : reason);
}

/**
 * What to tell the user about a failed write: the server's reason when it gave
 * one, else the caller's own sentence. A request that never reached the server
 * (`fetch` threw) carries no server reason, so it gets the fallback too.
 */
export function auditWriteFailureMessage(err: unknown, fallback: string): string {
    return err instanceof AuditWriteError && err.reason ? err.reason : fallback;
}
