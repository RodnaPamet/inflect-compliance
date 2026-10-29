import { NextRequest } from 'next/server';

import { resumeWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * POST — resume a paused run after the human has acted on its checkpoint.
 *
 * The gate the runs PAGE offers its Resume button on, in two layers: the page
 * renders for `admin.view` OR `admin.agent_registry_view` (`mayReadAgentActivity`,
 * #3710) — enforced here as the middleware, so a refusal writes `AUTHZ_DENIED` —
 * and enables the button on the role-tier write, which `resumeWorkflowRun`
 * asserts itself. Neither layer alone is the page's gate: the view key confers
 * no write, and an EDITOR holds the write but is refused the page.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
        async (_req: NextRequest, routeArgs, ctx) => {
            const params = await routeArgs.params;
            return jsonResponse(await resumeWorkflowRun(ctx, params.id));
        },
    ),
);
