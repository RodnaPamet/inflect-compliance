/**
 * THE REVIEW RUN'S OWNER SUGGESTION, STORED (#3728, a follow-up of #3712 under
 * the agentic IAM roadmap #3654).
 *
 * A `discovered-agent-review` run on the Flue engine is taught
 * `nhi-ownership-attribution` and answers with an owner suggestion for one
 * discovered agent. Until this module that answer was parsed nowhere: the
 * output contract (`parseOwnershipAttribution`) had one consumer, the
 * registration intake, which parses an answer a REQUEST carries — and the
 * harness tab could not carry one, because its payload names no person. So no
 * suggestion was ever shown.
 *
 * This is the seam where the run's answer becomes a trusted row:
 *
 *   run COMPLETED ─ executeFrom ─▶ captureReviewAttributionAfterRun
 *     └ captureReviewAttribution(ctx, runId)          (the ONE writer)
 *         run row: this workflow, COMPLETED, FLUE, the attribution skill pinned
 *         run input: the sealed context, opened under verification
 *         the answer: the run's last Art 12 row (`AiDecisionLog.outputSummary`,
 *           sanitised and bounded by `logAiDecision`) — the one place a Flue
 *           run's model output lands, and the engine is not given a second
 *         readAttributionFromAnswer → the contract, or a named refusal
 *         the answer's agent must be the run's input, and exist in this tenant
 *         newest review wins; an older run never replaces a newer one
 *         ▼
 *       DiscoveredAgentAttribution (status, grade, reason, person-free signals,
 *       the run id; the person a SUGGESTED answer named apart and encrypted)
 *
 * ── A SUGGESTION, NEVER AN OWNER ────────────────────────────────────────────
 *
 * The row is read by two things: the harness tab's shadow list, which selects
 * everything but the person, and the intake, which reads the person only to
 * compare with the owner a person CONFIRMED and records the boolean. No path
 * from this row reaches `ownerUserId` (`registerShadowAgent` takes the owner
 * from its request alone).
 *
 * ── WHO MAY WRITE ───────────────────────────────────────────────────────────
 *
 * Nobody by request: there is no route. The capture runs where every run
 * settles (`workflow-runs.ts` `executeFrom`), on the run's own context, and its
 * authority is the run row it re-reads — a COMPLETED run of this workflow, in
 * this tenant, under RLS. It writes a suggestion about the agent the run was
 * asked about and nothing else; a register row, an owner, a finding or a
 * `DiscoveredAgent` column is not in reach.
 *
 * ── FAIL CLOSED, NEVER SILENTLY ─────────────────────────────────────────────
 *
 * Every path that records nothing returns a named outcome, counted by
 * `recordAgentReviewAttribution` and logged with the outcome alone — never the
 * answer, never an issue the contract raised over it (those quote the model).
 * The after-run wrapper never throws: a suggestion is not worth failing a run
 * that has already completed.
 *
 * `tests/guards/agent-harness-single-write-seam.test.ts` holds this file as the
 * table's one writer.
 */
import { Prisma } from '@prisma/client';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability/logger';
import { recordAgentReviewAttribution } from '@/lib/observability/integration-metrics';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { ContextIntegrityError, openSealedContext } from '@/lib/agentic/context-integrity';
import { readRecordedRunDriver } from '@/lib/agentic/agent-driver-stored-mode';
import { RUN_DRIVER_UNRECOGNISED } from '@/lib/agentic/agent-driver';
import { discoveredAgentReviewWorkflow } from '@/lib/agentic/workflows/discovered-agent-review';
import {
    ATTRIBUTION_SKILL,
    parseStoredSignals,
    readAttributionFromAnswer,
    storedAttributionFields,
    type AnswerRefusal,
} from '@/lib/agentic/review-attribution';
import type { StoredSuggestion } from '@/lib/agentic/registration-intake';

