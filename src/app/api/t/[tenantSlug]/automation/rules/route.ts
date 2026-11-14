import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import {
    listAutomationRules,
    createAutomationRule,
} from '@/app-layer/usecases/automation-rules';
import { CreateAutomationRuleSchema } from '@/app-layer/schemas/automation.schemas';
import { AutomationActionType, AutomationRuleStatus } from '@prisma/client';

const RulesQuerySchema = z
    .object({
        status: z.nativeEnum(AutomationRuleStatus).optional(),
        triggerEvent: z.string().optional(),
        actionType: z.nativeEnum(AutomationActionType).optional(),
        includeDeleted: z.enum(['true', 'false']).optional(),
    })
    .strip();

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
        const q = RulesQuerySchema.parse(sp);
        const rules = await listAutomationRules(ctx, {
            status: q.status,
            triggerEvent: q.triggerEvent,
            actionType: q.actionType,
            includeDeleted: q.includeDeleted === 'true',
        });
        return jsonResponse(rules);
    },
);

/**
 * Creating a rule takes `admin.manage`, as editing, disabling and archiving
 * one does (`rules/[id]`, #2117), and `assertCanManageAutomation` still reads
 * the coarse admin tier behind it (#5303). Ungated here, a custom role on an
 * ADMIN base with `admin.manage` switched off could create an enabled rule it
 * was then refused turning off, and a refused create wrote no AUTHZ_DENIED
 * row. The body is parsed inside the handler, after authorization, because
 * `withValidatedBody` and `requirePermission` both claim the third argument.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req, _routeArgs, ctx) => {
            const body = await parseJsonBody(req, CreateAutomationRuleSchema);
            const rule = await createAutomationRule(ctx, {
                name: body.name,
                description: body.description ?? null,
                triggerEvent: body.triggerEvent,
                triggerFilter: body.triggerFilter ?? null,
                actionType: body.actionType,
                // Validated against actionType by the schema's superRefine.
                actionConfig: body.actionConfig as never,
                webhookSecret: body.webhookSecret,
                status: body.status,
                priority: body.priority,
                slaWindowMinutes: body.slaWindowMinutes,
                slaBreachActionType: body.slaBreachActionType,
                slaBreachConfig: body.slaBreachConfig,
                nextRuleId: body.nextRuleId,
                nextRuleDelay: body.nextRuleDelay,
                // Both were DROPPED here. The schema accepts them, the repo
                // persists them and the builder constructs them — the route
                // enumerated fields by hand and stopped short. Consequences:
                // the entire "Else / when conditions fail" branch was
                // write-only theatre, and scheduleConfigJson stayed null so
                // SCHEDULE rules COULD NEVER FIRE.
                elseRuleId: body.elseRuleId,
                scheduleConfig: body.scheduleConfig,
            });
            return jsonResponse(rule, { status: 201 });
        },
    ),
);
