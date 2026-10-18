import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listTenantMembers } from '@/app-layer/usecases/tenant-admin';
import { createInviteToken, listPendingInvites } from '@/app-layer/usecases/tenant-invites';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';
import { ASSIGNABLE_TENANT_ROLES } from '@/lib/roles';

const InviteMemberSchema = z.object({
    email: z.string().email('Valid email required'),
    // The roles a writer may write — AI_ADMIN is refused until deploy 2 of #3699.
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

export const POST = withApiErrorHandling(
    requirePermission('admin.members', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await req.json();
        const input = InviteMemberSchema.parse(body);
        const result = await createInviteToken(ctx, input);
        // Response always returns the invite (no more 'added'/'reactivated' branch).
        return jsonResponse({ invite: result.invite, url: result.url }, { status: 201 });
    }),
);
