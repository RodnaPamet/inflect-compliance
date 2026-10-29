import { NextRequest } from 'next/server';

import {
    getSampleAuditDisagreementRate,
    listAgentProposalSampleAudits,
} from '@/app-layer/usecases/agent-proposal-sample-audit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * GET /api/t/:tenantSlug/agent-proposals/sample-audits — the retrospective
 * review queue plus THE NUMBER (OWASP ASI09).
 *
 * `admin.agent_registry`, the gate of the page that reports on review quality
 * (`/agents/review-quality`), spelled as the middleware so a refusal writes
 * `AUTHZ_DENIED`, then the usecase's `assertCanRead`; tenant-scoped by RLS.
 * Before this the route had the usecase's `assertCanRead` alone, so every
 * member could read which approvals were drawn for re-review, who answered each
 * and how, and the rate, while that page refused them.
 *
 * There is deliberately no POST here: a sample audit is opened by the sampler
 * job and by nothing else, because a human who could pick which approvals get
 * re-examined would be choosing the sample, and the resulting rate would
 * describe that choice rather than the queue.
 *
 * The rate is returned ALONGSIDE the queue rather than as a separate endpoint,
 * because a reviewer looking at the backlog is exactly who needs to see how much
 * of the drawn sample is still unanswered — a disagreement rate over two answers
 * and one over two hundred are the same number and different evidence.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('admin.agent_registry', async (req: NextRequest, _routeArgs, ctx) => {
        const includeAnswered = req.nextUrl.searchParams.get('all') === '1';
        const sinceDaysParam = Number(req.nextUrl.searchParams.get('sinceDays'));
        const sinceDays = Number.isFinite(sinceDaysParam) && sinceDaysParam > 0
            ? Math.min(sinceDaysParam, 365)
            : undefined;

        const [audits, rate] = await Promise.all([
            listAgentProposalSampleAudits(ctx, { open: !includeAnswered }),
            getSampleAuditDisagreementRate(ctx, { sinceDays }),
        ]);
        return jsonResponse({ audits, rate });
    }),
);
