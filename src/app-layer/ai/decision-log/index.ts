/**
 * AI decision log — EU AI Act Art 12 record-keeping + AI-ops observability.
 *
 * One row per AI-feature invocation. The row stores a DIGEST of the sanitised
 * input (never the raw prompt/PII) + a bounded, sanitised output summary +
 * latency/cost + the output-guard verdict. Rows are append-only (a DB trigger
 * blocks edits to the core record); the only permitted mutation is a one-way
 * humanOutcome stamp (PENDING → terminal) — the Art 14 human-oversight feedback.
 *
 * PROVENANCE: authored from the Regulation + IC's own Epic E observability
 * patterns. Nothing derives from any third-party (AGPL) source.
 */
import { createHash } from 'node:crypto';
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { recordAiDecisionLogged, recordAiDecisionOutcome } from '@/lib/observability/metrics';
import { logger } from '@/lib/observability/logger';

/**
 * Bounded output-summary length — never store large/raw content.
 *
 * TWO bounds, because one number was sized for one SHAPE of output and then
 * inherited by another. 500 characters is a summary: a risk suggestion, a
 * posture blurb, the one-shot features this log was built for.
 *
 * An agentic run does not summarise, it SYNTHESISES — several tool results
 * into one structured review. Measured in production on 2026-09-24: a
 * `posture-review` run read four surfaces, produced ~1,900 output tokens, and
 * 500 characters survived, cutting the conclusion off mid-table. The Art 12
 * row is the ONLY record of what the agent concluded — `WorkflowRun.summary`
 * is deliberately not a second copy — so at that ratio the cap is not
 * bounding the record, it is discarding it.
 *
 * Both still sanitise, and the column is encrypted at rest either way. The
 * cap is a proportionality decision, not a safety one, and proportion is a
 * property of the output's shape.
 */
const SUMMARY_MAX = 500;
const AGENTIC_SUMMARY_MAX = 4000;

/**
 * Which bound this feature's output gets.
 *
 * Keyed on the `agentic-run:` prefix `recordModelDecision` writes, so a new
 * workflow inherits the right bound without a list to update. Every other
 * feature keeps 500 — widening them all would store more of outputs that
 * never needed it.
 */
export function summaryCapFor(feature: string): number {
    // `assistant` joins `agentic-run` on the SHAPE argument above, not by
    // analogy: a turn that reached several read tools composes one answer from
    // their results, which is synthesis rather than summary. And the row is the
    // only record of what it said — there is no conversation store beside it —
    // so at that ratio 500 characters would discard the record rather than bound
    // it, which is the same sentence this file already writes about runs.
    //
    // Deliberately NOT done by naming the feature `agentic-run:assistant`. The
    // assistant has no agent, no policy card and no WorkflowRun; a feature name
    // claiming otherwise would make the Art 12 record assert something false
    // about what produced the answer.
    return feature.startsWith('agentic-run') || feature.startsWith('assistant')
        ? AGENTIC_SUMMARY_MAX
        : SUMMARY_MAX;
}

/**
 * What a HUMAN's review can conclude — the argument type of the Art 14 stamp.
 *
 * `AUTONOMOUS` is deliberately absent, although `AiHumanOutcome` holds it. The
 * stamp's whole contract is to move a row that was PENDING because a person
 * acted on it; an `AUTONOMOUS` row was never PENDING and no person ever acted.
 * Admitting the value here would make "nobody reviewed this" something a later
 * caller could assert about a row that HAD been queued for review, which is the
 * one direction the record must not be able to travel.
 */
export type AiDecisionOutcome = 'ACCEPTED' | 'EDITED' | 'REJECTED';

/**
 * The one outcome that is TRUE AT INSERT, so it is written rather than stamped.
 *
 * Typed as this single literal rather than as `AiHumanOutcome`, for the reason
 * above read in the other direction: a write-time field accepting ACCEPTED
 * would let a caller record a human verdict for a review that never happened.
 * The default stays PENDING, so every existing caller is unaffected.
 */
export type AiDecisionAutonomousStamp = 'AUTONOMOUS';

/**
 * SHA-256 digest of the sanitised provider input. This is what proves "the same
 * question was asked" without ever persisting the prompt or any PII it carried.
 */
export function computeInputDigest(sanitizedInput: unknown): string {
    return 'sha256:' + createHash('sha256').update(JSON.stringify(sanitizedInput ?? null)).digest('hex');
}

