import { unmapControlFromRisk } from '@/app-layer/usecases/traceability';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string; riskId: string };

/**
 * Cross-entity mapping, gated on `controls.edit`.
 *
 * The CONTROL side governs a mapping where a control is one end — the rule
 * settled for #2117. It is a decision rather than a derivation: the assert
 * behind this route reads a coarse role tier and so cannot say which side
 * owns the link, which is exactly why these routes sat unmigrated across
 * three tranches.
 *
 * `controls.edit` matches that coarse tier exactly for every built-in role,
 * so no built-in role loses access; what changes is that a custom role
 * denying `controls.edit` is now honoured. The usecase assert stays — the
 * gate exists to make the refusal auditable (#2117), not to replace it.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (_req, { params }, ctx) => {
        await unmapControlFromRisk(ctx, params.controlId, params.riskId);
        return jsonResponse({ ok: true });
    }),
);
