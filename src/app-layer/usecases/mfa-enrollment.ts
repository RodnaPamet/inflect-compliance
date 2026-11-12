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
import { auth } from '@/auth';
import { appendAuditEntry } from '@/lib/audit';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability';
import type { RequestContext } from '../types';
import type { VerifyMfaInputType } from '../schemas/mfa.schemas';
import {
    generateTotpSecret,
    generateTotpUri,
    encryptTotpSecret,
    decryptTotpSecret,
    matchTotpStep,
} from '@/lib/security/totp-crypto';
import { badRequest, forbidden, internal } from '@/lib/errors/types';
import { sendEmail } from '@/lib/mailer';
import {
    isOwnerManagedRole,
    OWNER_MANAGED_MFA_RESET_REFUSAL,
    ownerManagedMfaResetMessage,
} from '@/lib/roles';
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

    // Starting changes nothing a sign-in checks — the row is unverified until
    // a code proves it, and the route refuses a start over a verified one —
    // but it is the first half of adding a factor, so it is recorded (#4646).
    await logEvent(prisma, ctx, {
        action: 'MFA_ENROLLMENT_STARTED',
        entityType: 'UserMfaEnrollment',
        entityId: enrollment.id,
        details: 'Started setting up an authenticator app for MFA',
        detailsJson: mfaAccessDetails(ctx.userId, 'mfa_enrollment_started'),
    });

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
    const step = matchTotpStep(secret, input.code);

    if (step === null) {
        return { success: false, enrollmentId: enrollment.id };
    }

    // Mark as verified, and record the step: the code that proved the
    // enrolment is spent and cannot also pass the sign-in challenge.
    await prisma.userMfaEnrollment.update({
        where: { id: enrollment.id },
        data: {
            isVerified: true,
            verifiedAt: new Date(),
            lastAcceptedTotpStep: step,
        },
    });

    recordMfaEnrolled({ method: 'totp' });
    // The second factor now applies at sign-in: the event an auditor of an
    // authentication control most needs, and it was not recorded (#4646).
    await logEvent(prisma, ctx, {
        action: 'MFA_ENROLLED',
        entityType: 'UserMfaEnrollment',
        entityId: enrollment.id,
        details: 'Verified an authenticator app for MFA',
        detailsJson: mfaAccessDetails(ctx.userId, 'mfa_enrolled'),
    });
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

    // A session that has not satisfied its MFA challenge may not remove an
    // enrolment — its own least of all.
    //
    // This closes a hole that pre-dates the enrolment page being reachable
    // while `mfaPending`, and it is the reason that page can be reachable at
    // all. Under a REQUIRED policy an unenrolled user is `mfaPending` from
    // first sign-in and must be able to reach `/t/<slug>/security/mfa` to
    // enrol — but `isMfaAllowedPath` is PATH-scoped, not METHOD-scoped, so
    // opening the enrolment APIs necessarily opens this DELETE too. The edge
    // routes by path; the state check has to live here.
    //
    // Without it, a password alone defeats the second factor entirely through
    // the UI: sign in -> mfaPending -> reach the enrolment page -> Remove ->
    // enrol the attacker's own authenticator -> `lastChallengeAt >= token.iat`
    // -> `auth.ts` clears `mfaPending`. No crafted requests, no admin rights.
    //
    // It holds for the admin branch too, deliberately: an administrator who
    // has not completed their own challenge should not be removing anybody's
    // second factor. That is the same principle #2223 applies to every other
    // privileged surface.
    const session = await auth();
    if (session?.user?.mfaPending === true) {
        await auditMfaRemovalDenied(ctx, effectiveUserId);
        throw forbidden(
            'Complete the MFA challenge before changing enrollment. Removing a '
            + 'second factor requires having proven it.',
        );
    }

    // Non-admins can only remove their own enrollment
    if (effectiveUserId !== ctx.userId && !ctx.permissions.canAdmin) {
        await auditMfaRemovalDenied(ctx, effectiveUserId);
        throw forbidden('Only admins can remove other users\' MFA enrollment');
    }

    // Resetting an OWNER's or an AI_ADMIN's second factor takes an Owner
    // (#4926; owner decision, 2026-11-02), as deactivating one does. Read on
    // the membership in THIS tenant, whatever its status.
    if (effectiveUserId !== ctx.userId) {
        const target = await prisma.tenantMembership.findUnique({
            where: { tenantId_userId: { tenantId: ctx.tenantId, userId: effectiveUserId } },
            select: { role: true },
        });
        if (target && isOwnerManagedRole(target.role) && !ctx.appPermissions.admin.owner_management) {
            await auditMfaRemovalDenied(ctx, effectiveUserId);
            throw forbidden(ownerManagedMfaResetMessage(target.role), {
                reason: OWNER_MANAGED_MFA_RESET_REFUSAL,
            });
        }
    }

    const result = await prisma.userMfaEnrollment.deleteMany({
        where: {
            userId: effectiveUserId,
            tenantId: ctx.tenantId,
            type: 'TOTP',
        },
    });

    // A second factor taken away — by its owner, or by an admin for somebody
    // else — is recorded, naming whose it was (#4646). Nothing removed,
    // nothing recorded.
    if (result.count > 0) {
        const byAdmin = effectiveUserId !== ctx.userId;
        await logEvent(prisma, ctx, {
            action: 'MFA_REMOVED',
            // The enrolment row is gone; the member whose factor it was is not.
            entityType: 'User',
            entityId: effectiveUserId,
            details: byAdmin
                ? 'Removed another member\'s MFA authenticator'
                : 'Removed their own MFA authenticator',
            detailsJson: mfaAccessDetails(
                effectiveUserId,
                byAdmin ? 'mfa_removed_by_admin' : 'mfa_removed',
            ),
        });
        // The person is told when somebody else took their second factor
        // away (#4926): a reset they did not ask for is worth knowing about.
        if (byAdmin) await notifyMfaReset(ctx, effectiveUserId);
    }

    return { removed: result.count > 0 };
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Email a member whose MFA an admin reset (#4926). Best-effort: the reset has
 * happened and is audited, so a mail failure is logged, never thrown.
 */
async function notifyMfaReset(ctx: RequestContext, targetUserId: string): Promise<void> {
    try {
        const [target, actor, tenant] = await Promise.all([
            prisma.user.findUnique({ where: { id: targetUserId }, select: { email: true } }),
            prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true, email: true } }),
            prisma.tenant.findUnique({ where: { id: ctx.tenantId }, select: { name: true } }),
        ]);
        if (!target?.email) return;
        const workspace = tenant?.name ?? 'your workspace';
        const by = actor?.name?.trim() || actor?.email || 'An administrator';
        await sendEmail({
            to: target.email,
            subject: `Your MFA was reset in ${workspace}`,
            text:
                `${by} reset your multi-factor authentication in ${workspace}.\n\n` +
                'The next time you sign in to this workspace, you will set up an authenticator app again.\n\n' +
                'If you did not ask for this, tell an Owner of the workspace straight away.',
        });
    } catch (err) {
        logger.error('failed to send the MFA reset notice', {
            component: 'mfa-enrollment',
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * The `detailsJson` of an MFA enrolment change. `access` is the category an
 * auditor filters authentication events on; its schema is strict and its
 * operations a closed set, so the change is an access `permission_changed`
 * and `detail` names which one.
 */
function mfaAccessDetails(
    targetUserId: string,
    detail: 'mfa_enrollment_started' | 'mfa_enrolled' | 'mfa_removed' | 'mfa_removed_by_admin',
) {
    return { category: 'access', operation: 'permission_changed', targetUserId, detail } as const;
}

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
