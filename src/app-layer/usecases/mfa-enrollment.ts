/**
 * MFA Enrollment Usecases
 *
 * TOTP enrollment lifecycle:
 * - startMfaEnrollment: generates secret, encrypts, stores unverified
 * - verifyMfaEnrollment: validates TOTP code, marks as verified
 * - removeMfaEnrollment: removes enrollment (admin or self)
 *
 * SECURITY: Secrets are encrypted with AES-256-GCM. Never logged in plaintext.
 */
import { prisma } from '@/lib/prisma';
import { appendAuditEntry } from '@/lib/audit';
import { logger } from '@/lib/observability';
import type { RequestContext } from '../types';
import type { VerifyMfaInputType } from '../schemas/mfa.schemas';
import {
    generateTotpSecret,
    generateTotpUri,
    encryptTotpSecret,
    decryptTotpSecret,
    verifyTotpCode,
} from '@/lib/security/totp-crypto';
import { badRequest, forbidden, internal } from '@/lib/errors/types';
import { env } from '@/env';
import { recordMfaEnrolled } from '@/lib/observability/business-metrics';

// ─── Types ──────────────────────────────────────────────────────────

export interface MfaEnrollmentStartResult {
    secret: string;     // Base32-encoded TOTP secret (shown ONCE to user)
    uri: string;        // otpauth:// URI for QR code
    enrollmentId: string;
}

export interface MfaEnrollmentVerifyResult {
    success: boolean;
    enrollmentId: string;
}

// ─── Start Enrollment ───────────────────────────────────────────────

/**
 * Starts MFA enrollment for the current user.
 * Generates a TOTP secret, encrypts it, and stores an unverified enrollment.
 * If an unverified enrollment already exists, replaces it.
 *
 * Returns the plaintext secret and otpauth URI for the user to scan.
 * The secret is ONLY returned here — it cannot be retrieved after.
 */
export async function startMfaEnrollment(
    ctx: RequestContext,
): Promise<MfaEnrollmentStartResult> {
    const authSecret = getAuthSecret();

    // Generate new TOTP secret
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret, authSecret);

    // Look up user email for the URI
    const user = await prisma.user.findUniqueOrThrow({
        where: { id: ctx.userId },
        select: { email: true },
    });

    // Upsert: replace any existing unverified enrollment, or create new
    const enrollment = await prisma.userMfaEnrollment.upsert({
        where: {
            userId_tenantId_type: {
                userId: ctx.userId,
                tenantId: ctx.tenantId,
                type: 'TOTP',
            },
        },
        create: {
            userId: ctx.userId,
            tenantId: ctx.tenantId,
            type: 'TOTP',
            secretEncrypted: encrypted,
            isVerified: false,
        },
        update: {
            secretEncrypted: encrypted,
            isVerified: false,
            verifiedAt: null,
        },
    });

    const uri = generateTotpUri(secret, user.email);

    return {
        secret,
        uri,
        enrollmentId: enrollment.id,
    };
}

// ─── Verify Enrollment ──────────────────────────────────────────────

/**
 * Verifies a TOTP code against the user's enrollment.
 * If valid, marks the enrollment as verified.
 * If no enrollment exists or it's already verified, throws.
 */
export async function verifyMfaEnrollment(
    ctx: RequestContext,
    input: VerifyMfaInputType,
): Promise<MfaEnrollmentVerifyResult> {
    const authSecret = getAuthSecret();

    const enrollment = await prisma.userMfaEnrollment.findUnique({
        where: {
            userId_tenantId_type: {
                userId: ctx.userId,
                tenantId: ctx.tenantId,
                type: 'TOTP',
            },
        },
    });

    if (!enrollment) {
        throw badRequest('No MFA enrollment found. Start enrollment first.');
    }

    if (enrollment.isVerified) {
        throw badRequest('MFA is already verified for this account.');
    }

    // Decrypt secret and verify code
    const secret = decryptTotpSecret(enrollment.secretEncrypted, authSecret);
    const isValid = verifyTotpCode(secret, input.code);

    if (!isValid) {
        return { success: false, enrollmentId: enrollment.id };
    }

    // Mark as verified
    await prisma.userMfaEnrollment.update({
        where: { id: enrollment.id },
        data: {
            isVerified: true,
            verifiedAt: new Date(),
        },
    });

    recordMfaEnrolled({ method: 'totp' });
    return { success: true, enrollmentId: enrollment.id };
}

