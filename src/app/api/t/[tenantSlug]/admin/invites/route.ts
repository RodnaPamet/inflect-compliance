/**
 * /api/t/:slug/admin/invites
 *
 * GET  — list pending invites for the tenant.
 * POST — create a new invite token and email the acceptance link
 *        (rate-limited: 20/hr per tenant). Same implementation as
 *        `POST /admin/members` — see `../_lib/create-invite-handler.ts`.
 *
 * Both handlers require admin.members permission.
 */
import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listPendingInvites } from '@/app-layer/usecases/tenant-invites';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';
import { ASSIGNABLE_TENANT_ROLES } from '@/lib/roles';
import { createInvitePostHandler } from '../_lib/create-invite-handler';

const CreateInviteSchema = z.object({
    email: z.string().email('Valid email required'),
    // The writers' list: nobody is invited straight into AI_ADMIN (#3699). An
    // OWNER promotes an existing member on the members page instead.
    role: z.enum(ASSIGNABLE_TENANT_ROLES),
});

export const GET = withApiErrorHandling(
    requirePermission('admin.members', async (_req: NextRequest, _routeArgs, ctx) => {
        const invites = await listPendingInvites(ctx);
        return jsonResponse(invites);
    }),
);

export const POST = withApiErrorHandling(
    requirePermission('admin.members', async (req: NextRequest, _routeArgs, ctx) =>
        createInvitePostHandler(req, ctx, (body) => CreateInviteSchema.parse(body)),
    ),
);