/** The workflow whose answers are captured — by its definition, not a second literal. */
export const REVIEW_WORKFLOW_KEY = discoveredAgentReviewWorkflow.key;

/**
 * The Art 12 feature a Flue run of the review records under. `recordModelDecision`
 * namespaces every row `agentic-run:<workflow key>`; the integration test writes
 * the row through that real recorder, so a drift between the two spellings is a
 * red test rather than a capture that never finds an answer.
 */
export const REVIEW_DECISION_FEATURE = `agentic-run:${REVIEW_WORKFLOW_KEY}`;

export type AttributionCaptureOutcome =
    | 'RECORDED'
    /** This run's answer is already the stored one. */
    | 'ALREADY_RECORDED'
    /** A review that completed later is already stored; this one does not replace it. */
    | 'SUPERSEDED'
    /** No run of this workflow with that id in this tenant. */
    | 'NOT_A_REVIEW_RUN'
    | 'RUN_NOT_COMPLETED'
    /** The static engine: no model, no answer. */
    | 'NOT_A_MODEL_RUN'
    /**
     * The run records an engine this build does not know (#4241) — a later
     * image started it and production rolled back. Not captured: this build
     * cannot say the run had a model, or what shape its answer takes. Its own
     * outcome rather than `NOT_A_MODEL_RUN`, which would say the static engine
     * walked it.
     */
    | 'UNRECOGNISED_ENGINE'
    /** The run was not taught the attribution skill, so its answer is not one. */
    | 'SKILL_NOT_MOUNTED'
    /** The sealed context would not open, or names no agent. */
    | 'INPUT_UNREADABLE'
    /** No Art 12 row with the run's settled text. */
    | 'NO_ANSWER'
    | AnswerRefusal
    /** The answer is about a different discovered agent from the one the run was asked about. */
    | 'ANSWER_FOR_ANOTHER_AGENT'
    | 'DISCOVERED_AGENT_NOT_FOUND';

export interface AttributionCaptureResult {
    readonly outcome: AttributionCaptureOutcome;
    /** The discovered agent the run was asked about, when it could be read. */
    readonly discoveredAgentId: string | null;
}

/** The pins a run row carries, read defensively: the column is `Json?`. */
function mountedNames(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((p) =>
        typeof p === 'object' && p !== null && typeof (p as { name?: unknown }).name === 'string'
            ? [(p as { name: string }).name]
            : [],
    );
}

const done = (outcome: AttributionCaptureOutcome, discoveredAgentId: string | null = null): AttributionCaptureResult => ({
    outcome,
    discoveredAgentId,
});

/**
 * Store the owner suggestion a completed review run answered with — THE one
 * writer of `DiscoveredAgentAttribution`. Returns what happened; records
 * nothing on every outcome but `RECORDED`.
 */
export async function captureReviewAttribution(ctx: RequestContext, runId: string): Promise<AttributionCaptureResult> {
    const result = await runInTenantContext(ctx, (db) => capture(db, ctx, runId));
    recordAgentReviewAttribution({ outcome: result.outcome });
    if (result.outcome !== 'RECORDED') {
        logger.info('agent-harness-attribution: no suggestion recorded', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            runId,
            // The outcome only. The answer and the contract's issues quote the
            // model, and a log line is not where model output goes.
            outcome: result.outcome,
        });
    }
    return result;
}

