import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listTenantMembers } from '@/app-layer/usecases/tenant-admin';
import { listPendingInvites } from '@/app-layer/usecases/tenant-invites';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';
import { ASSIGNABLE_TENANT_ROLES } from '@/lib/roles';
import { createInvitePostHandler } from '../_lib/create-invite-handler';

const InviteMemberSchema = z.object({
    email: z.string().email('Valid email required'),
    // The writers' list: nobody is invited straight into AI_ADMIN (#3699). An
    // OWNER promotes an existing member on the members page instead.
    role: z.enum(ASSIGNABLE_TENANT_ROLES),
});

export const GET = withApiErrorHandling(
    requirePermission('admin.members', async (req: NextRequest, _routeArgs, ctx) => {
        const sp = req.nextUrl.searchParams;
        const view = sp.get('view');

        if (view === 'invites') {
            const invites = await listPendingInvites(ctx);
            return jsonResponse(invites);
        }

        const members = await listTenantMembers(ctx);
        return jsonResponse(members);
    }),
);

/**
 * The members page's "Invite Member" form. Creates the invite AND emails
 * the acceptance link — the same implementation as `POST /admin/invites`
 * (`../_lib/create-invite-handler.ts`). The response carries `emailSent`,
 * which is false when no mailer is configured or the send failed, so the
 * page only says "emailed" when it was.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.members', async (req: NextRequest, _routeArgs, ctx) =>
        createInvitePostHandler(req, ctx, (body) => InviteMemberSchema.parse(body)),
    ),
);
