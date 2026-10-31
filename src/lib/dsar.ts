/**
 * DSAR (Data Subject Access Request) — constants + pure decision logic.
 *
 * GDPR Art. 15 (export) + Art. 17 (erasure). This module is the
 * dependency-free core of the DSAR workflow: the rejection criteria, the
 * cooling-off + export-TTL windows, the audit-action names, and the pure
 * `evaluateDsarRejection` decision (unit-testable without a DB).
 *
 * FOUNDATION (Stage 1): execution (export bundle, erasure cascade) is NOT
 * wired — see src/app-layer/jobs/dsar-export.ts + dsar-erasure.ts and the
 * multi-PR sequence in docs/dsar.md.
 *
 * @module lib/dsar
 */

/**
 * Reasons a DSAR cannot be honored as submitted. Stored in
 * `DataSubjectRequest.rejectionReason` when status = REJECTED.
 */
export const DSAR_REJECTION_REASONS = {
    /** User is the sole ACTIVE OWNER of a tenant — erasure would orphan it.
     *  Resolve by transferring ownership OR deleting the tenant first. */
    LAST_OWNER: 'last_owner',
    /** Unpaid billing — finance must resolve before erasure. */
    OUTSTANDING_BALANCE: 'outstanding_balance',
    /** Active legal hold (reserved — the hold feature is a future addition). */
    LEGAL_HOLD: 'legal_hold',
} as const;

export type DsarRejectionReason =
    (typeof DSAR_REJECTION_REASONS)[keyof typeof DSAR_REJECTION_REASONS];

/**
 * Cooling-off window: an ERASURE job must NOT fire until this many hours
 * after the request reaches VERIFIED, giving the user time to cancel an
 * irreversible deletion. Enforced in src/app-layer/jobs/dsar-erasure.ts.
 */
export const DSAR_COOLING_OFF_HOURS = 24;

/** Export-bundle signed-URL lifetime; deleted after consumption or expiry. */
export const DSAR_EXPORT_TTL_DAYS = 7;

/** Audit-action names emitted on every DSAR state transition (category access). */
export const DSAR_AUDIT_ACTIONS = {
    REQUESTED: 'DSAR_REQUESTED',
    VERIFIED: 'DSAR_VERIFIED',
    /** Work began on a verified request (#4818: was recorded as VERIFIED). */
    STARTED: 'DSAR_STARTED',
    CANCELED: 'DSAR_CANCELED',
    COMPLETED: 'DSAR_COMPLETED',
    REJECTED: 'DSAR_REJECTED',
} as const;

/** Inputs to the rejection decision — gathered by the caller, evaluated here. */
export interface DsarRejectionInput {
    /** Number of tenants where the requester is the SOLE active OWNER. */
    soleOwnerTenantCount: number;
    /** Whether the requester's account carries an unpaid balance. */
    hasOutstandingBalance: boolean;
    /** Whether an active legal hold applies to the requester. */
    hasLegalHold: boolean;
}

/**
 * Decide whether an ERASURE request must be rejected, and why. Pure and
 * order-stable (LAST_OWNER first — it's the most common and most
 * actionable by the user). Returns `null` when the request may proceed.
 *
 * EXPORT requests are never rejected by these criteria (exporting a copy
 * is always safe) — callers apply this only to ERASURE.
 */
export function evaluateDsarRejection(
    input: DsarRejectionInput,
): DsarRejectionReason | null {
    if (input.soleOwnerTenantCount > 0) return DSAR_REJECTION_REASONS.LAST_OWNER;
    if (input.hasOutstandingBalance) return DSAR_REJECTION_REASONS.OUTSTANDING_BALANCE;
    if (input.hasLegalHold) return DSAR_REJECTION_REASONS.LEGAL_HOLD;
    return null;
}

/**
 * The register shows at most this many requests. The usecase reads one more,
 * so the page can tell a full register from a cut one and say so (#4818).
 */
export const DSAR_REGISTER_CAP = 500;
