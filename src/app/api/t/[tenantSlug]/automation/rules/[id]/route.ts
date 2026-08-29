import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import {
    getAutomationRule,
    updateAutomationRule,
    archiveAutomationRule,
    toggleAutomationRule,
} from '@/app-layer/usecases/automation-rules';
import { UpdateAutomationRuleSchema } from '@/app-layer/schemas/automation.schemas';

/**
 * Lightweight PATCH for the detail-sheet quick controls (Epic 2): an
 * enable/disable toggle and the priority stepper. Heavier reconfiguration
 * (trigger/action/filter) goes through PUT.
 */
const PatchAutomationRuleSchema = z
    .object({
        status: z.enum(['ENABLED', 'DISABLED']).optional(),
        priority: z.number().int().min(0).max(1000).optional(),
    })
    .refine((v) => v.status !== undefined || v.priority !== undefined, {
        message: 'Provide status or priority',
    });

type Ctx = { params: Promise<{ tenantSlug: string; id: string }> };
type RuleParams = { tenantSlug: string; id: string };

/**
 * #2117 — all three write verbs gate on `admin.manage`, which mirrors
 * `assertCanManageAutomation`: it reads `ctx.permissions.canAdmin`, the same
 * predicate every other role-tier assert in this issue was mirrored onto. The
 * asserts stay — they protect jobs and any non-HTTP caller; the route gate is
 * what makes an HTTP refusal VISIBLE, because `AUTHZ_DENIED` is written by
 * `requirePermission` and by nothing else.
 *
 * PUT and PATCH are gated alongside DELETE deliberately. Gating only the
 * destructive verb would leave this file a MIXED MODULE — a gated DELETE
 * certifying an ungated sibling — which is the blind spot #2168 / #2171 had to
 * go back and close for seven other files. Reconfiguring a rule that fires
 * side-effects on the tenant's behalf is a privileged act; a refused attempt
 * belongs on the record just as much as an archive does.
 *
 * Both bodies are read with `parseJsonBody` INSIDE the handler rather than by
 * composing `withValidatedBody`, whose handler takes the parsed body in the
 * third argument `requirePermission` uses for `ctx`. Authorization therefore
 * runs BEFORE the body is parsed, which is the order we want.
 *
 * GET keeps usecase-layer authorization (`assertCanReadAutomation`, the canRead
 * tier) — no key means "view automation rules", and this issue is about
 * destructive and write refusals.
 */
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const rule = await getAutomationRule(ctx, params.id);
    return jsonResponse(rule);
});

export const PUT = withApiErrorHandling(
    requirePermission<RuleParams>('admin.manage', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, UpdateAutomationRuleSchema);
        const rule = await updateAutomationRule(ctx, params.id, {
            name: body.name,
            description: body.description,
            triggerEvent: body.triggerEvent,
            triggerFilter: body.triggerFilter,
            actionType: body.actionType,
            actionConfig: body.actionConfig as never,
            status: body.status,
            priority: body.priority,
            slaWindowMinutes: body.slaWindowMinutes,
            slaBreachActionType: body.slaBreachActionType,
            slaBreachConfig: body.slaBreachConfig,
            nextRuleId: body.nextRuleId,
            nextRuleDelay: body.nextRuleDelay,
            // See the POST route: both were dropped by hand-enumeration.
            elseRuleId: body.elseRuleId,
            scheduleConfig: body.scheduleConfig,
        });
        return jsonResponse(rule);
    }),
);

export const PATCH = withApiErrorHandling(
    requirePermission<RuleParams>('admin.manage', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, PatchAutomationRuleSchema);
        // Priority first (if present), then the status toggle, so a combined
        // PATCH lands both. The toggle is the authoritative return.
        let rule;
        if (body.priority !== undefined) {
            rule = await updateAutomationRule(ctx, params.id, { priority: body.priority });
        }
        if (body.status !== undefined) {
            rule = await toggleAutomationRule(ctx, params.id, body.status);
        }
        return jsonResponse(rule);
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<RuleParams>('admin.manage', async (_req, { params }, ctx) =>
        jsonResponse(await archiveAutomationRule(ctx, params.id)),
    ),
);
