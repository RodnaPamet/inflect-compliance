/**
 * #3681 (step 4d) — assemble and freeze the agent-audit reliance pack for one
 * audit cycle.
 *
 *   POST /api/t/:slug/audits/cycles/:cycleId/reliance-pack
 *        body: { "name"?: string }
 *
 * The pack carries, per control a library v1 procedure audits, the auditor
 * agent's workpapers of the cycle's period, internal audit's sampling record of
 * each and the agreement figures, plus one summary item with the scope, the
 * catalogue's standing and the rate's definition. It is shared afterwards the
 * way every pack is: a pack-scoped share link, and the auditor's grant.
 *
 * Both keys, all of them:
 *   - `audits.manage`, the key the roadmap gives reading workpapers ("Permission
 *     keys"): assembling a pack reads every workpaper of the period;
 *   - `admin.manage`, because assembling also freezes the pack, and freezing is
 *     OWNER or ADMIN by role (`assertCanFreezePack`), the population that key
 *     carries, as the auditor-access routes argue. Without it a custom role
 *     granted `audits.manage` over an EDITOR base would pass the route and be
 *     refused by the usecase with no `AUTHZ_DENIED` row.
 * A refusal is a 409 with a named reason (`NO_WORKPAPERS_IN_PERIOD`, …) and an
 * audit row; nothing is half-written.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assembleAgentAuditReliancePack } from '@/app-layer/usecases/agent-audit-reliance';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

const AssembleSchema = z
    .object({
        name: z.string().trim().min(1).max(200).optional(),
    })
    .strict();

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; cycleId: string }>({ keys: ['audits.manage', 'admin.manage'], mode: 'all' }, async (req: NextRequest, { params }, ctx) => {
        const body = AssembleSchema.parse(await req.json().catch(() => ({})));
        return jsonResponse(await assembleAgentAuditReliancePack(ctx, params.cycleId, { name: body.name }), { status: 201 });
    }),
);
