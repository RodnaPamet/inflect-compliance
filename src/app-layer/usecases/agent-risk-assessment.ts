/**
 * Agent risk assessment — usecases.
 *
 * The instrument Singapore IMDA's Model AI Governance Framework for Agentic AI
 * makes dimension 1 ("assess and bound the risks upfront") and that NIST AI RMF,
 * ISO/IEC 42001 and the EU AI Act give a customer no way to fill in.
 *
 * Shape copied deliberately from `ai-gov-self-assessment.ts`: global reference
 * questions, one open tenant-scoped run, answers upserted one at a time with
 * the free-text note sanitised at THIS seam before the Epic B middleware
 * encrypts it. What is different — and what makes this governance rather than a
 * questionnaire — is that completing a run SCORES the agent and writes the tier
 * back onto `RegisteredAgent`, where it caps how much authority the agent may
 * be given.
 *
 * ## Three states, not two
 *
 *   • UNSCORED (`agent.riskTier IS NULL`) — nobody has ever assessed this
 *     agent. `ceilingForRiskTier` resolves it to DENY: the agent can call
 *     nothing.
 *   • SCORED AND FRESH — a completed run whose basis still matches the agent.
 *   • SCORED AND STALE — a completed run whose basis has been overtaken. This
 *     WARNS; it does not deny.
 *
 * Collapsing the last two into the first is the tempting mistake. It would take
 * an agent dark the instant an operator did the correct, audited thing.
 *
 * ## Why warning is SAFE — the tier does not lag the agent
 *
 * `reassessAgentAfterChangeInTx` below is the reason. The scorer is a pure
 * function of four declared axes plus the answers, so when any of those AXES
 * moves the tier can be recomputed IMMEDIATELY from the answers already on
 * file — no human, no fresh questionnaire. It is, in the same transaction that
 * records the widening, and the recomputed tier is written onto the agent
 * whenever it is WORSE. The ceiling therefore narrows at once, and "stale"
 * means only "the twenty answers may be out of date" — which genuinely is a
 * warning.
 *
 * The earlier version of this argument claimed a widening was "inert until
 * somebody re-scores", because the ceiling composes as a `min`. That holds only
 * for autonomy, which is itself a term in the `min`. Data scope, reversibility
 * and provenance appear in the ceiling NOWHERE: an agent could be walked from
 * READ_TENANT_DATA to EXTERNAL_EGRESS and keep its LOW tier and the whole
 * ladder while a fresh score of the same agent came out CRITICAL. Re-scoring on
 * the spot is what makes the claim true rather than hopeful.
 */
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { AgentRiskAssessmentRepository } from '../repositories/AgentRiskAssessmentRepository';
import { RegisteredAgentRepository } from '../repositories/RegisteredAgentRepository';
import {
    isTierAbove,
    scoreAgentRisk,
    type AgentAnswerValue,
    type AgentRiskScore,
    type ScorableQuestion,
} from '@/lib/agentic/agent-risk-scoring';
import {
    evaluateAssessmentStaleness,
    type AssessmentBasis,
    type StalenessVerdict,
} from '@/lib/agentic/agent-assessment-staleness';
import {
    buildAgentAssessmentEvidence,
    unemittedAgentAssessmentEvidence,
} from '@/lib/agentic/agent-assessment-evidence';
import { SaveAgentAssessmentAnswerSchema } from '../schemas/agent-assessment.schemas';
import type { RequestContext } from '../types';

/**
 * The agent, as the scorer and the staleness comparison need it.
 * `notFound` rather than a null return: every caller here needs the agent, and
 * a shared "maybe" would push the same check into four places.
 */
async function loadAgentScoringState(db: PrismaTx, ctx: RequestContext, agentId: string) {
    const agent = await RegisteredAgentRepository.getScoringState(db, ctx, agentId);
    if (!agent) throw notFound('Registered agent not found');
    return agent;
}

type AgentScoringState = Awaited<ReturnType<typeof loadAgentScoringState>>;

/** The live agent expressed as a basis, so `evaluate…` compares like with like. */
function currentBasis(agent: AgentScoringState): AssessmentBasis {
    return {
        autonomyLevel: agent.autonomyLevel,
        dataAccessScope: agent.dataAccessScope,
        reversibility: agent.reversibility,
        provenance: agent.provenance,
        toolCount: agent._count.tools,
        modelRef: agent.modelRef,
    };
}

