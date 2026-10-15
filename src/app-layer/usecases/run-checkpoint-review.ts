/**
 * ONE RUN'S OPEN HUMAN CHECKPOINT, as a reviewer on the canvas reads it
 * (#3472, plan point 08 — "HUMAN_CHECKPOINT renders a paused badge with
 * inline approve/reject").
 *
 * ## This is a READ path, and it is a separate module for that reason
 *
 * `agent-proposals.ts` is the single WRITE seam for the queue and is guarded
 * as such (`tests/guards/agent-proposal-single-write-seam.test.ts`);
 * `agent-proposal-diff.ts` already split the diff read out of it on exactly
 * this argument. This module is the second such read, and folding it into
 * either file would grow a guarded surface to serve a canvas.
 *
 * It also deliberately adds NO write. The plan's constraint is
 * "approve/reject from the canvas goes through the SAME usecase as
 * /agents/proposals — no second approval path", so the canvas posts to the
 * existing `/agent-proposals/:id/approve|reject` routes and the only new code
 * is this read. A reviewer's decision is therefore recorded by the same
 * usecase, with the same four-eyes arithmetic, the same quarantine and expiry
 * refusals, and the same `baseDigest` re-check, whichever surface they used.
 *
 * ## AWAITING_APPROVAL does not mean "there are proposals to approve"
 *
 * `listWorkflowRuns` already carries the note and the filtered count that
 * exist because of it: a HUMAN_CHECKPOINT pauses a run whether or not it
 * queued anything, and a content-guard flag pauses one that queued nothing at
 * all. So this projection returns the run's status AND the proposals as
 * SEPARATE facts, and `proposals: []` on an AWAITING_APPROVAL run is a real
 * answer the panel must render as such — never as an empty queue, and never as
 * a spinner that resolves to nothing.
 *
 * ## What it does not send
 *
 * `payloadJson` is NOT in the projection. It is the column the proposals
 * surface refuses to send to a browser — "exactly the opaque blob this page
 * exists to stop a reviewer approving" — and the whole point of sending a
 * server-computed diff instead. The fields are NAMED, never spread, so adding
 * a column to `AgentProposal` cannot publish it here by accident.
 */
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { assertCanRead } from '@/app-layer/policies/common';
import { notFound } from '@/lib/errors/types';
import { buildProposalDiffs } from '@/app-layer/usecases/agent-proposal-diff';
import type { ProposalDiff } from '@/lib/agentic/proposal-diff';
import type { RequestContext } from '@/app-layer/types';

/**
 * The ceiling on proposals returned for one checkpoint.
 *
 * A bound rather than a page, because a checkpoint is not a feed: one
 * `buildItems` can queue several proposals, but a checkpoint carrying more
 * than this is not something a human reviews inline on a canvas node — it is
 * the proposals queue's job, and the panel says so and links there. The plan's
 * "never stream unbounded history" applies to the step ledger; the same
 * instinct applies to anything a Run-Mode poll can reach.
 */
export const MAX_CHECKPOINT_PROPOSALS = 25;

/** One pending proposal, with the diff its reviewer must read first. */
export interface CheckpointProposal {
    id: string;
    kind: string;
    /** CREATE or UPDATE — decides which rendering the diff panel produces. */
    operation: string;
    status: string;
    /** The record an UPDATE would change; null for a CREATE. */
    targetEntityId: string | null;
    rationale: string | null;
    /** Which step of this run queued it. Null for a proposal made outside one. */
    stepSeq: number | null;
    /**
     * The agentic output guard's verdict. NOT nullable — the column defaults
     * to CLEAN, which is also what a row written before the guard existed
     * carries, so it is read beside `guardInputDigest` and never alone.
     */
    guardVerdict: string;
    /** The stable rule ids that fired. Ids only; never the matched text. */
    guardRuleIds: readonly string[];
    /**
     * `sha256:<hex>` over the guarded content, or null. Rendered nowhere: it
     * is the evidence that a scan RAN, which is the one fact that tells
     * "found nothing" apart from "never looked".
     */
    guardInputDigest: string | null;
    /** The reviewer's own deadline. Past it, `approveAgentProposal` refuses. */
    expiresAt: string | null;
    createdAt: string;
    /**
     * Computed SERVER-SIDE against the target's state right now — never in the
     * browser from a payload, and never from a snapshot taken when the
     * proposal was queued. The reviewer is being asked what this will do if
     * they approve it NOW, and only a fresh read answers that.
     */
    diff: ProposalDiff;
}

