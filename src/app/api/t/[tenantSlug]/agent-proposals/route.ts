import { NextRequest } from 'next/server';

import { listAgentProposals } from '@/app-layer/usecases/agent-proposals';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { requirePermission } from '@/lib/security/permission-middleware';

type StoredProposal = Awaited<ReturnType<typeof listAgentProposals>>[number];

/**
 * The wire shape: every stored column EXCEPT `payloadJson`.
 *
 * The proposals page does not send `payloadJson` to a browser — "exactly the
 * opaque blob this page exists to stop a reviewer approving" (`ProposalRow.diff`
 * in `AgentProposalsClient.tsx`) — and neither does the run checkpoint read
 * (`run-checkpoint-review.ts`). This route returned the whole row, so the raw
 * payload the page withholds from every reader was one request away. Nobody
 * sees it on the page, so nobody is sent it here.
 *
 * NAMED, never spread, for the reason the checkpoint read gives: a column added
 * to `AgentProposal` later is not published by this route until somebody names
 * it here.
 */
function toWire(p: StoredProposal) {
    return {
        id: p.id,
        tenantId: p.tenantId,
        kind: p.kind,
        operation: p.operation,
        status: p.status,
        targetEntityId: p.targetEntityId,
        rationale: p.rationale,
        proposedViaKeyId: p.proposedViaKeyId,
        proposedBySessionRef: p.proposedBySessionRef,
        reviewedByUserId: p.reviewedByUserId,
        reviewedAt: p.reviewedAt,
        createdEntityId: p.createdEntityId,
        agentId: p.agentId,
        policyCardVersion: p.policyCardVersion,
        runId: p.runId,
        stepSeq: p.stepSeq,
        guardVerdict: p.guardVerdict,
        guardRuleIds: p.guardRuleIds,
        guardInputDigest: p.guardInputDigest,
        guardProvenance: p.guardProvenance,
        requiredApprovals: p.requiredApprovals,
        expiresAt: p.expiresAt,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
    };
}

/**
 * GET /api/t/:tenantSlug/agent-proposals — the human review queue backing the
 * agent-proposals page. Lists proposals (optionally filtered by `?status=`),
 * tenant-scoped by RLS.
 *
 * `admin.view` OR `admin.agent_registry_view` (#3710) — the proposals PAGE's
 * gate (`mayReadAgentActivity`) and the run checkpoint read's. It was the
 * usecase's `assertCanRead` alone, so every member of the workspace could read
 * every proposal here while the page refused them. Spelled as the middleware so
 * a denial writes `AUTHZ_DENIED`.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
        async (req: NextRequest, _routeArgs, ctx) => {
            const status = req.nextUrl.searchParams.get('status') ?? undefined;
            const proposals = await listAgentProposals(ctx, { status: status ?? undefined });
            return jsonResponse(proposals.map(toWire));
        },
    ),
);
