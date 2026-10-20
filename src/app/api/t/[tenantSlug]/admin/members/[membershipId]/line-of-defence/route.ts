/**
 * `PUT /api/t/:slug/admin/members/:membershipId/line-of-defence` — declare the
 * line of defence a member sits in (#3675, step 3b).
 *
 * Body `{ lineOfDefence: 'FIRST' | 'SECOND' | 'THIRD' | null }`; `null` clears
 * it to "not declared", which never satisfies a check. Returns the line before
 * and after, whether it changed, and the ids of any auditor-independence
 * findings the change raised (an auditor agent's owner moved off SECOND).
 *
 * `admin.owner_management`, which among the built-in roles only OWNER holds:
 * ADMIN is denied it explicitly and AI_ADMIN never had it, and no API key
 * carries it. The usecase also requires the caller's built-in role to be OWNER
 * and refuses a member setting their own line (`setMembershipLineOfDefence`).
 * The rule sits ABOVE the `admin/members(/.*)?` catch-all in
 * `ROUTE_PERMISSIONS`, which matches first-wins and would otherwise record
 * `admin.members`, a key ADMIN holds.
 *
 * The members page shows every member's line and, for an OWNER, sets it on
 * any membership but their own through this route (#3807).
 */
import type { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { setMembershipLineOfDefence } from '@/app-layer/usecases/membership-line-of-defence';

type Params = { tenantSlug: string; membershipId: string };

export const PUT = withApiErrorHandling(
    requirePermission<Params>('admin.owner_management', async (req: NextRequest, { params }, ctx) => {
        const result = await setMembershipLineOfDefence(ctx, params.membershipId, await req.json());
        return jsonResponse(result);
    }),
);