/**
 * Load-or-create the agent's open run.
 *
 * Mirrors `activeAssessment` in the AI-governance usecase: one open run per
 * agent, created lazily on first read so the operator never has to press
 * "start". A COMPLETED run is never reopened — its tier is the record of a
 * judgement made at a moment, and a re-score opens a NEW run so the previous
 * judgement and the basis it was true of stay legible.
 */
async function openAssessment(db: PrismaTx, ctx: RequestContext, agentId: string) {
    const existing = await AgentRiskAssessmentRepository.findOpen(db, ctx, agentId);
    if (existing) return existing;
    return AgentRiskAssessmentRepository.create(db, ctx, agentId);
}

/**
 * Domains + questions + this agent's answers + the standing tier and whether it
 * is stale.
 */
export async function getAgentRiskAssessmentState(ctx: RequestContext, agentId: string) {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const agent = await loadAgentScoringState(db, ctx, agentId);
        const assessment = await openAssessment(db, ctx, agentId);

        const [domains, questions, answers, latestCompleted] = await Promise.all([
            AgentRiskAssessmentRepository.listDomains(db),
            AgentRiskAssessmentRepository.listQuestions(db),
            AgentRiskAssessmentRepository.listAnswers(db, ctx, assessment.id),
            AgentRiskAssessmentRepository.findLatestCompleted(db, ctx, agentId),
        ]);

        const answerByQuestion = new Map(answers.map((a) => [a.questionId, a]));

        return {
            agent: {
                id: agent.id,
                name: agent.name,
                autonomyLevel: agent.autonomyLevel,
                dataAccessScope: agent.dataAccessScope,
                reversibility: agent.reversibility,
                provenance: agent.provenance,
                modelRef: agent.modelRef,
                grantedToolCount: agent._count.tools,
                // NULL here is UNSCORED, and UNSCORED means deny at the tool
                // boundary. Surfaced as its own field rather than folded into a
                // tier string so a UI cannot render it as a low tier.
                riskTier: agent.riskTier,
                riskTierScoredAt: agent.riskTierScoredAt,
            },
            assessmentId: assessment.id,
            status: assessment.status,
            questionSetVersion: assessment.questionSetVersion,
            domains,
            questions: questions.map((q) => ({
                id: q.id,
                domainId: q.domainId,
                text: q.text,
                guidance: q.guidance,
                criticality: q.criticality,
                mappings: q.mappingsJson,
                answer: (answerByQuestion.get(q.id)?.answer as AgentAnswerValue | undefined) ?? null,
                note: answerByQuestion.get(q.id)?.note ?? null,
            })),
            /**
             * The completed run behind the agent's tier, and its freshness.
             *
             * `tier` here is what the run SCORED — the judgement a human made,
             * against the basis it froze. It is NOT necessarily the tier in
             * force: a widening re-scores the agent from these same answers and
             * writes the result to `agent.riskTier`, which only ever moves
             * upward. `tierInForce` is repeated inside this block so a surface
             * rendering "the assessment" cannot show the scored tier as the
             * operative one without having to reach for another field.
             */
            standing: latestCompleted
                ? {
                      assessmentId: latestCompleted.id,
                      tier: latestCompleted.scoredTier,
                      tierInForce: agent.riskTier,
                      score: latestCompleted.score,
                      completedAt: latestCompleted.completedAt,
                      staleAt: latestCompleted.staleAt,
                      staleTriggers: latestCompleted.staleTriggers,
                      staleness: stalenessFor(latestCompleted, agent),
                  }
                : null,
        };
    });
}

/** Upsert one answer. The note is sanitised HERE, before encryption. */
export async function saveAgentAssessmentAnswer(
    ctx: RequestContext,
    agentId: string,
    input: unknown,
) {
    assertCanWrite(ctx);
    const parsed = SaveAgentAssessmentAnswerSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        await loadAgentScoringState(db, ctx, agentId);

        const question = await db.agentAssessmentQuestion.findUnique({
            where: { id: parsed.questionId },
            select: { id: true },
        });
        if (!question) throw notFound('Assessment question not found');

        const assessment = await openAssessment(db, ctx, agentId);

        // Sanitised at this single write seam, not at each renderer: the column
        // is encrypted at rest, and encryption does nothing for the PDF export
        // or an SDK consumer that decrypts the row and prints it verbatim.
        const note = parsed.note != null ? sanitizePlainText(parsed.note) : null;

        const saved = await AgentRiskAssessmentRepository.upsertAnswer(db, ctx, {
            assessmentId: assessment.id,
            questionId: parsed.questionId,
            answer: parsed.answer,
            note,
        });

        if (assessment.status === 'DRAFT') {
            await AgentRiskAssessmentRepository.setStatus(db, ctx, assessment.id, 'IN_PROGRESS');
        }

        await logEvent(db, ctx, {
            action: 'AGENT_ASSESSMENT_ANSWERED',
            entityType: 'AgentRiskAssessmentAnswer',
            entityId: saved.id,
            detailsJson: {
                category: 'custom',
                event: 'agent_assessment_answered',
                agentId,
                assessmentId: assessment.id,
                questionId: parsed.questionId,
                answer: parsed.answer,
            },
        });

        return saved;
    });
}

