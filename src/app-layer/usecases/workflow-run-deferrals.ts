/**
 * THE DECISION HOOK FOR A DEFERRED TOOL CALL (Step 2f of
 * `docs/claude-tool-runner-design.md`, "4. Who decides, and how the run
 * settles", #5530).
 *
 * A Tool Runner run that called a propose tool its version names in
 * `deferredToolNames` is PARKED at `AWAITING_APPROVAL` on a `WorkflowRunDeferral`
 * row. The decision is the proposal queue's, unchanged: `approveAgentProposal`
 * (with or without edits), `rejectAgentProposal` and `bulkRejectAgentProposals`,
 * with their keys, signatures, exclusions, window and staleness check. No new
 * approval path and no new permission key (owner decision 1a, 2026-11-13).
 *
 * After a decision commits, the queue calls ONE function here,
 * `settleDeferralForProposal`. It does nothing for a proposal no deferral waits
 * on. For one that is waited on:
 *
 *   • a PERSON'S decision (accepted, edited, rejected) moves the deferral
 *     WAITING → DECIDED, claims the run AWAITING_APPROVAL → RUNNING
 *     CONDITIONALLY (the claim `resumeWorkflowRun` makes since #5119, so two
 *     decisions cannot resume one run twice), closes the HUMAN_CHECKPOINT step
 *     DONE with the decider, audits `WORKFLOW_RUN_RESUMED` with
 *     `reason: 'DEFERRAL_DECIDED'`, and enqueues `agent-run-execute`. The
 *     resumed segment re-checks everything before it sends anything
 *     (`tool-runner/execute.ts`). A signature that does not complete the
 *     requirement is not a decision: the proposal is still PENDING, and this
 *     does nothing;
 *   • an EXPIRY (the nightly sweep) settles the run FAILED with a named reason
 *     and the deferral SETTLED, transcript cleared: nobody decided, so nothing
 *     continues unattended days later (owner decision 4a). A retirement does the
 *     same inside the cascade's transaction (`settleRetiredAgentDeferralsInTx`).
 *
 * The table's other writer is the engine's store (`drivers/deferral-store.ts`);
 * `tests/guards/workflow-run-deferral-single-write-seam.test.ts` holds the two.
 *
 * NEVER THROWS to the decision path: the person's decision is already
 * committed, and a failure here must not report it as failed. A deferral left
 * WAITING behind a decided proposal is found again by the expiry sweep's heal.
 */
import type { RequestContext } from '../types';
import { enqueue } from '@/app-layer/jobs/queue';
import { appendAuditEntry } from '@/lib/audit';
import type { PrismaTx } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { isPersonDecision } from '@/lib/agentic/drivers/deferral-store';
import { logger } from '@/lib/observability/logger';

/** A parked run whose proposal's window closed with nobody deciding it (owner decision 4a). */
export const DEFERRAL_EXPIRED_MESSAGE =
    'tool_runner_deferral_expired: nobody decided the proposal this run was waiting for before its window closed.';

/** A parked run whose agent was retired: the cascade expired the proposal it waited on. */
export const DEFERRAL_AGENT_RETIRED_MESSAGE =
    'tool_runner_deferral_agent_retired: the agent was retired while this run waited for a person, so the ' +
    'proposal it waited on expired and the run does not continue.';

/** How one call of the hook ended. For the callers' logs and the tests; nothing branches on it. */
export type DeferralSettlement =
    /** No run waits on this proposal. */
    | 'NO_DEFERRAL'
    /** The proposal is still undecided (a signature short of the requirement, or quarantined). */
    | 'NOT_A_DECISION'
    /** The decision was recorded and the run handed to the worker. */
    | 'RESUMING'
    /** Another call took the deferral first: it is resumed once. */
    | 'ALREADY_TAKEN'
    /** The run was no longer parked (an operator aborted it): the deferral settled, nothing resumes. */
    | 'RUN_NOT_PARKED'
    /** The proposal expired: the run settled FAILED. */
    | 'SETTLED_EXPIRED'
    /** The hook failed; the decision stands and the sweep heals the deferral. */
    | 'ERROR';

/**
 * After a decision on `proposalId` commits. Reads the proposal's own status, so
 * every caller passes the same thing and none can name a decision the queue
 * did not record.
 */
