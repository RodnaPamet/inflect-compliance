/**
 * DELETE /api/t/[tenantSlug]/evidence/[id]/controls/[controlId]
 * EP-3 — unlink an evidence record from a control (deletes the
 * EvidenceControlLink). The Evidence row survives — this is a detach.
 */
import { unlinkEvidenceFromControl } from '@/app-layer/usecases/evidence';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string; controlId: string };

/**
 * Gated on `controls.edit`, not `evidence.edit`.
 *
 * The CONTROL side governs a mapping where a control is one end — the rule
 * settled for #2117. It is a decision rather than a derivation: the usecase
 * asserts a coarse `assertCanWrite`, which cannot say which side owns the
 * link, and that ambiguity is why this route sat unmigrated across three
 * tranches.
 *
 * `controls.edit` matches that coarse tier exactly for every built-in role, so
 * no built-in role loses access; what changes is that a custom role denying
 * `controls.edit` is now honoured. The usecase assert stays — the gate exists
 * to make the refusal auditable, not to replace the check.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (_req, { params }, ctx) => {
        const result = await unlinkEvidenceFromControl(ctx, params.id, params.controlId);
        return jsonResponse(result);
    }),
);