/**
 * Score the agent and complete the run — in ONE transaction.
 *
 * The transaction is not decoration. The tier written to `RegisteredAgent` is
 * what caps the agent's authority, and the run is the evidence for it; a
 * partial failure that wrote one without the other would leave either an agent
 * capped by a judgement with no record, or a record of a judgement that does
 * not bind. `runInTenantContext` gives us the transaction, so both writes and
 * the audit row commit together or not at all.
 */
export async function completeAgentRiskAssessment(ctx: RequestContext, agentId: string) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const agent = await loadAgentScoringState(db, ctx, agentId);
        const assessment = await openAssessment(db, ctx, agentId);

        const [questions, answers] = await Promise.all([
            AgentRiskAssessmentRepository.listQuestions(db),
            AgentRiskAssessmentRepository.listAnswers(db, ctx, assessment.id),
        ]);

        const result = scoreAgainst(
            agent,
            questions,
            new Map(answers.map((a) => [a.questionId, a.answer])),
        );

        const basis = currentBasis(agent);
        const scoredAt = new Date();

        const recorded = await AgentRiskAssessmentRepository.recordScore(db, ctx, assessment.id, {
            scoredTier: result.tier,
            score: result.score,
            scoreBreakdownJson: {
                band: result.band,
                floors: [...result.floors],
                ...result.breakdown,
            },
            basisAutonomyLevel: basis.autonomyLevel,
            basisDataAccessScope: basis.dataAccessScope,
            basisReversibility: basis.reversibility,
            basisProvenance: agent.provenance,
            basisToolCount: basis.toolCount,
            basisModelRef: basis.modelRef,
        });
        if (recorded === 0) throw notFound('Agent risk assessment not found');

        const written = await RegisteredAgentRepository.setRiskTier(
            db,
            ctx,
            agentId,
            result.tier,
            scoredAt,
        );
        // Zero rows means the agent stopped being this tenant's between the read
        // and the write. Refusing loudly beats completing a run whose tier
        // landed nowhere.
        if (written === 0) throw notFound('Registered agent not found');

        await logEvent(db, ctx, {
            action: 'AGENT_RISK_SCORED',
            entityType: 'RegisteredAgent',
            entityId: agentId,
            detailsJson: {
                category: 'custom',
                event: 'agent_risk_scored',
                assessmentId: assessment.id,
                previousTier: agent.riskTier,
                tier: result.tier,
                score: result.score,
                band: result.band,
                floors: [...result.floors],
                basisAutonomyLevel: basis.autonomyLevel,
                basisDataAccessScope: basis.dataAccessScope,
                basisReversibility: basis.reversibility,
                basisToolCount: basis.toolCount,
                // Stated in the trail rather than left to be inferred from the
                // absence of an evidence row: "no artefact was filed" and "an
                // artefact was filed and later deleted" look identical to a
                // reconstruction that only counts rows.
                evidenceEmitted: false,
            },
        });

        // ── SEAM (Agentic 10/10) — EVIDENCE EMISSION. ──────────────────
        // A completed agent risk assessment is an audit artefact: it is the
        // document an assessor asks for when they ask how the tenant bounded an
        // agent's risk. It belongs in the evidence subsystem, attached to the
        // agent, with the score and the basis as its content.
        //
        // The emission point for agentic artefacts is 10/10's to design, so it
        // is not invented here — but it is not silently skipped either. The
        // DESCRIPTOR is built for real on every completion and travels back to
        // the caller and into the audit row beside an explicit `emitted:
        // false`, so nothing downstream can come to believe an artefact was
        // filed when none was. See `agent-assessment-evidence.ts`.
        const evidence = unemittedAgentAssessmentEvidence(
            buildAgentAssessmentEvidence({
                agentId,
                agentName: agent.name,
                assessmentId: assessment.id,
                tier: result.tier,
                score: result.score,
                band: result.band,
                floors: result.floors,
                applicableQuestions: result.breakdown.applicableQuestions,
                unansweredQuestions: result.breakdown.unansweredQuestions,
                basis: {
                    autonomyLevel: basis.autonomyLevel,
                    dataAccessScope: basis.dataAccessScope,
                    reversibility: basis.reversibility,
                    toolCount: basis.toolCount,
                    modelRef: basis.modelRef,
                },
                scoredAt,
            }),
        );

        return {
            assessmentId: assessment.id,
            agentId,
            tier: result.tier,
            score: result.score,
            band: result.band,
            floors: result.floors,
            breakdown: result.breakdown,
            scoredAt,
            evidence,
        };
    });
}

