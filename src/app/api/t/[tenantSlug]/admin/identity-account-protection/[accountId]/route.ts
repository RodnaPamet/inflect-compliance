import { z } from 'zod';
import { setAccountProtection, MAX_PROTECTION_REASON } from '@/app-layer/usecases/identity-account-protection';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type ProtectionParams = { tenantSlug: string; accountId: string };

const BodySchema = z.object({
    isProtected: z.boolean(),
    reason: z.string().max(MAX_PROTECTION_REASON).nullish(),
});

/**
 * Mark one directory account as never-offboard, or release it.
 *
 * GATED `admin.tenant_lifecycle` — the same OWNER-only key as the write policy
 * this flag overrides. Deliberately not `admin.manage`: deciding that the
 * product may NOT disable an account is authority of the same class as deciding
 * that it may, and the two should not sit at different rungs.
 *
 * A SIBLING PATH of admin/identity-write-policy and admin/identity-leaver-passes
 * rather than nested under admin/integrations/identity-accounts, where the
 * roster GET lives. Route matching is first-match-wins and the
 * `admin/integrations` rule resolves to `admin.manage`, so a nested path would
 * leave the permission map documenting a weaker gate than this handler enforces
 * — and no guardrail catches that disagreement. Choosing the path dissolves the
 * hazard instead of navigating it.
 */
export const PATCH = withApiErrorHandling(
    // Destructured as `{ params }`, then awaited: under the Next 15+ runtime the
    // route export receives `params` as a Promise, and the wrapper forwards
    // routeArgs rather than the resolved object.
    requirePermission<ProtectionParams>('admin.tenant_lifecycle', async (req, { params }, ctx) => {
        const { accountId } = await params;
        const body = BodySchema.parse(await req.json());
        const state = await setAccountProtection(ctx, accountId, {
            isProtected: body.isProtected,
            reason: body.reason ?? null,
        });
        return jsonResponse({ protection: state });
    }),
);