// ─── Remove Enrollment ──────────────────────────────────────────────

/**
 * Removes MFA enrollment for a user. Allowed for:
 * - The user themselves (self-service, only if tenant policy allows)
 * - An admin (force-remove for any user in the tenant)
 *
 * THE ADMIN BRANCH IS AN AUTHORIZATION DECISION, AND IT IS AUDITED HERE.
 *
 * Removing somebody else's second factor is the highest-value action on this
 * surface: it turns an account defended by two factors into one defended by a
 * password. A refused attempt at it is precisely what a reviewer looks for
 * after a compromise, and until #2117 it left no trace — `forbidden()` throws
 * and writes nothing, and `AUTHZ_DENIED` was written only by
 * `requirePermission` at the route layer.
 *
 * The route cannot carry that gate. `DELETE /security/mfa/enroll` is dual-mode:
 * with no body it removes the CALLER's enrolment and every member may do it;
 * with `targetUserId` it is an admin action. One route-level permission would
 * either break self-service or admit everyone, so the decision has to live
 * where the two modes are distinguishable — which is here.
 *
 * The write is best-effort and swallows its own failures, matching
 * `auditPermissionDenied`: a refusal must reach the caller even if audit
 * storage is down. It is awaited rather than fired-and-forgotten because
 * `appendAuditEntry` takes a per-tenant advisory lock inside its own
 * transaction, and this function holds none.
 */
export async function removeMfaEnrollment(
    ctx: RequestContext,
    targetUserId?: string,
): Promise<{ removed: boolean }> {
    const effectiveUserId = targetUserId || ctx.userId;

    // Non-admins can only remove their own enrollment
    if (effectiveUserId !== ctx.userId && !ctx.permissions.canAdmin) {
        await auditMfaRemovalDenied(ctx, effectiveUserId);
        throw forbidden('Only admins can remove other users\' MFA enrollment');
    }

    const result = await prisma.userMfaEnrollment.deleteMany({
        where: {
            userId: effectiveUserId,
            tenantId: ctx.tenantId,
            type: 'TOTP',
        },
    });

    return { removed: result.count > 0 };
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Record a refused attempt to strip another user's MFA.
 *
 * Shape mirrors `auditPermissionDenied` in the permission middleware so the two
 * are one population when an auditor filters on `action: 'AUTHZ_DENIED'` — same
 * entity, same `category: 'access'`, same never-throws contract. `entityId`
 * names the coarse predicate the check actually read (`permissions.canAdmin`),
 * not a `PermissionKey`, because this decision is not keyed on one and claiming
 * otherwise would put a key in the trail that no route gates on.
 *
 * `targetUserId` is recorded: who was attacked is the whole point of the row,
 * and it is an opaque id, not an email.
 */
async function auditMfaRemovalDenied(ctx: RequestContext, targetUserId: string): Promise<void> {
    try {
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            entity: 'Permission',
            entityId: 'permissions.canAdmin',
            action: 'AUTHZ_DENIED',
            details: 'Denied removal of another user\'s MFA enrollment',
            detailsJson: {
                category: 'access',
                event: 'authz_denied',
                operation: 'mfa_enrollment_remove',
                role: ctx.role,
                targetUserId,
            },
        });
    } catch (err) {
        logger.error('failed to record an MFA-removal denial', {
            component: 'mfa-enrollment',
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

function getAuthSecret(): string {
    const secret = env.AUTH_SECRET;
    if (!secret) {
        throw internal('AUTH_SECRET environment variable is required for MFA operations');
    }
    return secret;
}
