/**
 * `/api/t/:slug/admin/agents/review-quality` — do the approvals on the
 * agent-proposal queue mean anything?
 *
 * GET only. Read-only over columns `AgentProposal` already carries; it stores
 * nothing and creates nothing. The one side effect is an audit row when a
 * pattern is outstanding, and that row is deduplicated — see
 * `usecases/agent-review-quality`.
 *
 * ## Permission
 *
 * `admin.agent_registry`, and it needs no new rule: the existing
 * `^…/admin/agents(/.*)?$` entry in `route-permissions.ts` already matches the
 * whole subtree, the same way `…/agents/:agentId/coverage` is covered. The key
 * is right on its own terms too — deciding which agents may act and judging
 * whether the human gate on what they propose is real are the same authority,
 * and the surface names people, so it does not belong behind the narrower
 * tool-exposure key that an operations team routinely holds.
 *
 * `requirePermission` at the ROUTE rather than `assertCanRead` alone in the
 * usecase, because a refusal here must write the hash-chained `AUTHZ_DENIED`
 * row. The usecase keeps its own `assertCanRead` — the gate is the route's, the
 * floor is the usecase's, and neither substitutes for the other.
 *
 * ## `?days=`
 *
 * The lookback, 1..365, default 90. Validated in the usecase so an HTTP caller
 * and a future scheduled caller are refused by the same code — a bound enforced
 * only at the boundary is a bound the second caller does not have.
 */
import { NextRequest } from 'next/server';

import { computeAgentReviewQuality } from '@/app-layer/usecases/agent-review-quality';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    requirePermission(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const raw = req.nextUrl.searchParams.get('days');
            // `undefined` when absent so the usecase's own default applies;
            // `NaN` when present and unparseable so the usecase refuses it,
            // rather than a silent fallback that answers a different question
            // from the one the caller asked.
            const windowDays = raw === null ? undefined : Number(raw);
            return jsonResponse(await computeAgentReviewQuality(ctx, { windowDays }));
        },
    ),
);