/** What the canvas checkpoint panel reads. */
export interface RunCheckpointReview {
    runId: string;
    workflowKey: string;
    status: string;
    /**
     * Is a PERSON the thing this run is waiting for?
     *
     * `AWAITING_APPROVAL` only. PAUSED is deliberately excluded — a deploy
     * paused it and it resumes on its own, so offering a review there would
     * send an operator looking for a decision nobody is waiting on. Same
     * split, and the same reason, as `awaitsAHuman` on the canvas side.
     */
    awaitingHuman: boolean;
    /**
     * When the RUN's approval window closes, or null.
     *
     * The run's, not a proposal's — `resumeWorkflowRun` refuses past it, so a
     * reviewer can approve every proposal here and still find the run will not
     * continue. Shown so that outcome is predictable rather than discovered.
     */
    approvalExpiresAt: string | null;
    proposals: CheckpointProposal[];
    /**
     * Were there more pending proposals than the bound returned?
     *
     * A flag rather than a total: the panel's answer to "too many to review
     * here" is to send the reviewer to the queue, and that decision does not
     * need the count. A truncation that said nothing would be the "silent cap
     * reads as complete coverage" failure.
     */
    truncated: boolean;
}

/**
 * Read one run's open checkpoint: its status, and every PENDING proposal it
 * queued, each with a freshly-computed diff.
 *
 * Tenant scope is the predicate, so a run in another tenant is NOT-FOUND
 * rather than forbidden — the same anti-enumeration posture as the rest of the
 * `/agent-runs` family.
 */
export async function getRunCheckpointReview(
    ctx: RequestContext,
    runId: string,
): Promise<RunCheckpointReview> {
    assertCanRead(ctx);

    const run = await runInTenantContext(ctx, (db) =>
        db.workflowRun.findFirst({
            where: { id: runId, tenantId: ctx.tenantId },
            select: {
                id: true,
                workflowKey: true,
                status: true,
                approvalExpiresAt: true,
            },
        }),
    );
    if (!run) throw notFound('Workflow run not found');

    // `take: MAX + 1`, so "there are more" is ANSWERED rather than assumed. A
    // read of exactly the bound cannot tell a checkpoint that queued the
    // ceiling from one that queued a hundred, and those are different things
    // to tell a reviewer.
    const rows = await runInTenantContext(ctx, (db) =>
        db.agentProposal.findMany({
            where: { tenantId: ctx.tenantId, runId, status: 'PENDING' },
            // By step, then by creation — one step can queue several, and
            // their order within it is the order the agent produced them.
            orderBy: [{ stepSeq: 'asc' }, { createdAt: 'asc' }],
            take: MAX_CHECKPOINT_PROPOSALS + 1,
            select: {
                id: true,
                kind: true,
                operation: true,
                status: true,
                targetEntityId: true,
                rationale: true,
                stepSeq: true,
                guardVerdict: true,
                guardRuleIds: true,
                guardInputDigest: true,
                expiresAt: true,
                createdAt: true,
                // READ, NEVER RETURNED. `buildProposalDiffs` needs it to
                // compute the diff; the projection below does not carry it.
                payloadJson: true,
            },
        }),
    );
    const truncated = rows.length > MAX_CHECKPOINT_PROPOSALS;
    const page = truncated ? rows.slice(0, MAX_CHECKPOINT_PROPOSALS) : rows;

    const diffs = await buildProposalDiffs(ctx, page);

    return {
        runId: run.id,
        workflowKey: run.workflowKey,
        status: run.status,
        awaitingHuman: run.status === 'AWAITING_APPROVAL',
        approvalExpiresAt: run.approvalExpiresAt?.toISOString() ?? null,
        proposals: page.map((p) => ({
            id: p.id,
            kind: p.kind,
            operation: p.operation,
            status: p.status,
            targetEntityId: p.targetEntityId,
            rationale: p.rationale,
            stepSeq: p.stepSeq,
            guardVerdict: p.guardVerdict,
            guardRuleIds: p.guardRuleIds,
            guardInputDigest: p.guardInputDigest,
            // ISO STRINGS, serialised HERE rather than left as `Date`s for
            // `JSON.stringify` to convert on the way out. The client derives
            // its type from this function's return, and a `Date` in that type
            // is a lie the compiler accepts: the browser receives a string,
            // and `#3546` shipped within one commit of calling
            // `.toISOString()` on one. The projection owns the wire shape.
            expiresAt: p.expiresAt?.toISOString() ?? null,
            createdAt: p.createdAt.toISOString(),
            // Non-null by `buildProposalDiffs`' contract (an entry per input);
            // the fallback exists so a contract change cannot render a card
            // with no diff and an approve control beside it. PAYLOAD_UNREADABLE
            // is not reviewable, so the failure mode is a BLOCKED approval,
            // never a silent one.
            diff: diffs.get(p.id) ?? {
                status: 'PAYLOAD_UNREADABLE' as const,
                fields: [],
                baseDigest: null,
                comparedFieldCount: 0,
            },
        })),
        truncated,
    };
}
