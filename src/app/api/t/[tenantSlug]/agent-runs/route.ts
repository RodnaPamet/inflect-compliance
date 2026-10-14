import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { startWorkflowRun, listWorkflowRuns } from '@/app-layer/usecases/workflow-runs';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET — list workflow runs. Read-gated by the usecase.
 *
 * `?status=` narrows by run status and `?agentId=` to one registered agent's
 * runs (#3472) — the question the agent detail page's Runs tab asks, so the
 * register reaches the work it admitted. Both are raw query-string values and
 * the usecase validates each: `status` against the real enum, and `agentId` as
 * an equality the tenant predicate already bounds.
 */
export const GET = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const sp = req.nextUrl.searchParams;
    const status = sp.get('status') ?? undefined;
    // An empty `?agentId=` is NOT a filter for "runs with no agent". It is a
    // caller that built the query string from an absent value, and treating it
    // as a filter would silently return nothing on a page that looks loaded.
    const agentId = sp.get('agentId')?.trim() || undefined;
    return jsonResponse(await listWorkflowRuns(ctx, { status, agentId }));
});

/** POST — start a workflow run. Body: { workflowKey, input? }. Write/orchestrate-gated. */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const body = (await req.json().catch(() => ({}))) as { workflowKey?: string; input?: Record<string, unknown> };
    if (!body.workflowKey) return jsonResponse({ error: 'workflowKey is required' }, { status: 400 });
    const result = await startWorkflowRun(ctx, body.workflowKey, body.input ?? {});
    return jsonResponse(result, { status: 201 });
});
