import { NextRequest } from 'next/server';

import { abortWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * POST — abort a run (operator kill-switch). Nothing is left half-applied.
 *
 * The gate the runs PAGE offers its Abort button on: `admin.view` OR
 * `admin.agent_registry_view` (`mayReadAgentActivity`, #3710) here, as the
 * middleware so a refusal writes `AUTHZ_DENIED`, and the role-tier write that
 * `abortWorkflowRun` asserts itself. See the resume sibling for why it is both.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
        async (_req: NextRequest, routeArgs, ctx) => {
            const params = await routeArgs.params;
            await abortWorkflowRun(ctx, params.id);
            return jsonResponse({ ok: true });
        },
    ),
);