/**
 * Compare a completed run's basis against the live agent.
 *
 * Returns `null` when the run was never scored (no basis to compare against) —
 * which is not "fresh", it is "not applicable", and the caller must not read
 * one as the other.
 */
type StoredBasis = {
    basisAutonomyLevel: number | null;
    basisDataAccessScope: AgentScoringState['dataAccessScope'] | null;
    basisReversibility: AgentScoringState['reversibility'] | null;
    basisProvenance: AgentScoringState['provenance'] | null;
    basisToolCount: number | null;
    basisModelRef: string | null;
};

/**
 * The stored basis as an `AssessmentBasis`, or `null` when the run was never
 * scored. One reader for both the staleness comparison and the re-score, so
 * they can never disagree about what was assessed.
 */
function storedBasis(assessment: StoredBasis): AssessmentBasis | null {
    if (
        assessment.basisAutonomyLevel === null ||
        assessment.basisDataAccessScope === null ||
        assessment.basisReversibility === null ||
        assessment.basisProvenance === null ||
        assessment.basisToolCount === null
    ) {
        return null;
    }
    return {
        autonomyLevel: assessment.basisAutonomyLevel,
        dataAccessScope: assessment.basisDataAccessScope,
        reversibility: assessment.basisReversibility,
        provenance: assessment.basisProvenance,
        toolCount: assessment.basisToolCount,
        modelRef: assessment.basisModelRef,
    };
}

function stalenessFor(
    assessment: StoredBasis,
    agent: AgentScoringState,
): StalenessVerdict | null {
    const basis = storedBasis(assessment);
    if (!basis) return null;
    return evaluateAssessmentStaleness(basis, currentBasis(agent));
}

/**
 * Score one agent from a given set of answers. The single arithmetic seam —
 * `completeAgentRiskAssessment` and the re-score below both go through it, so a
 * widening can never be scored by a second, subtly different copy of the rules.
 */
function scoreAgainst(
    agent: AgentScoringState,
    questions: ReadonlyArray<{ id: string; criticality: string }>,
    answerByQuestion: ReadonlyMap<string, string>,
): AgentRiskScore {
    const scorable: ScorableQuestion[] = questions.map((q) => ({
        id: q.id,
        criticality: q.criticality,
        // Absent means unanswered, which the scorer counts as NO. See the
        // scorer header: an unclaimed mitigation is an absent one.
        answer: (answerByQuestion.get(q.id) as AgentAnswerValue | undefined) ?? null,
    }));
    return scoreAgentRisk({
        autonomyLevel: agent.autonomyLevel,
        dataAccessScope: agent.dataAccessScope,
        reversibility: agent.reversibility,
        provenance: agent.provenance,
        questions: scorable,
    });
}

/** What a re-score did, when it did anything. */
export interface AgentRescoreOutcome {
    from: NonNullable<AgentScoringState['riskTier']>;
    to: NonNullable<AgentScoringState['riskTier']>;
    score: number;
    band: AgentRiskScore['band'];
    floors: string[];
    scoredAt: Date;
    /** The completed run whose ANSWERS were reused. */
    fromAssessmentId: string;
}

