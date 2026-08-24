import { NextRequest } from 'next/server';
import { bulkDeletePolicy } from '@/app-layer/usecases/policy';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkPolicyDeleteSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/policies/bulk/delete
 *
 * TWO keys, `all` mode, because `assertCanAdminPolicies` is itself a
 * conjunction: the coarse ADMIN tier AND the granular `policies.edit`
 * flag (see policy.policies.ts). Declaring both NARROWS the silent-refusal
 * window — it does not close it, and the difference matters.
 *
 * What it closes: a custom role holding `admin.manage` but not
 * `policies.edit` passed a one-key gate and was thrown out silently by the
 * usecase. It is now refused here, with an AUTHZ_DENIED row.
 *
 * What it does NOT close: `admin.manage` and `assertCanAdmin` are different
 * predicates over different views of the context. The assert reads
 * `ctx.permissions.canAdmin`, derived from `customRole.baseRole ?? role`,
 * which IGNORES `permissionsJson`; the route key reads
 * `ctx.appPermissions.admin.manage`, which honours it. So a role with
 * `baseRole: 'EDITOR'` and `admin: { manage: true }` — mintable, since
 * `assertGrantWithinOwnAuthority` only blocks granting what the grantor
 * lacks — passes this gate, reaches the usecase, and is refused there with
 * no audit row. Closing that needs the two predicates reconciled, which is
 * a larger change than this one.
 *
 * The usecase assert stays. It is what protects non-HTTP callers. See #2117.
 */
export const POST = withApiErrorHandling(
    requirePermission(['admin.manage', 'policies.edit'], async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, BulkPolicyDeleteSchema);
        const result = await bulkDeletePolicy(ctx, body.policyIds);
        return jsonResponse(result);
    }),
);
