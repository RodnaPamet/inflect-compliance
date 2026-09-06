import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import {
    getSampleAuditDisagreementRate,
    listAgentProposalSampleAudits,
} from '@/app-layer/usecases/agent-proposal-sample-audit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET /api/t/:tenantSlug/agent-proposals/sample-audits — the retrospective
 * review queue plus THE NUMBER (OWASP ASI09).
 *
 * Read-gated by the usecase (`assertCanRead`), tenant-scoped by RLS. There is
 * deliberately no POST here: a sample audit is opened by the sampler job and by
 * nothing else, because a human who could pick which approvals get re-examined
 * would be choosing the sample, and the resulting rate would describe that
 * choice rather than the queue.
 *
 * The rate is returned ALONGSIDE the queue rather than as a separate endpoint,
 * because a reviewer looking at the backlog is exactly who needs to see how much
 * of the drawn sample is still unanswered — a disagreement rate over two answers
 * and one over two hundred are the same number and different evidence.
 */
export const GET = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
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
});