export async function settleDeferralForProposal(ctx: RequestContext, proposalId: string): Promise<DeferralSettlement> {
    try {
        const [deferral, proposal] = await runInTenantContext(ctx, async (db) => [
            await db.workflowRunDeferral.findFirst({
                where: { tenantId: ctx.tenantId, proposalId, status: 'WAITING' },
                select: { id: true, runId: true, stepSeq: true, elapsedMsAtPark: true },
            }),
            await db.agentProposal.findFirst({
                where: { id: proposalId, tenantId: ctx.tenantId },
                select: { status: true, reviewedByUserId: true },
            }),
        ] as const);
        if (!deferral) return 'NO_DEFERRAL';
        if (proposal?.status === 'EXPIRED') return await settleExpired(ctx, proposalId, deferral);
        if (!proposal || !isPersonDecision(proposal.status)) return 'NOT_A_DECISION';
        return await resumeOnDecision(ctx, proposalId, deferral, {
            decision: proposal.status,
            // The person the queue recorded, so a heal run by the sweep names the
            // decider rather than the sweep.
            decidedByUserId: proposal.reviewedByUserId ?? ctx.userId,
        });
    } catch (err) {
        logger.warn('workflow run deferral: the decision hook failed; the expiry sweep will heal it', {
            component: 'workflow-run-deferrals',
            tenantId: ctx.tenantId,
            proposalId,
            error: err instanceof Error ? err.message : 'a non-Error value was thrown',
        });
        return 'ERROR';
    }
}

async function resumeOnDecision(
    ctx: RequestContext,
    proposalId: string,
    deferral: { id: string; runId: string; stepSeq: number; elapsedMsAtPark: number },
    decided: { decision: string; decidedByUserId: string },
): Promise<DeferralSettlement> {
    const now = new Date();
    const outcome = await runInTenantContext(ctx, async (db) => {
        // THE DEFERRAL'S CLAIM: one decision takes it.
        const taken = await db.workflowRunDeferral.updateMany({
            where: { id: deferral.id, tenantId: ctx.tenantId, status: 'WAITING' },
            data: { status: 'DECIDED', decision: decided.decision, decidedAt: now, decidedByUserId: decided.decidedByUserId },
        });
        if (taken.count === 0) return { kind: 'ALREADY_TAKEN' as const };
        // THE RUN'S CLAIM, conditional on the parked state (#5119): exactly one
        // decision moves it to RUNNING, so it is resumed once.
        const claimed = await db.workflowRun.updateMany({
            where: { id: deferral.runId, tenantId: ctx.tenantId, status: 'AWAITING_APPROVAL' },
            data: { status: 'RUNNING' },
        });
        if (claimed.count === 0) {
            // An operator aborted the run, or it settled another way, while it
            // waited. The person's decision stands on the proposal; the run does
            // not continue, and its transcript goes.
            await db.workflowRunDeferral.updateMany({
                where: { id: deferral.id, tenantId: ctx.tenantId, status: 'DECIDED' },
                data: { status: 'SETTLED', settledAt: now, transcriptJson: null },
            });
            return { kind: 'RUN_NOT_PARKED' as const };
        }
        await closeCheckpointInTx(db, ctx, deferral, {
            status: 'DONE',
            actorUserId: decided.decidedByUserId,
            output: { decision: decided.decision, proposalId },
        });
        const run = await db.workflowRun.findFirst({
            where: { id: deferral.runId, tenantId: ctx.tenantId },
            select: { startedAt: true },
        });
        return { kind: 'RESUMING' as const, startedAtMs: run?.startedAt.getTime() ?? now.getTime() };
    });
    if (outcome.kind !== 'RESUMING') return outcome.kind;

    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: decided.decidedByUserId,
        actorType: 'USER',
        entity: 'WorkflowRun',
        entityId: deferral.runId,
        action: 'WORKFLOW_RUN_RESUMED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            reason: 'DEFERRAL_DECIDED',
            proposalId,
            decision: decided.decision,
            deferralId: deferral.id,
        },
    }).catch(() => undefined);

    // THE CLOCK. The engine starts the resumed segment's wall clock at
    // `now - elapsedMsAtPark`, so the wait is never charged; the same base goes
    // in the payload, so a SIGTERM retry of this segment keeps it rather than
    // falling back to the run's start (#5534). Never earlier than the start.
    await enqueue('agent-run-execute', {
        tenantId: ctx.tenantId,
        runId: deferral.runId,
        clockBase: Math.max(outcome.startedAtMs, Date.now() - deferral.elapsedMsAtPark),
    });
    return 'RESUMING';
}

