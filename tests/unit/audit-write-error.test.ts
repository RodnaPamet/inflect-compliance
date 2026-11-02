/**
 * What the audit hub tells the reader about a refused write (#4962).
 *
 * A cycle that no longer exists is refused with the bare code
 * `INVALID_AUDIT_CYCLE` as the message; it reached the reader as that code.
 * It is now the page's own sentence; any other reason is shown as sent.
 */
import { AuditWriteError, auditWriteFailureMessage } from '@/app/t/[tenantSlug]/(app)/audits/_lib/audit-write-error';

const t = (key: string) => `t:${key}`;

describe('auditWriteFailureMessage', () => {
    it('words a vanished cycle in the page’s own sentence', () => {
        expect(auditWriteFailureMessage(new AuditWriteError('INVALID_AUDIT_CYCLE'), 'fallback', t)).toBe(
            't:newModal.cycleNotFound',
        );
    });

    it('keeps any other server reason as sent', () => {
        expect(auditWriteFailureMessage(new AuditWriteError('Title is too long'), 'fallback', t)).toBe('Title is too long');
    });

    it('falls back to the caller’s sentence when the server gave none', () => {
        expect(auditWriteFailureMessage(new AuditWriteError(null), 'fallback', t)).toBe('fallback');
        expect(auditWriteFailureMessage(new Error('network'), 'fallback', t)).toBe('fallback');
    });
});
