import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import * as policyUsecases from '@/app-layer/usecases/policy';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/policies/[id]/archive — archive one policy.
 *
 * Gated at the Epic C.1 layer as well as in the usecase (#2117). Its BULK twin,
 * `policies/bulk/archive`, has declared `['admin.manage', 'policies.edit']`
 * since the first tranche; this route ran the identical usecase gate
 * (`assertCanAdminPolicies`) with no route gate at all, so archiving one policy
 * at a time was the shape of the same action whose refusal went unrecorded.
 *
 * TWO keys, matching the bulk sibling, because `assertCanAdminPolicies` is a
 * CONJUNCTION — `assertCanAdmin` AND the granular `policies.edit` flag. A route
 * declaring only `admin.manage` would admit a custom role that holds
 * admin.manage but not policies.edit, which the usecase then refuses while
 * writing nothing: the same invisible denial one layer down.
 *
 * The usecase assert stays — it is what protects non-HTTP callers.
 */
type Params = { tenantSlug: string; id: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        ['admin.manage', 'policies.edit'],
        async (_req, { params }, ctx) => {
            const result = await policyUsecases.archivePolicy(ctx, params.id);
            return jsonResponse(result);
        },
    ),
);
