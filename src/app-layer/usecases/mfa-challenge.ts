/**
 * MFA Challenge Usecase
 *
 * Handles TOTP challenge verification during the login flow.
 * This is separate from enrollment verification — challenge is for
 * enrolled users at login time.
 *
 * Audit events: MFA_CHALLENGE_PASSED, MFA_CHALLENGE_FAILED
 */
import { prisma } from '@/lib/prisma';
import { decryptTotpSecret, matchTotpStep } from '@/lib/security/totp-crypto';
import { logEvent } from '../events/audit';
import type { RequestContext } from '../types';
import { badRequest, internal } from '@/lib/errors/types';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { getPermissionsForRole } from '@/lib/permissions';

export interface MfaChallengeResult {
    success: boolean;
    message: string;
    remaining?: number;
}

/**
 * Verifies a TOTP code during the MFA login challenge.
 *
 * A pass is bound to the session that answered it: on success this session's
 * `UserSession.mfaPassedTenantIds` gains the workspace, and the jwt callback
 * clears a pending workspace only when the session's own row lists it. A
 * session the request cannot name (`userSessionId` null) cannot pass, because
 * nothing would bind the pass to it.
 *
 * A code is accepted once: the enrolment records the time step of the last
 * accepted code, and a code is accepted only for a later step, claimed with a
 * conditional update so two concurrent uses cannot both win.
 */
export async function verifyMfaChallenge(
    userId: string,
    tenantId: string,
    code: string,
    remaining: number,
    userSessionId: string | null,
): Promise<MfaChallengeResult> {
    logger.info('mfa challenge started', { component: 'mfa', userId });

    // Look up enrollment
    const enrollment = await prisma.userMfaEnrollment.findUnique({
        where: {
            userId_tenantId_type: {
                userId,
                tenantId,
                type: 'TOTP',
            },
        },
    });

    if (!enrollment || !enrollment.isVerified) {
        throw badRequest('MFA not configured. Please set up MFA first.');
    }

    // Decrypt and verify
    const authSecret = env.AUTH_SECRET;
    if (!authSecret) {
        throw internal('Server configuration error');
    }

    // The session this pass will belong to: this user's, and still live.
    const session = userSessionId
        ? await prisma.userSession.findUnique({
              where: { sessionId: userSessionId },
              select: { userId: true, revokedAt: true, expiresAt: true },
          })
        : null;
    if (!session || session.userId !== userId || session.revokedAt || session.expiresAt <= new Date()) {
        logger.warn('mfa challenge refused: no live session to bind the pass to', { component: 'mfa', userId });
        return {
            success: false,
            message: 'Your sign-in could not be confirmed. Sign out, sign in again and enter a new code.',
            remaining,
        };
    }

    const secret = decryptTotpSecret(enrollment.secretEncrypted, authSecret);
    const step = matchTotpStep(secret, code);
    // Accept the code only for a step later than the last accepted one. The
    // conditional update is the claim: of two requests carrying the same
    // code, one updates the row and the other finds nothing to update.
    const claimed =
        step === null
            ? 0
            : (
                  await prisma.userMfaEnrollment.updateMany({
                      where: {
                          id: enrollment.id,
                          OR: [{ lastAcceptedTotpStep: null }, { lastAcceptedTotpStep: { lt: step } }],
                      },
                      data: { lastAcceptedTotpStep: step, lastChallengeAt: new Date() },
                  })
              ).count;
    const isValid = claimed === 1;

    // Build a minimal audit context (challenge route doesn't have full RequestContext)
    const auditCtx: RequestContext = {
        tenantId,
        userId,
        role: 'READER' as const,
        permissions: { canAdmin: false, canWrite: false, canRead: true, canAudit: false, canExport: false },
        appPermissions: getPermissionsForRole('READER'),
        requestId: crypto.randomUUID(),
    };

    if (!isValid) {
        // Audit: failed challenge
        try {
            await logEvent(prisma, auditCtx, {
                action: 'MFA_CHALLENGE_FAILED',
                entityType: 'User',
                entityId: userId,
                details: `MFA challenge failed. ${remaining} attempts remaining.`,
                detailsJson: {
                    category: 'access',
                    operation: 'login',
                    detail: `MFA challenge failed. ${remaining} attempts remaining.`,
                },
            });
        } catch { /* audit is best-effort */ }

        logger.warn('mfa challenge failed', { component: 'mfa', userId, remaining });
        return {
            success: false,
            message: 'Invalid or already-used code. Check your authenticator app, or wait for its next code.',
            remaining,
        };
    }

    // Success — bind the pass to this session.
    await prisma.userSession.update({
        where: { sessionId: userSessionId! },
        data: { mfaPassedTenantIds: { push: tenantId } },
    });

    // Audit: passed challenge
    try {
        await logEvent(prisma, auditCtx, {
            action: 'MFA_CHALLENGE_PASSED',
            entityType: 'User',
            entityId: userId,
            details: 'MFA challenge passed successfully.',
            detailsJson: {
                category: 'access',
                operation: 'login',
                detail: 'MFA challenge passed successfully.',
            },
        });
    } catch { /* audit is best-effort */ }

    logger.info('mfa challenge passed', { component: 'mfa', userId });
    return {
        success: true,
        message: 'MFA verification successful',
    };
}