export interface LogAiDecisionInput {
    /** The AI feature (e.g. 'risk-suggestions'). */
    feature: string;
    provider: string;
    model?: string | null;
    /** The ALREADY-sanitised provider input — hashed, never stored raw. */
    sanitizedInput: unknown;
    /** A short human-readable summary of the output — sanitised + bounded here. */
    outputSummary?: string | null;
    latencyMs?: number | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    guardVerdict?: string | null;
    guardBlocked?: boolean;
    /** Optional registered AI system this decision belongs to (Art 12 record). */
    aiSystemId?: string | null;
    /** The generating session id — the feedback join key. */
    sessionRef?: string | null;
    /**
     * Stamp the row terminal AT INSERT, for a decision no human will review.
     *
     * Three callers: the external-write ladder's `AUTOMATIC` arm (#2861),
     * which dispatches with nobody in the loop; an assistant answer, which
     * goes straight to the person who asked; and an external tool call a run
     * made, which has left the platform before the row is written (both
     * #4896). Omit it and the row lands `PENDING`, which is the right default
     * for every other feature — those decisions DO reach a reviewer.
     *
     * Leaving such a row PENDING instead was the first design and it is wrong
     * in a way that compounds: nothing can ever stamp it, so
     * `buildDecisionArtefact` reports a "still pending review" count that only
     * grows, and an assessor reads a backlog where there is in fact a rung
     * somebody deliberately granted.
     */
    humanOutcome?: AiDecisionAutonomousStamp;
    /**
     * The `AgentProposal` this row records — `createAgentProposal` only.
     *
     * Written at insert and frozen by the immutability trigger. It is what the
     * proposal path's Art 14 stamp keys on (`recordDecisionOutcomeForProposal`):
     * the input digest is a function of CONTENT, and two proposals with the same
     * content share it, so it cannot say which of them a decision was about.
     */
    agentProposalId?: string | null;
}

/**
 * Write ONE decision-log row for an AI-feature invocation. Returns the row id.
 * Must run inside the caller's tenant-scoped transaction (`db`).
 */
export async function logAiDecision(
    db: PrismaTx,
    ctx: RequestContext,
    input: LogAiDecisionInput,
): Promise<string> {
    // Privacy: digest the input; sanitise + bound the summary. Neither the raw
    // prompt nor PII is ever persisted.
    const summary = input.outputSummary
        ? sanitizePlainText(input.outputSummary).slice(0, summaryCapFor(input.feature))
        : null;

    const row = await db.aiDecisionLog.create({
        data: {
            tenantId: ctx.tenantId,
            feature: input.feature,
            aiSystemId: input.aiSystemId ?? null,
            provider: input.provider,
            model: input.model ?? null,
            inputDigest: computeInputDigest(input.sanitizedInput),
            outputSummary: summary,
            latencyMs: input.latencyMs ?? null,
            tokensIn: input.tokensIn ?? null,
            tokensOut: input.tokensOut ?? null,
            guardVerdict: input.guardVerdict ?? null,
            sessionRef: input.sessionRef ?? null,
            // Omitted rather than written as 'PENDING' when absent, so the
            // column's own `@default(PENDING)` stays the single statement of
            // what an unreviewed-but-reviewable row is.
            ...(input.humanOutcome ? { humanOutcome: input.humanOutcome } : {}),
            userId: ctx.userId,
            // The registered agent this request speaks for — the binding of
            // the API key it authenticated with — or NULL, never a guess: the
            // same `ctx.agentId ?? null` every agentic write seam records. It
            // is what attributes the decision to ONE agent's evidence (#3700),
            // and the append-only trigger keeps it from being re-attributed.
            agentId: ctx.agentId ?? null,
            agentProposalId: input.agentProposalId ?? null,
        },
        select: { id: true },
    });

    recordAiDecisionLogged({
        provider: input.provider,
        feature: input.feature,
        guardBlocked: input.guardBlocked,
    });

    return row.id;
}

/**
 * Record the human-oversight outcome (Art 14) on the decision(s) for a session.
 * One-way: only PENDING rows transition (the DB trigger also enforces this).
 * Returns the number of rows stamped.
 */