/**
 * ── THE TIER FOLLOWS THE AGENT ──────────────────────────────────────
 *
 * Recompute the tier from the standing run's answers against the agent's LIVE
 * axes, and write it back when it comes out worse.
 *
 * ## Why this can be done without a human
 *
 * `scoreAgentRisk` is pure in (autonomy, dataAccessScope, reversibility,
 * provenance, answers). Four of those five are declared fields an operator has
 * just changed; the fifth is on file, unchanged, and re-usable. So the tier for
 * the agent as it now stands is COMPUTABLE — there is nothing to ask anybody.
 * Leaving it to a future questionnaire meant an agent kept a tier that was true
 * of a narrower agent, which is the one thing the tier must never be.
 *
 * ## Three rails, each closing a different way of getting this wrong
 *
 *   1. **It only ever RAISES.** `isTierAbove` gates the write. A widening that
 *      happens to score the same, and any narrowing at all, leaves the standing
 *      tier alone — because the questionnaire behind it has not been re-answered
 *      and an over-restrictive cap is the safe error. This is the same
 *      one-directional rule the staleness triggers and `assertRaiseWithinTier`
 *      already follow.
 *   2. **It never scores an UNSCORED agent.** `riskTier === null` is DENY, and
 *      turning a deny into any tier would GRANT authority nobody assessed. An
 *      agent with no tier is skipped outright; activation is where a score is
 *      demanded.
 *   3. **The AXES decide whether it runs at all.** If the live axes equal the
 *      basis, the answers are the same answers and the arithmetic cannot have
 *      moved, so the whole thing is skipped — which is why a tool grant, whose
 *      trigger touches no axis, costs no extra queries.
 *
 * ## What is deliberately NOT rewritten
 *
 * The standing run's `scoredTier` and `basis*` columns. They are the record of a
 * judgement made at a moment against a state, and a re-score is not a new
 * judgement about the questionnaire — it is the same judgement re-applied to a
 * changed agent. `RegisteredAgent.riskTier` is the operational value and it is
 * what moves; the run stays legible as what a human actually did, and the audit
 * row below names both tiers and the run the answers came from.
 */
async function rescoreAgainstStandingAnswers(
    db: PrismaTx,
    ctx: RequestContext,
    agent: AgentScoringState,
    standing: { id: string } & StoredBasis,
): Promise<AgentRescoreOutcome | null> {
    const before = agent.riskTier;
    // Rail 2 — an unscored agent is a DENY, not a low tier to be raised.
    if (before === null) return null;

    const basis = storedBasis(standing);
    if (!basis) return null;

    // Rail 3 — no axis moved, so the score cannot have.
    const axesUnchanged =
        basis.autonomyLevel === agent.autonomyLevel &&
        basis.dataAccessScope === agent.dataAccessScope &&
        basis.reversibility === agent.reversibility &&
        basis.provenance === agent.provenance;
    if (axesUnchanged) return null;

    const [questions, answers] = await Promise.all([
        AgentRiskAssessmentRepository.listQuestions(db),
        AgentRiskAssessmentRepository.listAnswers(db, ctx, standing.id),
    ]);
    const result = scoreAgainst(
        agent,
        questions,
        new Map(answers.map((a) => [a.questionId, a.answer])),
    );

    // Rail 1 — raises only.
    if (!isTierAbove(result.tier, before)) return null;

    const scoredAt = new Date();
    const written = await RegisteredAgentRepository.setRiskTier(
        db,
        ctx,
        agent.id,
        result.tier,
        scoredAt,
    );
    // Zero rows means the agent stopped being this tenant's between the read and
    // the write. Refusing loudly beats letting a widening land with the old tier
    // still capping it.
    if (written === 0) throw notFound('Registered agent not found');

    await logEvent(db, ctx, {
        action: 'AGENT_RISK_TIER_RAISED',
        entityType: 'RegisteredAgent',
        entityId: agent.id,
        detailsJson: {
            category: 'custom',
            event: 'agent_risk_tier_raised',
            agentId: agent.id,
            previousTier: before,
            tier: result.tier,
            score: result.score,
            band: result.band,
            floors: [...result.floors],
            // The run whose answers were reused, so a reader can see this was a
            // re-application of an existing judgement rather than a new one.
            fromAssessmentId: standing.id,
            basisAutonomyLevel: basis.autonomyLevel,
            basisDataAccessScope: basis.dataAccessScope,
            basisReversibility: basis.reversibility,
            basisProvenance: basis.provenance,
            autonomyLevel: agent.autonomyLevel,
            dataAccessScope: agent.dataAccessScope,
            reversibility: agent.reversibility,
            provenance: agent.provenance,
        },
    });

    return {
        from: before,
        to: result.tier,
        score: result.score,
        band: result.band,
        floors: [...result.floors],
        scoredAt,
        fromAssessmentId: standing.id,
    };
}