async function settleExpired(
    ctx: RequestContext,
    proposalId: string,
    deferral: { id: string; runId: string; stepSeq: number },
): Promise<DeferralSettlement> {
    const now = new Date();
    const failed = await runInTenantContext(ctx, async (db) => {
        const settled = await db.workflowRunDeferral.updateMany({
            where: { id: deferral.id, tenantId: ctx.tenantId, status: 'WAITING' },
            data: { status: 'SETTLED', decision: 'EXPIRED', settledAt: now, transcriptJson: null },
        });
        if (settled.count === 0) return null;
        await closeCheckpointInTx(db, ctx, deferral, {
            status: 'SKIPPED',
            actorUserId: null,
            output: { decision: 'EXPIRED', proposalId },
        });
        // Only a run still parked is failed: an operator's ABORTED stands.
        const run = await db.workflowRun.updateMany({
            where: { id: deferral.runId, tenantId: ctx.tenantId, status: 'AWAITING_APPROVAL' },
            data: { status: 'FAILED', completedAt: now, errorMessage: DEFERRAL_EXPIRED_MESSAGE },
        });
        return run.count > 0;
    });
    if (failed === null) return 'ALREADY_TAKEN';
    if (failed) {
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: null,
            actorType: 'SYSTEM',
            entity: 'WorkflowRun',
            entityId: deferral.runId,
            action: 'WORKFLOW_RUN_FAILED',
            requestId: ctx.requestId,
            detailsJson: { category: 'access', reason: DEFERRAL_EXPIRED_MESSAGE, proposalId, deferralId: deferral.id },
        }).catch(() => undefined);
    }
    return 'SETTLED_EXPIRED';
}

/**
 * The parked run's checkpoint, closed: DONE with the decider at a decision,
 * SKIPPED at an expiry. Its output names the decision and the proposal, never
 * anything the model wrote.
 */
async function closeCheckpointInTx(
    db: PrismaTx,
    ctx: RequestContext,
    deferral: { runId: string; stepSeq: number },
    close: { status: 'DONE' | 'SKIPPED'; actorUserId: string | null; output: Record<string, unknown> },
): Promise<void> {
    const checkpoint = await db.workflowStep.findFirst({
        where: {
            runId: deferral.runId,
            tenantId: ctx.tenantId,
            kind: 'HUMAN_CHECKPOINT',
            status: 'PENDING',
            seq: { gt: deferral.stepSeq },
        },
        orderBy: { seq: 'asc' },
        select: { id: true },
    });
    if (!checkpoint) return;
    await db.workflowStep.update({
        where: { id: checkpoint.id },
        data: {
            status: close.status,
            actorUserId: close.actorUserId,
            outputJson: JSON.stringify(close.output),
        },
    });
}

/**
 * RETIREMENT, inside the cascade's transaction (#3698's cascade, Step 2f): the
 * cascade expires the agent's pending proposals, so every run of the agent
 * that waits on one settles FAILED, and its deferral SETTLED with the
 * transcript cleared, in the same transaction. Written directly, as every
 * cascade effect is. Unbounded writes, a bounded id list for the audit row.
 */
export async function settleRetiredAgentDeferralsInTx(
    db: PrismaTx,
    ctx: RequestContext,
    agentId: string,
    now: Date,
    idCap: number,
): Promise<{ count: number; ids: string[] }> {
    const waiting = { tenantId: ctx.tenantId, status: 'WAITING', run: { agentId } };
    const rows = await db.workflowRunDeferral.findMany({
        where: waiting,
        select: { runId: true },
        orderBy: { parkedAt: 'asc' },
        take: idCap + 1,
    });
    const runs = await db.workflowRun.updateMany({
        where: {
            tenantId: ctx.tenantId,
            agentId,
            status: 'AWAITING_APPROVAL',
            deferrals: { some: { status: 'WAITING' } },
        },
        data: { status: 'FAILED', completedAt: now, errorMessage: DEFERRAL_AGENT_RETIRED_MESSAGE },
    });
    await db.workflowRunDeferral.updateMany({
        where: waiting,
        data: { status: 'SETTLED', decision: 'EXPIRED', settledAt: now, transcriptJson: null },
    });
    return { count: runs.count, ids: rows.map((r) => r.runId) };
}
