import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { startWorkflowRun, listWorkflowRuns } from '@/app-layer/usecases/workflow-runs';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertPermission, requirePermission } from '@/lib/security/permission-middleware';

/**
 * GET — list workflow runs.
 *
 * `admin.view` OR `admin.agent_registry_view` (#3710) — the gate the runs PAGE
 * applies before it loads anything (`mayReadAgentActivity`), and the one its
 * `/stream` and `/checkpoint` siblings already take. Before this, the route had
 * only the usecase's `assertCanRead`, so every member of the workspace could
 * list every run through the API while the page refused them. Spelled as the
 * middleware so a denial writes the hash-chained `AUTHZ_DENIED` row a
 * usecase-level assert would not.
 *
 * `?status=` narrows by run status and `?agentId=` to one registered agent's
 * runs (#3472) — the question the agent detail page's Runs tab asks, so the
 * register reaches the work it admitted. Both are raw query-string values and
 * the usecase validates each: `status` against the real enum, and `agentId` as
 * an equality the tenant predicate already bounds.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
        async (req: NextRequest, _routeArgs, ctx) => {
            const sp = req.nextUrl.searchParams;
            const status = sp.get('status') ?? undefined;
            // An empty `?agentId=` is NOT a filter for "runs with no agent". It is a
            // caller that built the query string from an absent value, and treating it
            // as a filter would silently return nothing on a page that looks loaded.
            const agentId = sp.get('agentId')?.trim() || undefined;
            return jsonResponse(await listWorkflowRuns(ctx, { status, agentId }));
        },
    ),
);

/**
 * POST — start a workflow run. Body: { workflowKey, input? }.
 *
 * TWO KINDS OF CALLER, and each is held to the gate that is its own.
 *
 * A PERSON (a session) takes the runs page's gate — `admin.view` OR the
 * inventory view key — and then the role-tier write `startWorkflowRun` asserts.
 * That is exactly what the page offers its Start button on: the page renders for
 * `mayReadAgentActivity` and enables the button on `canWrite`. Before this, an
 * EDITOR, refused the page, could start a run here.
 *
 * A BEARER API KEY is a machine credential, and its gate is the `mcp:orchestrate`
 * capability scope `startWorkflowRun` enforces for every key context (and, for a
 * Flue run, the registered-agent requirement beside it). This is the documented
 * way an agent starts a run — `docs/runbooks/enabling-the-flue-engine.md` — and
 * the key a runner carries holds `mcp:orchestrate` and domain reads, not the
 * admin console. Holding it to the page's keys would refuse every such key, so
 * the person's gate is applied to every context that is NOT a key, and a key
 * keeps the scope check it already had.
 *
 * The branch reads `ctx.apiKeyId`, which only `getTenantCtx`'s key path sets, so
 * it fails closed: anything that did not authenticate as a key is held to the
 * person's gate. The decision is `assertPermission`, the function
 * `requirePermission` delegates to, so a refused person leaves the same
 * `AUTHZ_DENIED` row the GET's wrapper writes.
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    if (!ctx.apiKeyId) {
        await assertPermission(
            ctx,
            { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
            { method: req.method, path: req.nextUrl.pathname },
        );
    }
    const body = (await req.json().catch(() => ({}))) as { workflowKey?: string; input?: Record<string, unknown> };
    if (!body.workflowKey) return jsonResponse({ error: 'workflowKey is required' }, { status: 400 });
    const result = await startWorkflowRun(ctx, body.workflowKey, body.input ?? {});
    return jsonResponse(result, { status: 201 });
});
