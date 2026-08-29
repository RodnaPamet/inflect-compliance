import { grantAuditorAccess, revokeAuditorAccess } from '@/app-layer/usecases/audit-readiness';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

// Per-pack auditor access grant/revoke. Authorization is enforced BOTH at the
// route (`requirePermission`, whose denials write an AUTHZ_DENIED row) and in
// the usecase (`assertCanManageAuditors`, OWNER/ADMIN only, which protects
// non-HTTP callers). Before #2117 only the second existed, so handing an
// outside auditor access to a pack — or being refused while trying to — left
// no trace in the one artefact this product exists to produce.
//
// `admin.manage` rather than `audits.manage`: see the sibling
// `[auditorId]/route.ts` for why the audits-domain key would reopen the hole
// for custom roles.
//
// The body is read with `parseJsonBody` INSIDE the handler rather than by
// composing `withValidatedBody`, whose handler takes the parsed body in the
// third argument `requirePermission` uses for `ctx`. Authorization therefore
// runs BEFORE the body is parsed, which is the order we want.
const AccessSchema = z.object({
    auditorId: z.string().min(1),
    packId: z.string().min(1),
}).strip();

type AccessParams = { tenantSlug: string };

export const POST = withApiErrorHandling(
    requirePermission<AccessParams>('admin.manage', async (req, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, AccessSchema);
        return jsonResponse(await grantAuditorAccess(ctx, body.auditorId, body.packId), { status: 201 });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<AccessParams>('admin.manage', async (req, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, AccessSchema);
        return jsonResponse(await revokeAuditorAccess(ctx, body.auditorId, body.packId));
    }),
);
