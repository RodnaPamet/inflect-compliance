import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import {
    listAutomationTemplates,
    createRuleFromTemplate,
} from '@/app-layer/usecases/automation-templates';

type Ctx = { params: Promise<{ tenantSlug: string }> };

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    return jsonResponse(listAutomationTemplates(ctx));
});

const UseTemplateSchema = z.object({ templateId: z.string().min(1) });

/**
 * Using a template creates a rule, so it takes `admin.manage` like
 * `POST /automation/rules` and every write on `rules/[id]` (#5303).
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('admin.manage', async (req, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, UseTemplateSchema);
        const rule = await createRuleFromTemplate(ctx, body.templateId);
        return jsonResponse(rule, { status: 201 });
    }),
);
