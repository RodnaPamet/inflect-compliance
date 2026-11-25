/**
 * Which person an audit row is about, by the id the row carries (#5950).
 *
 * Owner decision 2026-11-25: an audit row names a person by id only — no
 * e-mail address and no name in `details` or `detailsJson` — and a READER
 * resolves the id while the person exists. After an erasure only the id
 * remains. This module is the "which id" half: pure, client-safe, and read by
 * the Audit log page's server read, which resolves the reference to a label.
 *
 * The references, in the order they are asked:
 *
 *   - `detailsJson.targetUserId` — the convention every writer that names a
 *     person uses. On the auditor rows (`AuditorAccount`, `AuditorPackAccess`)
 *     it is the auditor's ACCOUNT id, which is not a user id; those resolve
 *     against the workspace's auditor list.
 *   - A SCIM row's `entityId`, which is the user id (`emitScimAudit`).
 *   - The row's own record when that record holds the person: an `Employee`
 *     row, a `TenantInvite` row (the invitee has no account yet), and a vendor
 *     assessment's send or resend (the respondent has none either).
 *
 * Rows written before #5950 may also carry an address or a name in their
 * text; the trail is immutable, so they keep it.
 */

export type AuditPersonKind = 'user' | 'auditor' | 'employee' | 'invite' | 'respondent';

export interface AuditPersonRef {
    kind: AuditPersonKind;
    id: string;
}

/** The audit row fields the reference is read from. */
export interface AuditPersonSource {
    action: string;
    entity: string;
    entityId: string | null;
    detailsJson: unknown;
}

const AUDITOR_ENTITIES = new Set(['AuditorAccount', 'AuditorPackAccess']);
const RESPONDENT_ACTIONS = new Set(['VENDOR_ASSESSMENT_SENT', 'VENDOR_ASSESSMENT_RESENT']);

function nonEmpty(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The person this row is about, or `null` when it names nobody by id. */
export function auditPersonRef(row: AuditPersonSource): AuditPersonRef | null {
    const details =
        row.detailsJson !== null && typeof row.detailsJson === 'object' && !Array.isArray(row.detailsJson)
            ? (row.detailsJson as Record<string, unknown>)
            : null;
    const target = nonEmpty(details?.targetUserId);
    if (target !== null) {
        return { kind: AUDITOR_ENTITIES.has(row.entity) ? 'auditor' : 'user', id: target };
    }
    const entityId = nonEmpty(row.entityId);
    if (entityId === null) return null;
    if (row.action.startsWith('SCIM_USER_') && row.entity === 'TenantMembership') return { kind: 'user', id: entityId };
    if (row.entity === 'Employee') return { kind: 'employee', id: entityId };
    if (row.entity === 'TenantInvite') return { kind: 'invite', id: entityId };
    if (row.entity === 'VendorAssessment' && RESPONDENT_ACTIONS.has(row.action)) return { kind: 'respondent', id: entityId };
    return null;
}

/** The map key a resolved label is stored under. */
export function auditPersonKey(ref: AuditPersonRef): string {
    return `${ref.kind}:${ref.id}`;
}