/**
 * Reconcile the standing assessment with the agent as it now is: RE-SCORE the
 * tier, then stamp (or clear) staleness.
 *
 * Idempotent and safe to call from anywhere that changes an agent — and it is
 * meant to be called from there, because the alternative is a nightly job that
 * leaves a window in which the register says an assessment is current when it
 * is not, and — worse — a window in which the tier is the tier of a narrower
 * agent than the one that is running.
 *
 * `staleAt` is set ONCE and not moved by a later re-evaluation that finds the
 * same thing: the operator-facing question is "how long has this been stale",
 * and a timestamp that refreshes on every read answers "when did we last look",
 * which is a different and much less useful question.
 */
export async function reassessAgentAfterChange(ctx: RequestContext, agentId: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, (db) => reassessAgentAfterChangeInTx(db, ctx, agentId));
}

/**
 * The same reconciliation, taking an OPEN transaction.
 *
 * Exists because the callers that most need it — the agent amendment and the
 * tool grant — are already inside `runInTenantContext`, and opening a second
 * transaction from inside the first would hold two connections against a
 * transaction-mode pooler for the length of the outer one. It also means the
 * re-scored tier and the staleness stamp commit or roll back WITH the change
 * that caused them: an amendment that fails must not leave behind either a
 * narrowed tier or a note saying the assessment is stale because of it.
 *
 * Authorization is the CALLER's: every call site is already past
 * `assertCanWrite`, and re-asserting here would be a second check on the same
 * context that can only ever agree with the first.
 */
export async function reassessAgentAfterChangeInTx(
    db: PrismaTx,
    ctx: RequestContext,
    agentId: string,
) {
    const agent = await loadAgentScoringState(db, ctx, agentId);
    const standing = await AgentRiskAssessmentRepository.findLatestCompleted(db, ctx, agentId);
    if (!standing) {
        return { assessmentId: null, stale: false, triggers: [] as string[], rescored: null };
    }

    const verdict = stalenessFor(standing, agent);
    if (!verdict) {
        return {
            assessmentId: standing.id,
            stale: false,
            triggers: [] as string[],
            rescored: null,
        };
    }

    // The re-score runs FIRST, so the tier is already correct by the time the
    // staleness row is written and by the time this transaction commits. The
    // verdict above is computed from the agent's axes, which the re-score does
    // not touch, so the order changes nothing about what is reported.
    const rescored = await rescoreAgainstStandingAnswers(db, ctx, agent, standing);

    const alreadyStale = standing.staleAt !== null;
    const staleAt = verdict.stale ? (standing.staleAt ?? new Date()) : null;

    await AgentRiskAssessmentRepository.setStaleness(db, ctx, standing.id, {
        staleAt,
        triggers: verdict.triggers,
    });

    // Audited only on a TRANSITION into staleness. Every call that finds the
    // same standing staleness would otherwise write a row, and a trail
    // where the same fact repeats a thousand times is a trail nobody reads.
    if (verdict.stale && !alreadyStale) {
        await logEvent(db, ctx, {
            action: 'AGENT_ASSESSMENT_STALE',
            entityType: 'AgentRiskAssessment',
            entityId: standing.id,
            detailsJson: {
                category: 'custom',
                event: 'agent_assessment_stale',
                agentId,
                triggers: verdict.triggers,
                // `triggerDetail`, not `detail`: the canonical audit
                // details schema reserves `detail` for a single free-form
                // STRING, and handing it an array is a 400 at the write
                // rather than a truncated field.
                triggerDetail: verdict.detail,
                // The tier IN FORCE at the end of this transaction — the
                // re-scored one when an axis moved, the standing one otherwise.
                // Never `standing.scoredTier` unqualified: after a re-score that
                // is the tier of a narrower agent, and reporting it here would
                // put the exact claim this change was made to retire into the
                // audit trail.
                standingTier: rescored?.to ?? standing.scoredTier,
                rescoredFrom: rescored?.from ?? null,
            },
        });
    }

    return {
        assessmentId: standing.id,
        stale: verdict.stale,
        triggers: verdict.triggers,
        detail: verdict.detail,
        staleAt,
        /**
         * Non-null when the change re-scored the agent upward. The caller
         * surfaces it so an operator sees the narrowing at the moment they made
         * the change, rather than discovering it as a refused tool call.
         */
        rescored,
    };
}

/** Every run against one agent, newest first — the assessment history. */
export async function listAgentRiskAssessments(ctx: RequestContext, agentId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        await loadAgentScoringState(db, ctx, agentId);
        return AgentRiskAssessmentRepository.listForAgent(db, ctx, agentId);
    });
}
