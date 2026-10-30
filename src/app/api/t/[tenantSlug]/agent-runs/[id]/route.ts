import { NextRequest } from 'next/server';

import { getWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * GET — a single run with its ordered step timeline.
 *
 * `admin.view` OR `admin.agent_registry_view` (#3710) — the run detail PAGE's
 * gate (`mayReadAgentActivity`), and its `/stream` and `/checkpoint` siblings'.
 * The response carries every step's decrypted input and output, which the page
 * shows only to those readers; the usecase's `assertCanRead` alone handed them
 * to every member of the workspace. Tenant scope stays the usecase's predicate,
 * so a run in another tenant is `notFound` rather than `forbidden`.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
        async (_req: NextRequest, routeArgs, ctx) => {
            const params = await routeArgs.params;
            return jsonResponse(await getWorkflowRun(ctx, params.id));
        },
    ),
);
