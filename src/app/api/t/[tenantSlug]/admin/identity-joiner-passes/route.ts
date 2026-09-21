import { listJoinerPasses } from '@/app-layer/usecases/identity-joiner-run';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type JoinerPassParams = { tenantSlug: string };

/**
 * The joiner passes this tenant has run, most recent first.
 *
 * WHY THIS EXISTS. The write ladder mandates a seven-day observation before a
 * direction may be widened past DRY_RUN, and its refusal text says the point is
 * to compare the pass against what HR and IT actually did. Without a read
 * surface the joiner's artefact would exist only as a row nobody in the product
 * can reach — which is the same "sound mechanism, unreachable" gap #2687 was
 * opened about, moved one layer along.
 *
 * It is also what makes the run OBSERVABLE, which the joiner's half of
 * `DIRECTION_IMPLEMENTED` asks for in as many words: *"`implemented` means a
 * RUNTIME reads this setting AND an operator can see what it did."*
 *
 * GATED `admin.tenant_lifecycle`, the same OWNER-only key as the write policy
 * these passes run under, and the same key its leaver sibling carries.
 * Deliberately NOT `admin.manage`: the report names which of a customer's people
 * the product would create an account for, and under what address — reading that
 * is authority of the same class as granting it.
 *
 * The path is a SIBLING of `admin/identity-write-policy` rather than living
 * under `admin/integrations`, which matters more than it looks: route matching
 * is first-match-wins, and the `admin/integrations` rule resolves to
 * `admin.manage`, so a nested path would leave the permission map documenting a
 * weaker gate than the handler enforces.
 */
export const GET = withApiErrorHandling(
    requirePermission<JoinerPassParams>('admin.tenant_lifecycle', async (_req, _params, ctx) => {
        const passes = await listJoinerPasses(ctx);
        return jsonResponse({ passes });
    }),
);
