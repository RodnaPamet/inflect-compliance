import { NextRequest } from 'next/server';

import { approveAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * POST /api/t/:tenantSlug/agent-proposals/:id/approve — the human-in-the-loop
 * gate. Approving runs the REAL create-usecase (audited as the reviewer, with
 * the proposing agent's key in metadata). Optional `{ edits: {...} }` body
 * merges edits before creation.
 *
 * THE GATE IS THE PAGE'S, IN TWO LAYERS. The proposals page renders for
 * `admin.view` OR `admin.agent_registry_view` (`mayReadAgentActivity`, #3710)
 * and enables Approve on the role-tier write. The first is enforced here, as
 * the middleware, so a refusal writes `AUTHZ_DENIED`; the second is the
 * usecase's own `assertCanWrite`. Before this the route had only the second, so
 * an EDITOR — refused the page — could approve here. The canvas's inline review
 * (`CheckpointReviewPanel`) posts here too, and offers Approve on `admin.view`
 * and `canWrite`, inside this gate.
 *
 * TWO SUCCESS SHAPES, and a caller must tell them apart. A proposal that needs
 * a second approver returns `{ status: 'AWAITING_APPROVAL', createdEntityId:
 * null, approvalsRecorded, approvalsRequired }` — this reviewer's signature is
 * recorded and NOTHING is created. Only `status: 'ACCEPTED' | 'EDITED'` carries
 * a real `createdEntityId`. Reading the two as one is the automation-bias
 * failure in miniature: a reviewer told "approved" for a proposal that has not
 * been approved learns that clicking the button is what approval means.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
        async (req: NextRequest, routeArgs, ctx) => {
            const params = await routeArgs.params;
            let edits: Record<string, unknown> | undefined;
            let baseDigest: string | undefined;
            try {
                const body = (await req.json()) as
                    | { edits?: Record<string, unknown>; baseDigest?: string }
                    | null;
                edits = body?.edits;
                // The fingerprint of the diff the reviewer read. Forwarded, never
                // defaulted: for an UPDATE proposal the usecase REFUSES an approval that
                // carries none, and a route that invented one here would forge the
                // reviewer's claim to have looked. See `ApproveOptions.baseDigest`.
                baseDigest = typeof body?.baseDigest === 'string' ? body.baseDigest : undefined;
            } catch {
                // No/invalid body → approve as-proposed. An UPDATE proposal then fails
                // the baseDigest check, which is the correct outcome for a request that
                // could not even be parsed.
            }
            const result = await approveAgentProposal(ctx, params.id, { edits, baseDigest });
            return jsonResponse(result);
        },
    ),
);
