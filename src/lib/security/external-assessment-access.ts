/**
 * Epic G-3 — External vendor-assessment access verification.
 *
 * The shared share-link flow relies on a 32-byte random token
 * embedded in the email URL. Only its SHA-256 hash lives in the
 * database (`VendorAssessment.externalAccessTokenHash`). This module
 * implements the constant-time hash check + lifecycle gates that
 * every public route must run before reading or writing the
 * assessment.
 *
 * Surface contract:
 *
 *   verifyAccessToken(rawToken, assessmentId) → result
 *
 *     - The raw token comes from the URL `?t=...`. The caller is
 *       responsible for never logging it.
 *     - assessmentId is the URL path param.
 *     - On any failure (missing token, wrong assessment, expired,
 *       wrong status) the result is `{ ok: false, reason }` — no
 *       row is returned. Reasons are intentionally narrow so
 *       callers can map them to 401 / 410 without leaking which
 *       guard tripped.
 *
 * Tenant isolation: `verifyAccessToken` runs OUTSIDE
 * `runInTenantContext` because the public flow has no tenant
 * context at request time. The assessment row carries its own
 * tenantId; subsequent reads/writes wrap that tenantId in
 * `runInTenantContext` so RLS still gates the data layer.
 *
 * @module security/external-assessment-access
 */
import { createHash, timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/prisma';
import type { VendorAssessment } from '@prisma/client';

export type AccessVerificationFailure =
    | 'missing_token'
    | 'unknown_assessment'
    | 'wrong_assessment'
    | 'expired'
    | 'revoked'
    | 'wrong_status';

export interface AccessVerificationOk {
    ok: true;
    assessment: VendorAssessment;
}
export interface AccessVerificationFail {
    ok: false;
    reason: AccessVerificationFailure;
}
export type AccessVerificationResult =
    | AccessVerificationOk
    | AccessVerificationFail;

/**
 * SHA-256 the raw token. Hex-encoded so it matches what
 * `mintExternalAccessToken` in the send usecase persists.
 */
export function hashAccessToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Constant-time string comparison. Avoids subtle timing-attack
 * channels even though the SHA-256 hash already obscures the
 * raw token at rest.
 */
function constantTimeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The set of statuses an external respondent is allowed to act on.
 * Outside this set the link surfaces as "no longer active".
 */
const ALLOWED_STATUSES = new Set<VendorAssessment['status']>([
    'SENT',
    'IN_PROGRESS',
]);

/**
 * Verify an external access token and return the matched assessment.
 *
 * The lookup uses the indexed `externalAccessTokenHash` column. The
 * assessmentId path param is checked AFTER the hash match so an
 * attacker probing path-id values without a token still gets a
 * uniform "missing_token" / "wrong_assessment" mapping rather than
 * a database-load oracle.
 */
export async function verifyAccessToken(
    rawToken: string | null | undefined,
    assessmentId: string,
): Promise<AccessVerificationResult> {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 16) {
        return { ok: false, reason: 'missing_token' };
    }

    const hash = hashAccessToken(rawToken);

    // Lookup by hash. The (externalAccessTokenHash) index makes this
    // O(log n).
    const assessment = await prisma.vendorAssessment.findFirst({
        where: { externalAccessTokenHash: hash },
    });
    if (!assessment) return { ok: false, reason: 'unknown_assessment' };

    // Mismatch between path id and hashed-token's assessment id.
    if (!constantTimeEquals(assessment.id, assessmentId)) {
        return { ok: false, reason: 'wrong_assessment' };
    }

    if (
        assessment.externalAccessTokenExpiresAt &&
        assessment.externalAccessTokenExpiresAt.getTime() < Date.now()
    ) {
        return { ok: false, reason: 'expired' };
    }

    // Operator-initiated kill switch. Checked alongside expiry rather than
    // folded into it, because the two are different events: expiry is the
    // link reaching its planned end, revocation is someone deciding the
    // link is compromised. Both deny; only this one is a deliberate act.
    if (assessment.revokedAt) {
        return { ok: false, reason: 'revoked' };
    }

    if (!ALLOWED_STATUSES.has(assessment.status)) {
        return { ok: false, reason: 'wrong_status' };
    }

    return { ok: true, assessment };
}