async function capture(db: PrismaTx, ctx: RequestContext, runId: string): Promise<AttributionCaptureResult> {
    const run = await db.workflowRun.findFirst({
        where: { id: runId, tenantId: ctx.tenantId, workflowKey: REVIEW_WORKFLOW_KEY },
        // No `driver` here: it is read below AS TEXT (#4241), because a value
        // this build's enum does not know fails a typed read of it outright —
        // the capture would throw rather than refuse.
        select: {
            id: true,
            status: true,
            mountedSkills: true,
            completedAt: true,
            contextJson: true,
            contextHash: true,
        },
    });
    if (!run) return done('NOT_A_REVIEW_RUN');
    if (run.status !== 'COMPLETED' || run.completedAt === null) return done('RUN_NOT_COMPLETED');
    const driver = await readRecordedRunDriver(db, ctx.tenantId, run.id);
    if (driver === RUN_DRIVER_UNRECOGNISED) return done('UNRECOGNISED_ENGINE');
    if (driver !== 'FLUE') return done('NOT_A_MODEL_RUN');
    if (!mountedNames(run.mountedSkills).includes(ATTRIBUTION_SKILL)) return done('SKILL_NOT_MOUNTED');

    // WHICH AGENT THE RUN WAS ASKED ABOUT — from the sealed context, opened
    // under verification exactly as the engines open it. Not from the answer:
    // the answer naming an agent is a claim, and it is checked against this.
    let askedAbout: string;
    try {
        const { context } = openSealedContext({
            tenantId: ctx.tenantId,
            runId: run.id,
            storedJson: run.contextJson,
            storedHash: run.contextHash,
        });
        const value = context.input.discoveredAgentId;
        if (typeof value !== 'string' || value.trim() === '') return done('INPUT_UNREADABLE');
        askedAbout = value;
    } catch (err) {
        if (err instanceof ContextIntegrityError) return done('INPUT_UNREADABLE');
        throw err;
    }

    // THE ANSWER: the run's last settled text. One row per model call, and
    // only the last call of a dispatch carries the text, so the newest row
    // that has any is the run's answer.
    const decision = await db.aiDecisionLog.findFirst({
        where: {
            tenantId: ctx.tenantId,
            sessionRef: run.id,
            feature: REVIEW_DECISION_FEATURE,
            outputSummary: { not: null },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { outputSummary: true },
    });
    if (!decision?.outputSummary) return done('NO_ANSWER', askedAbout);

    const reading = readAttributionFromAnswer(decision.outputSummary);
    if (!reading.ok) return done(reading.reason, askedAbout);
    if (reading.attribution.discoveredAgentId !== askedAbout) return done('ANSWER_FOR_ANOTHER_AGENT', askedAbout);

    const agent = await db.discoveredAgent.findFirst({
        where: { id: askedAbout, tenantId: ctx.tenantId },
        select: { id: true, discoveredId: true },
    });
    if (!agent) return done('DISCOVERED_AGENT_NOT_FOUND', askedAbout);

    const fields = storedAttributionFields(reading.attribution);
    const data = {
        runId: run.id,
        status: fields.status,
        grade: fields.grade,
        unmatchedReason: fields.unmatchedReason,
        // Model output, so sanitised on the way in (C.5) as well as bounded and
        // schema-checked by the contract; encrypted at rest (Epic B).
        signalsJson: JSON.stringify(fields.signals.map((s) => ({ ...s, evidence: sanitizePlainText(s.evidence) }))),
        proposedOwnerRef: fields.proposedOwnerRef === null ? null : sanitizePlainText(fields.proposedOwnerRef),
        runCompletedAt: run.completedAt,
    };

    const existing = await db.discoveredAgentAttribution.findFirst({
        where: { tenantId: ctx.tenantId, discoveredAgentId: agent.id },
        select: { id: true, runId: true, runCompletedAt: true },
    });
    if (existing?.runId === run.id) return done('ALREADY_RECORDED', agent.id);
    if (existing && existing.runCompletedAt.getTime() > run.completedAt.getTime()) return done('SUPERSEDED', agent.id);

    if (existing) {
        // Conditional on the stored run still being no newer, so two captures
        // racing for one agent leave the newer review standing whichever
        // commits last.
        const moved = await db.discoveredAgentAttribution.updateMany({
            where: { id: existing.id, tenantId: ctx.tenantId, runCompletedAt: { lte: run.completedAt } },
            data,
        });
        if (moved.count === 0) return done('SUPERSEDED', agent.id);
    } else {
        try {
            await db.discoveredAgentAttribution.create({
                data: { tenantId: ctx.tenantId, discoveredAgentId: agent.id, ...data },
            });
        } catch (err) {
            // Another capture for this agent inserted first. Its run may be the
            // newer one; the next completed review settles it either way, and
            // reporting this run as superseded records nothing false.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                return done('SUPERSEDED', agent.id);
            }
            throw err;
        }
    }

    // Audit, last. Status, grade and counts — never the person, and never the
    // evidence pointers, which are model text bound for the tenant's SIEM.
    await logEvent(db, ctx, {
        action: 'AGENT_OWNER_SUGGESTION_RECORDED',
        entityType: 'DiscoveredAgent',
        entityId: agent.id,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'DiscoveredAgentAttribution',
            operation: existing ? 'updated' : 'created',
            summary:
                `Stored the owner suggestion of review run ${run.id} for discovered agent ${agent.discoveredId} ` +
                `(${fields.status}${fields.grade ? `, ${fields.grade}` : ''}). A suggestion: a person confirms the owner.`,
            after: {
                runId: run.id,
                status: fields.status,
                grade: fields.grade,
                unmatchedReason: fields.unmatchedReason,
                signalCount: fields.signals.length,
                signalsNamingPerson: fields.signals.filter((s) => s.namesPerson).length,
            },
        },
    });
    return done('RECORDED', agent.id);
}

