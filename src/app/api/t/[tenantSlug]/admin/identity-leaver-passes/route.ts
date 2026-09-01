import { listLeaverPasses } from '@/app-layer/usecases/identity-leaver-pass';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type LeaverPassParams = { tenantSlug: string };

/**
 * The leaver passes this tenant has run, most recent first. NOT dry-run only
 * — the clamp was raised to AUTOMATIC by #2187, so a pass here may have
 * written to a real directory.
 *
 * WHY THIS EXISTS. The write ladder mandates a seven-day observation before a
 * tenant may be promoted past DRY_RUN, and its own refusal text says the point
 * is to compare the pass against "what HR and IT actually did". Until this
 * surface existed a pass left a log line and nothing else, and the promotion
 * gate counts ELAPSED days rather than observed runs — so the window could be
 * satisfied by time passing while nobody watched anything.
 *
 * GATED `admin.tenant_lifecycle`, the same OWNER-only key as the write policy
 * these passes execute under. Deliberately NOT `admin.manage`: the report names
 * which of a customer's people the product would have disabled, and reading
 * that is authority of the same class as granting it.
 *
 * The path is a SIBLING of `admin/identity-write-policy` rather than living
 * under `admin/integrations`, which matters more than it looks: route matching
 * is first-match-wins, and the `admin/integrations` rule resolves to
 * `admin.manage`, so a nested path would leave the permission map documenting a
 * weaker gate than the handler enforces.
 */
export const GET = withApiErrorHandling(
    requirePermission<LeaverPassParams>('admin.tenant_lifecycle', async (_req, _params, ctx) => {
        const passes = await listLeaverPasses(ctx);
        return jsonResponse({ passes });
    }),
);
