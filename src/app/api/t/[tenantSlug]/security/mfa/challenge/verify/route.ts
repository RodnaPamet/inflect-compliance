import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { VerifyMfaInput } from '@/app-layer/schemas/mfa.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { checkRateLimit, resetRateLimit, MFA_VERIFY_LIMIT } from '@/lib/security/rate-limit';
import { verifyMfaChallenge } from '@/app-layer/usecases/mfa-challenge';
import { env } from '@/env';
import { jsonResponse } from '@/lib/api-response';
import { activeMemberWorkspaceId } from '@/lib/auth/workspace-mfa';

/**
 * POST /api/t/[tenantSlug]/security/mfa/challenge/verify
 *
 * Verifies a TOTP code during the MFA challenge (login flow).
 * On success, clears the mfaPending flag by updating lastChallengeAt.
 *
 * Rate limited: 5 attempts per 15 min, 5 min lockout.
 *
 * Body: { code: "123456" }
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    // Get current session
    const session = await auth();
    if (!session?.user?.id) {
        return jsonResponse({ error: 'Not authenticated' }, { status: 401 });
    }

    const userId = session.user.id;

    // The code is checked against the workspace in the URL, whose enrolment
    // it belongs to. It used to be checked against the session's primary
    // workspace whatever the URL said, which was the only workspace whose
    // policy was ever asked (src/lib/auth/workspace-mfa.ts). The edge sends a
    // pending primary to its own challenge page, so that case is unchanged.
    const { tenantSlug } = await paramsPromise;
    const tenantId = await activeMemberWorkspaceId(userId, tenantSlug);
    if (!tenantId) {
        return jsonResponse({ error: 'No tenant context' }, { status: 400 });
    }

    // ── Rate Limit Check ────────────────────────────────────────────
    const rateLimitKey = `mfa-challenge:${userId}`;
    const rateCheck = checkRateLimit(rateLimitKey, MFA_VERIFY_LIMIT);

    if (!rateCheck.allowed) {
        const retrySeconds = Math.ceil(rateCheck.retryAfterMs / 1000);
        return jsonResponse(
            {
                success: false,
                error: `Too many verification attempts. Please try again in ${retrySeconds} seconds.`,
                retryAfterMs: rateCheck.retryAfterMs,
            },
            { status: 429 },
        );
    }

    // Parse body
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid request' }, { status: 400 });
    }

    const parsed = VerifyMfaInput.safeParse(body);
    if (!parsed.success) {
        return jsonResponse(
            { error: 'Invalid code format' },
            { status: 400 },
        );
    }

    // Delegate to usecase
    const result = await verifyMfaChallenge(userId, tenantId, parsed.data.code, rateCheck.remaining);

    if (!result.success) {
        return jsonResponse({
            success: false,
            error: result.message,
            remaining: result.remaining,
        });
    }

    // Reset rate limit on success
    resetRateLimit(rateLimitKey);

    const response = jsonResponse({
        success: true,
        message: result.message,
    });

    // Set mfa-cleared cookie for JWT callback to detect
    response.cookies.set('mfa-cleared', userId, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 300,
        secure: env.NODE_ENV === 'production',
    });

    return response;
});