/**
 * The hook `executeFrom` calls when a run settles. Acts only on a COMPLETED run
 * of the review, and NEVER THROWS: the run has already completed, and a
 * suggestion that could not be stored must not report it as failed.
 */
export async function captureReviewAttributionAfterRun(
    ctx: RequestContext,
    runId: string,
    workflowKey: string,
    status: string,
): Promise<AttributionCaptureResult | null> {
    if (workflowKey !== REVIEW_WORKFLOW_KEY || status !== 'COMPLETED') return null;
    try {
        return await captureReviewAttribution(ctx, runId);
    } catch (err) {
        recordAgentReviewAttribution({ outcome: 'error' });
        logger.warn('agent-harness-attribution: capture failed; the run stands', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            runId,
            error: err instanceof Error ? err.name : 'unknown',
        });
        return null;
    }
}

/**
 * The stored suggestion for one discovered agent, WITH the person reference —
 * for the intake's comparison and nothing else. `null` when none is stored or
 * the row does not re-validate.
 */
export async function readStoredSuggestion(
    db: PrismaTx,
    ctx: RequestContext,
    discoveredAgentId: string,
): Promise<StoredSuggestion | null> {
    const row = await db.discoveredAgentAttribution.findFirst({
        where: { tenantId: ctx.tenantId, discoveredAgentId },
        select: {
            runId: true,
            status: true,
            grade: true,
            unmatchedReason: true,
            signalsJson: true,
            proposedOwnerRef: true,
        },
    });
    if (!row) return null;
    const signals = parseStoredSignals(row.signalsJson);
    if (signals === null) return null;
    if (row.status === 'SUGGESTED') {
        if ((row.grade !== 'STRONG' && row.grade !== 'WEAK') || row.proposedOwnerRef === null) return null;
        return { runId: row.runId, status: 'SUGGESTED', grade: row.grade, unmatchedReason: null, signals, proposedOwnerRef: row.proposedOwnerRef };
    }
    if (row.status === 'AMBIGUOUS') {
        return { runId: row.runId, status: 'AMBIGUOUS', grade: null, unmatchedReason: null, signals, proposedOwnerRef: null };
    }
    if (row.status === 'UNMATCHED' && (row.unmatchedReason === 'NO_OWNER_SIGNAL' || row.unmatchedReason === 'OWNER_DEPARTED')) {
        return { runId: row.runId, status: 'UNMATCHED', grade: null, unmatchedReason: row.unmatchedReason, signals, proposedOwnerRef: null };
    }
    return null;
}
