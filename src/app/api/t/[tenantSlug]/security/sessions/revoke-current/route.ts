import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { revokeOtherSessions } from '@/app-layer/usecases/session-security';
import { currentSessionIdOf } from '@/lib/security/session-tracker';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/security/sessions/revoke-current
 *
 * "Sign Out Other Sessions": revokes every session of the caller's except the
 * one making this request, named by the JWT's `userSessionId` (#4117). When
 * that session cannot be identified, every session is revoked, this one
 * included, and `currentSessionKept` is false so the page can say so.
 * Audit logging is handled by the session-security usecase.
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const result = await revokeOtherSessions(ctx, await currentSessionIdOf(req));

    return jsonResponse({
        success: true,
        message: result.currentSessionKept
            ? 'Your other sessions have been revoked. This session stays signed in.'
            : 'All your sessions have been revoked, this one included. You will need to sign in again.',
        userId: result.userId,
        currentSessionKept: result.currentSessionKept,
        sessionsRevoked: result.sessionsRevoked,
    });
});
