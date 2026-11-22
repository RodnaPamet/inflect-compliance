import { NextRequest } from 'next/server';

import { readRunDecisionRows } from '@/app-layer/usecases/ai-decision-log';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * GET — the EU AI Act Art 12 rows ONE run wrote (D-EV-8, owner decision
 * 2026-11-15), as JSON: each row's id, input digest, agent, time and Art 14
 * outcome code. `truncated` says when the run has more than the bound.
 *
 * TWO GATES, both held. This route takes the run detail page's gate, the one
 * every sibling under `/agent-runs` takes: `admin.view` OR
 * `admin.agent_registry_view` (`mayReadAgentActivity`, #3710), spelled as the
 * middleware so a denial writes `AUTHZ_DENIED`. The usecase then asks the
 * decision log's own rule (`assertMayReadOversightSurface(ctx, 'decisions')`):
 * the register key, or the inventory view key while the owner lets Auditors
 * read the log. So a caller reads a run's rows here only if they could read the
 * same rows on `/agents/decisions`; a refusal there writes `AUTHZ_DENIED` too.
 *
 * No text: the output summary the decisions page shows is not selected, and
 * the row carries no prompt. Tenant scope is the usecase's predicate, so a run
 * in another tenant is not-found rather than forbidden. A GET under `/api/t/`,
 * so the edge's read tier (`API_READ_LIMIT`) applies.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
        async (_req: NextRequest, routeArgs, ctx) => {
            const params = await routeArgs.params;
            return jsonResponse(await readRunDecisionRows(ctx, params.id));
        },
    ),
);
