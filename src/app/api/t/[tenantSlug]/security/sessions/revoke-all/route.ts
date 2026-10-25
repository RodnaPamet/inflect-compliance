import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { revokeAllTenantSessions } from '@/app-layer/usecases/session-security';
import { currentSessionIdOf } from '@/lib/security/session-tracker';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/security/sessions/revoke-all
 *
 * Revoke every session of this tenant's ACTIVE members, wherever they signed
 * in — a session belongs to the person, so this signs them out of every
 * workspace. Deactivated members are left alone, and the caller's current
 * session is kept (#4117).
 * Gated by `admin.members` (Epic D.3) — managing colleagues' active
 * sessions is a member-management action.
 * Audit logging is handled by the session-security usecase.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.members', async (req: NextRequest, _routeArgs, ctx) => {
        const result = await revokeAllTenantSessions(ctx, await currentSessionIdOf(req));
        return jsonResponse({
            success: true,
            message: `Sessions revoked for ${result.usersAffected} users.`,
            usersAffected: result.usersAffected,
            currentSessionKept: result.currentSessionKept,
        });
    }),
);
