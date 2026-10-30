/**
 * The read-only rule for internal audits (#4531), as a pure function: the
 * audits page and `updateAudit` both read it, so it is tested once here.
 */
import { AuditStatus } from '@prisma/client';

import {
    AUDIT_CANCELLED_READ_ONLY,
    AUDIT_COMPLETED_READ_ONLY,
    auditReadOnlyReasonOf,
    auditWriteRefusal,
    isAuditReadOnly,
} from '@/lib/audit-lifecycle';

describe('isAuditReadOnly', () => {
    it('is true for COMPLETED and CANCELLED and false for every other status', () => {
        const readOnly = Object.values(AuditStatus).filter((s) => isAuditReadOnly(s)).sort();
        expect(readOnly).toEqual(['CANCELLED', 'COMPLETED']);
    });
});

describe('auditWriteRefusal', () => {
    it('admits only the reopen on a COMPLETED audit', () => {
        expect(auditWriteRefusal('COMPLETED', { status: 'IN_PROGRESS' })).toBeNull();
        expect(auditWriteRefusal('COMPLETED', { status: 'IN_PROGRESS', title: undefined })).toBeNull();
        expect(auditWriteRefusal('COMPLETED', { status: 'IN_PROGRESS', title: 'x' })).toBe(AUDIT_COMPLETED_READ_ONLY);
        expect(auditWriteRefusal('COMPLETED', { status: 'CANCELLED' })).toBe(AUDIT_COMPLETED_READ_ONLY);
        expect(auditWriteRefusal('COMPLETED', { status: 'COMPLETED' })).toBe(AUDIT_COMPLETED_READ_ONLY);
        expect(auditWriteRefusal('COMPLETED', { checklistUpdates: [] })).toBe(AUDIT_COMPLETED_READ_ONLY);
        // `null` is a write (it clears a field), unlike `undefined`.
        expect(auditWriteRefusal('COMPLETED', { criteria: null })).toBe(AUDIT_COMPLETED_READ_ONLY);
    });

    it('admits nothing on a CANCELLED audit', () => {
        for (const status of Object.values(AuditStatus)) {
            expect(auditWriteRefusal('CANCELLED', { status })).toBe(AUDIT_CANCELLED_READ_ONLY);
        }
        expect(auditWriteRefusal('CANCELLED', { title: 'x' })).toBe(AUDIT_CANCELLED_READ_ONLY);
    });

    it('admits everything on an open audit', () => {
        for (const status of ['PLANNED', 'IN_PROGRESS']) {
            expect(auditWriteRefusal(status, { title: 'x', status: 'CANCELLED', checklistUpdates: [] })).toBeNull();
        }
    });

    it('an update that writes nothing is not refused', () => {
        expect(auditWriteRefusal('CANCELLED', {})).toBeNull();
        expect(auditWriteRefusal('COMPLETED', { title: undefined })).toBeNull();
    });
});

describe('auditReadOnlyReasonOf', () => {
    it('reads the reason from the error envelope, and nothing else', () => {
        expect(auditReadOnlyReasonOf({ error: { details: { reason: AUDIT_CANCELLED_READ_ONLY } } })).toBe(
            AUDIT_CANCELLED_READ_ONLY,
        );
        expect(auditReadOnlyReasonOf({ error: { details: { reason: 'OTHER' } } })).toBeNull();
        expect(auditReadOnlyReasonOf(null)).toBeNull();
    });
});
