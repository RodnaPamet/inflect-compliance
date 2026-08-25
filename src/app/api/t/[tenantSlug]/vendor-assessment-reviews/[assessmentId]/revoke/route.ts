/**
 * POST /api/t/[tenantSlug]/vendor-assessment-reviews/[assessmentId]/revoke
 *
 * Kill the external respondent link in place.
 *
 * Distinct from `resend`, which mints a FRESH token and therefore
 * invalidates whatever link is already circulating — the wrong tool when a
 * link has leaked and the goal is simply to stop it working. Revoke sets
 * `revokedAt`, which `verifyAccessToken` denies on, without touching the
 * token or the assessment's status.
 *
 * Idempotent: revoking an already-revoked link returns the original
 * timestamp rather than erroring.
 *
 * ─── Why the route gate (#2117) ────────────────────────────────────
 *
 * Revoking is a credential-lifecycle verb, and the security value of one is
 * that the attempt is on the record whichever way it goes. Before this the
 * route authorized only through `revokeAssessmentLink`'s
 * `assertCanRunAssessment`: a correct 403, and no row — `AUTHZ_DENIED` is
 * written by `requirePermission` and by nothing else. A denied revoke of a
 * leaked respondent link is exactly the event a reviewer would go looking
 * for afterwards, and it was not there.
 *
 * `vendors.edit` is the same predicate the usecase evaluates —
 * `assertCanRunAssessment` reads `ctx.appPermissions.vendors.edit` — so who
 * may revoke is unchanged. The usecase assert stays for non-HTTP callers.
 */
import { revokeAssessmentLink } from '@/app-layer/usecases/vendor-assessment-send';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; assessmentId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('vendors.edit', async (_req, { params }, ctx) => {
        const result = await revokeAssessmentLink(ctx, params.assessmentId);
        return jsonResponse({
            assessmentId: result.assessmentId,
            revokedAt: result.revokedAt.toISOString(),
        });
    }),
);