export async function recordDecisionOutcome(
    db: PrismaTx,
    ctx: RequestContext,
    sessionRef: string,
    outcome: AiDecisionOutcome,
): Promise<number> {
    const res = await db.aiDecisionLog.updateMany({
        where: { tenantId: ctx.tenantId, sessionRef, humanOutcome: 'PENDING' },
        data: { humanOutcome: outcome },
    });
    if (res.count > 0) recordAiDecisionOutcome({ outcome });
    return res.count;
}

/**
 * Stamp a FINISHED run's still-pending rows "no human review" (#4896).
 *
 * ── THE ONE PATH FROM PENDING TO AUTONOMOUS ─────────────────────────────────
 *
 * `AiDecisionOutcome` keeps `AUTONOMOUS` out of the human stamp, so that
 * "nobody reviewed this" can never be asserted about a row that was queued
 * for a reviewer. A run's model calls are written PENDING because, when they
 * are written, nobody knows whether the run will stop for approval. One that
 * finishes without stopping — and leaves no proposal for a person to decide —
 * was never going to be reviewed, and leaving its rows PENDING built a
 * backlog no person is ever asked to clear, which the evidence pack counted
 * as "still pending review". The owner decided on 2026-11-01 that such rows
 * are stamped "no human review" when the run settles. This function and its
 * batch twin below are that stamp, and the only writers of `AUTONOMOUS` after
 * insert: neither takes an outcome, so no caller can pass a human verdict
 * through them.
 *
 * Keyed by the run id, which every run-written row carries as `sessionRef`.
 * One-way like the others: only PENDING rows move, and the DB trigger refuses
 * any second change. The CALLER decides that the run is finished and left no
 * pending proposal; see `settleRunDecisionLog` in `workflow-runs.ts` and the
 * expiry sweep.
 */
export async function recordRunDecisionsUnreviewed(
    db: PrismaTx,
    ctx: RequestContext,
    runId: string,
): Promise<number> {
    const res = await db.aiDecisionLog.updateMany({
        where: { tenantId: ctx.tenantId, sessionRef: runId, humanOutcome: 'PENDING' },
        data: { humanOutcome: 'AUTONOMOUS' },
    });
    return res.count;
}

/**
 * `recordRunDecisionsUnreviewed` for several runs across tenants at once — the
 * proposal expiry sweep's (#4896): a run whose last pending proposal expired
 * undecided was never reviewed. The CALLER passes only runs that are finished
 * and hold no other pending proposal. One statement, so a sweep over many runs
 * is not a write per run.
 */
export async function recordRunsDecisionsUnreviewed(
    db: PrismaTx,
    runs: ReadonlyArray<{ readonly tenantId: string; readonly runId: string }>,
): Promise<number> {
    if (runs.length === 0) return 0;
    const res = await db.aiDecisionLog.updateMany({
        where: {
            humanOutcome: 'PENDING',
            OR: runs.map((r) => ({ tenantId: r.tenantId, sessionRef: r.runId })),
        },
        data: { humanOutcome: 'AUTONOMOUS' },
    });
    return res.count;
}

/**
 * The `feature` every proposal's Art 12 row is written under by
 * `createAgentProposal`, read back by the legacy arm of the proposal stamp
 * below. `tests/integration/agent-proposal-decision-stamp-per-proposal.test.ts`
 * holds the row the real usecase writes to this value.
 */
export const AGENT_PROPOSAL_DECISION_FEATURE = 'agent-proposal';

/** Which proposal a human decided — the Art 14 stamp's subject on the proposal path. */
export interface ProposalDecisionRef {
    /** `AgentProposal.id`. The key: the row `createAgentProposal` wrote names it. */
    readonly proposalId: string;
    /**
     * `AgentProposal.guardInputDigest`. Read ONLY for a proposal whose row was
     * written before the id was recorded (migration 20261114120000), and even
     * then only when it is unambiguous — see the legacy arm below.
     */
    readonly inputDigest: string | null;
}

