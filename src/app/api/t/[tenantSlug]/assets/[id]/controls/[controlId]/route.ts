import { unmapAssetFromControl } from '@/app-layer/usecases/traceability';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string; controlId: string };

/**
 * Cross-entity mapping, gated on `assets.edit`.
 *
 * CHANGED, and the reason is recorded because the previous one was. This route
 * read `controls.edit` on the rule #2117 settled — "the CONTROL side governs a
 * mapping where a control is one end" — and its own docblock noted that the
 * usecase assert could not say which side owned the link, which is why these
 * routes sat unmigrated across three tranches.
 *
 * The owner ruled on 2026-10-27 (#4413) that a mapping is governed by the key
 * of the entity you edit FROM. This route hangs off the ASSET, so it asks
 * `assets.edit` — the same key its sibling `DELETE /risks/:riskId` already
 * asked, and the same key `POST /controls` now asks. The pair no longer
 * disagrees with itself.
 *
 * The usecase assert stays, and it is no longer a role-name check: it reads
 * this same key through `assertCanEditAsset`. The gate is what makes the
 * refusal auditable (#2117); the assert is what makes it binding.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<Params>('assets.edit', async (_req, { params }, ctx) => {
        await unmapAssetFromControl(ctx, params.id, params.controlId);
        return jsonResponse({ ok: true });
    }),
);
