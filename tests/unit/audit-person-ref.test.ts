/**
 * `auditPersonRef` (#5950): which person an audit row is about, by the id it
 * carries. Rows name a person by id only (owner decision 2026-11-25), and the
 * Audit log page resolves this reference to a label while the person exists.
 */
import { auditPersonKey, auditPersonRef } from '@/lib/audit/audit-person';

const row = (action: string, entity: string, entityId: string | null, detailsJson: unknown = null) => ({
    action,
    entity,
    entityId,
    detailsJson,
});

describe('auditPersonRef', () => {
    it('reads detailsJson.targetUserId first: a user, or an auditor account on the auditor rows', () => {
        expect(auditPersonRef(row('MEMBER_REMOVED', 'TenantMembership', 'm-1', { targetUserId: 'u-1' }))).toEqual({ kind: 'user', id: 'u-1' });
        expect(auditPersonRef(row('AUDITOR_INVITED', 'AuditorAccount', 'a-1', { targetUserId: 'a-1' }))).toEqual({ kind: 'auditor', id: 'a-1' });
        expect(auditPersonRef(row('AUDITOR_GRANTED', 'AuditorPackAccess', 'a-1_p-1', { targetUserId: 'a-1' }))).toEqual({ kind: 'auditor', id: 'a-1' });
    });

    it('reads the record the row is about when that record holds the person', () => {
        expect(auditPersonRef(row('SCIM_USER_CREATED', 'TenantMembership', 'u-2'))).toEqual({ kind: 'user', id: 'u-2' });
        expect(auditPersonRef(row('CREATE', 'Employee', 'e-1'))).toEqual({ kind: 'employee', id: 'e-1' });
        expect(auditPersonRef(row('MEMBER_INVITED', 'TenantInvite', 'i-1'))).toEqual({ kind: 'invite', id: 'i-1' });
        expect(auditPersonRef(row('VENDOR_ASSESSMENT_SENT', 'VendorAssessment', 'v-1'))).toEqual({ kind: 'respondent', id: 'v-1' });
        expect(auditPersonRef(row('VENDOR_ASSESSMENT_RESENT', 'VendorAssessment', 'v-1'))).toEqual({ kind: 'respondent', id: 'v-1' });
    });

    it('names nobody when the row is about no person', () => {
        expect(auditPersonRef(row('RISK_CREATED', 'Risk', 'r-1'))).toBeNull();
        // A membership row that is not SCIM's has the MEMBERSHIP id as entityId, not a user.
        expect(auditPersonRef(row('MEMBER_REMOVED', 'TenantMembership', 'm-1'))).toBeNull();
        // A vendor assessment row other than a send names no respondent.
        expect(auditPersonRef(row('VENDOR_ASSESSMENT_LINK_REVOKED', 'VendorAssessment', 'v-1'))).toBeNull();
        expect(auditPersonRef(row('MEMBER_REMOVED', 'TenantMembership', null, { targetUserId: '' }))).toBeNull();
        expect(auditPersonRef(row('X', 'Employee', null, ['not', 'an', 'object']))).toBeNull();
    });

    it('keys a reference by kind and id, so a user and an auditor with one id never collide', () => {
        expect(auditPersonKey({ kind: 'user', id: 'x' })).not.toBe(auditPersonKey({ kind: 'auditor', id: 'x' }));
    });
});
