/**
 * `GET /api/t/:tenantSlug/admin/mcp/quarantine` — the QUARANTINE TRIAGE read.
 *
 * `createAgentProposal` writes a quarantined row rather than throwing, and the
 * reason is written down at that seam: "the row is the only durable evidence
 * that the attempt happened, and an operator triaging an injection needs to see
 * what was tried, not an error somebody's agent swallowed." Until this route
 * existed that evidence had no way out of the database. The QUARANTINE EVENT was
 * discoverable — every quarantine appends a hash-chained
 * `AGENT_PROPOSAL_QUARANTINED` audit row — but the audit payload deliberately
 * carries rule ids and a digest and NOT the content, so the thing an
 * investigator actually needs was reachable only with a psql session.
 *
 * ## Permission
 *
 * `admin.agent_registry`. Same key the sibling `review-quality` surface chose,
 * for the same reason: the operator's response to a quarantine finding is to
 * suspend or retire the agent that produced it, which is precisely the authority
 * that key names. It is held by OWNER and ADMIN and by nobody below them.
 *
 * `requirePermission` AT THE ROUTE and not `assertCanRead` alone in the usecase,
 * because a refusal here must write the hash-chained `AUTHZ_DENIED` row — an
 * `assertCan*` denial writes nothing. The usecase keeps its own `assertCanRead`:
 * the gate is the route's, the floor is the usecase's, and neither substitutes
 * for the other. The 403 body says only "Permission denied" — the key is never
 * echoed back to a caller who does not hold it.
 *
 * ## Why `guardVerdict` is NOT on the wire
 *
 * It would be a constant. `guardAgentProposal` returns
 * `quarantined: verdict === 'QUARANTINED'`, and `createAgentProposal` writes
 * `status: guard.quarantined ? 'QUARANTINED' : 'PENDING'` — so on the rows this
 * endpoint selects (`status = 'QUARANTINED'`) `guardVerdict` is `'QUARANTINED'`
 * for every one of them, by construction. A field with one possible value tells
 * a consumer nothing it did not already know from the endpoint it called. The
 * varying signal is `guardRuleIds`, which says WHICH rules fired, and that is
 * projected.
 *
 * (The FLAGGED verdict — a rule fired but nothing was malicious — is a real and
 * different population, and those rows are `status: 'PENDING'`. They are not
 * here; see the implementation note for where they are and what is still
 * missing about them.)
 *
 * ## Why the response is projected, and why it carries `truncated`
 *
 * The projection is explicit rather than `jsonResponse(rows)` so a column added
 * to `AgentProposal` later cannot ship onto this wire by accident.
 *
 * `truncated` exists because the usecase's `take` is a silent cap. A triage list
 * that quietly stops at its limit is the same defect the proposal queue's own
 * expiry bound exists to avoid — an invisible backlog — and it is worse here,
 * because the rows past the cap are the OLDEST attempts (the listing is
 * newest-first). So this route asks for one more row than it will return and
 * reports whether that row existed. Nothing is inferred from
 * `rows.length === limit`, which cannot tell a full page from a truncated one.
 */
import { NextRequest } from 'next/server';

import { listQuarantinedAgentProposals } from '@/app-layer/usecases/agent-proposals';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/** How many quarantined rows one triage page returns. */
export const QUARANTINE_TRIAGE_PAGE_SIZE = 100;

/**
 * One quarantined proposal as the triage surface sees it.
 *
 * `payloadJson` and `rationale` are the attacker-supplied content — decrypted by
 * the Epic B read extension and already sanitised at the write seam. They are
 * the point of the surface: everything else on this row describes the attempt,
 * only these two say what was attempted.
 */
export interface QuarantinedProposalDTO {
    id: string;
    kind: string;
    operation: string;
    /** The registered agent, or `null` for a credential that names none. */
    agentId: string | null;
    targetEntityId: string | null;
    /** Stable rule ids that fired. Ids only — never the matched text. */
    guardRuleIds: string[];
    guardInputDigest: string | null;
    guardProvenance: string;
    payloadJson: string;
    rationale: string | null;
    proposedViaKeyId: string | null;
    createdAt: string;
}

export interface QuarantineTriagePage {
    rows: QuarantinedProposalDTO[];
    /**
     * True when at least one quarantined row exists BEYOND this page. Measured
     * by over-fetching one row, not guessed from the page being full.
     */
    truncated: boolean;
}

export const GET = withApiErrorHandling(
    requirePermission('admin.agent_registry', async (_req: NextRequest, _routeArgs, ctx) => {
        const found = await listQuarantinedAgentProposals(ctx, {
            take: QUARANTINE_TRIAGE_PAGE_SIZE + 1,
        });
        const truncated = found.length > QUARANTINE_TRIAGE_PAGE_SIZE;
        const rows: QuarantinedProposalDTO[] = found
            .slice(0, QUARANTINE_TRIAGE_PAGE_SIZE)
            .map((p) => ({
                id: p.id,
                kind: p.kind,
                operation: p.operation,
                agentId: p.agentId,
                targetEntityId: p.targetEntityId,
                guardRuleIds: p.guardRuleIds,
                guardInputDigest: p.guardInputDigest,
                guardProvenance: p.guardProvenance,
                payloadJson: p.payloadJson,
                rationale: p.rationale,
                proposedViaKeyId: p.proposedViaKeyId,
                createdAt: p.createdAt.toISOString(),
            }));
        return jsonResponse<QuarantineTriagePage>({ rows, truncated });
    }),
);
