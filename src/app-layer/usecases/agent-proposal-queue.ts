/**
 * What the review queue needs to say about each listed proposal beyond the row
 * itself — read for the `/agents/proposals` page, in one query per fact.
 *
 * Kept out of `agent-proposals.ts`, the queue's single WRITE seam, for the
 * reason `agent-proposal-diff.ts` is: these are reads, and the guarded file's
 * surface stays small.
 *
 * ## The two facts, and why the page could not show them before
 *
 * SIGNATURES. A proposal that needs two approvers and holds one looked exactly
 * like one holding none after a reload: the only signal was the approve
 * response's transient notice. The count lives in `AgentProposalApproval`, so
 * it is read here, with whether THIS viewer is among the signers — the one fact
 * that tells the page its Approve button would only earn the viewer a
 * four-eyes refusal. Only terminal approving outcomes count (`ACCEPTED`,
 * `EDITED`), the same set `approveAgentProposal` counts, so the page and the
 * usecase cannot disagree about how many signatures a proposal holds.
 *
 * THE KEY. A proposal made through an API key named it by eight characters of
 * the key's internal id, which matches nothing an operator can look up. The
 * API Keys page identifies a key by its `keyPrefix` (the first characters of
 * the plaintext, kept for exactly that), and the agents register shows the same
 * prefix to the same readers, so that is what is read here.
 */
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { assertCanRead } from '@/app-layer/policies/common';
import type { RequestContext } from '@/app-layer/types';

/**
 * How many proposals the queue page lists. It reads ONE MORE than this, so
 * "there are more" is a fact the page holds rather than one it cannot observe:
 * a page of exactly this many rows is not truncated, and only a read that came
 * back longer is.
 */
export const PROPOSAL_QUEUE_PAGE_SIZE = 100;

export interface ProposalQueueAnnotation {
    /** Distinct people whose approval is recorded and counts toward the requirement. */
    approvalsRecorded: number;
    /** Whether the viewer is one of them — a second approval must be somebody else's. */
    signedByViewer: boolean;
    /**
     * The `keyPrefix` of the key the proposal was made through, or null when it
     * was not made through one or the key cannot be read.
     */
    proposedViaKeyPrefix: string | null;
}

/** The approving outcomes `approveAgentProposal` counts toward the requirement. */
const COUNTED_OUTCOMES = ['ACCEPTED', 'EDITED'] as const;

/**
 * The bound on one proposal's signatures. A pending proposal holds fewer than
 * its requirement, which is at most two today; the same ceiling
 * `approveAgentProposal` reads with, so neither under-counts the other.
 */
const SIGNATURES_PER_PROPOSAL = 32;

/**
 * Annotate a page of the queue. Every input proposal gets an entry, including
 * one with no signatures and no key — an absent entry and a zero must not read
 * alike to the caller.
 */
export async function annotateProposalQueue(
    ctx: RequestContext,
    proposals: ReadonlyArray<{ id: string; proposedViaKeyId: string | null }>,
): Promise<Map<string, ProposalQueueAnnotation>> {
    assertCanRead(ctx);
    const out = new Map<string, ProposalQueueAnnotation>();
    if (proposals.length === 0) return out;

    const proposalIds = proposals.map((p) => p.id);
    const keyIds = Array.from(
        new Set(proposals.map((p) => p.proposedViaKeyId).filter((id): id is string => id !== null)),
    );

    const [signatures, keys] = await runInTenantContext(ctx, (db) =>
        Promise.all([
            db.agentProposalApproval.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    proposalId: { in: proposalIds },
                    outcome: { in: [...COUNTED_OUTCOMES] },
                },
                select: { proposalId: true, approverUserId: true },
                take: proposalIds.length * SIGNATURES_PER_PROPOSAL,
            }),
            keyIds.length
                ? db.tenantApiKey.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: keyIds } },
                      select: { id: true, keyPrefix: true },
                      take: keyIds.length,
                  })
                : Promise.resolve([] as Array<{ id: string; keyPrefix: string }>),
        ]),
    );

    // DISTINCT signers per proposal — the unique index already makes them so,
    // and counting a Set says so here rather than relying on it.
    const signersOf = new Map<string, Set<string>>();
    for (const s of signatures) {
        const set = signersOf.get(s.proposalId) ?? new Set<string>();
        set.add(s.approverUserId);
        signersOf.set(s.proposalId, set);
    }
    const prefixOf = new Map(keys.map((k) => [k.id, k.keyPrefix]));

    for (const p of proposals) {
        const signers = signersOf.get(p.id) ?? new Set<string>();
        out.set(p.id, {
            approvalsRecorded: signers.size,
            signedByViewer: signers.has(ctx.userId),
            proposedViaKeyPrefix: p.proposedViaKeyId ? (prefixOf.get(p.proposedViaKeyId) ?? null) : null,
        });
    }
    return out;
}