/**
 * The Art 14 stamp for ONE agent proposal: the row that proposal's creation
 * wrote, and no other (#5191).
 *
 * ── WHY NOT THE DIGEST ──────────────────────────────────────────────────────
 *
 * This was `recordDecisionOutcomeForDigest`, keyed by `(tenantId, inputDigest)`.
 * The digest is `computeProposalDigest({ kind, payload, rationale })` — a pure
 * function of CONTENT — and `createAgentProposal` does not de-duplicate, so two
 * PENDING proposals with identical content share it. Approving the first
 * stamped BOTH rows ACCEPTED; rejecting the second then matched nothing, and
 * the register recorded ACCEPTED for a decision a human REJECTED. A content
 * fingerprint answers "was this the same content", never "was this the same
 * decision". (The session key is no better: `sessionRef` on this path is the
 * optional `proposedBySessionRef`, shared by every proposal a session raised.)
 *
 * So the row carries the proposal's id (`AiDecisionLog.agentProposalId`,
 * written at insert, frozen by the immutability trigger, unique per tenant),
 * and the stamp keys on that. It moves at most ONE row on every path.
 *
 * ── LEGACY ROWS ─────────────────────────────────────────────────────────────
 *
 * A proposal created before the column existed has a row with no id on it.
 * For that proposal, and only when NO row names it, the digest is consulted —
 * restricted to proposal rows that name no proposal — and the stamp lands only
 * when EXACTLY ONE pending row matches. Two is the ambiguity above, and
 * guessing would write one reviewer's decision onto somebody else's record, so
 * it stamps none and says so. Stamping nothing leaves a row honestly PENDING;
 * stamping the wrong one makes it falsely decided.
 *
 * ── NEVER SILENT ────────────────────────────────────────────────────────────
 *
 * Every path that stamps nothing logs a warning naming why. Returns the number
 * of rows stamped (0 or 1); one-way, PENDING rows only, as the trigger holds.
 */
export async function recordDecisionOutcomeForProposal(
    db: PrismaTx,
    ctx: RequestContext,
    ref: ProposalDecisionRef,
    outcome: AiDecisionOutcome,
): Promise<number> {
    const own = await db.aiDecisionLog.updateMany({
        where: { tenantId: ctx.tenantId, agentProposalId: ref.proposalId, humanOutcome: 'PENDING' },
        data: { humanOutcome: outcome },
    });
    if (own.count > 0) {
        recordAiDecisionOutcome({ outcome });
        return own.count;
    }

    // Ids, a fixed reason token and counts only — nothing of the proposal's
    // content, which the digest exists to keep out of every record.
    // Every field is a MEMBER read, never a bare local: a bare identifier at a
    // sink is a name `local/no-raw-prompt-logging` cannot resolve.
    const stamped = { outcome };
    const warn = (detail: { reason: string; recordedOutcome?: string; pendingRowsForDigest?: number }) =>
        logger.warn('ai-decision-log: proposal decision not stamped', {
            component: 'ai-decision-log',
            tenantId: ctx.tenantId,
            proposalId: ref.proposalId,
            outcome: stamped.outcome,
            reason: detail.reason,
            recordedOutcome: detail.recordedOutcome ?? null,
            pendingRowsForDigest: detail.pendingRowsForDigest ?? null,
        });

    // The proposal HAS its row, and it is no longer PENDING: a decision is
    // already recorded on it, and the record is one-way.
    const linked = await db.aiDecisionLog.findFirst({
        where: { tenantId: ctx.tenantId, agentProposalId: ref.proposalId },
        select: { humanOutcome: true },
    });
    if (linked) {
        warn({ reason: 'ALREADY_RECORDED', recordedOutcome: linked.humanOutcome });
        return 0;
    }

    // No row names this proposal: a legacy row, or none was written.
    if (!ref.inputDigest) {
        warn({ reason: 'NO_DECISION_ROW' });
        return 0;
    }
    const candidates = await db.aiDecisionLog.findMany({
        where: {
            tenantId: ctx.tenantId,
            inputDigest: ref.inputDigest,
            feature: AGENT_PROPOSAL_DECISION_FEATURE,
            agentProposalId: null,
            humanOutcome: 'PENDING',
        },
        select: { id: true },
        // One past the only count that is safe to act on, so "more than one"
        // is a fact held rather than one a cap hides.
        take: 2,
    });
    if (candidates.length !== 1) {
        warn({
            reason: candidates.length === 0 ? 'NO_DECISION_ROW' : 'LEGACY_DIGEST_AMBIGUOUS',
            pendingRowsForDigest: candidates.length,
        });
        return 0;
    }
    const legacy = await db.aiDecisionLog.updateMany({
        where: { tenantId: ctx.tenantId, id: candidates[0].id, humanOutcome: 'PENDING' },
        data: { humanOutcome: outcome },
    });
    if (legacy.count > 0) recordAiDecisionOutcome({ outcome });
    else warn({ reason: 'NO_DECISION_ROW' });
    return legacy.count;
}
