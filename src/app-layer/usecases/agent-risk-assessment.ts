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
 *     WARNS; it does not deny. See `agent-assessment-staleness.ts` for the
 *     argument, the short form of which is that the widening which made the
 *     assessment stale is itself inert until somebody re-scores, so the agent
 *     keeps exactly the authority its last real assessment justified.
 *
 * Collapsing the last two into the first is the tempting mistake. It would take
 * an agent dark the instant an operator did the correct, audited thing.
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
    scoreAgentRisk,
    type AgentAnswerValue,
    type ScorableQuestion,
} from '@/lib/agentic/agent-risk-scoring';
import {
    evaluateAssessmentStaleness,
    type AssessmentBasis,
    type StalenessVerdict,
} from '@/lib/agentic/agent-assessment-staleness';
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
            /** The completed run whose tier is in force, and its freshness. */
            standing: latestCompleted
                ? {
                      assessmentId: latestCompleted.id,
                      tier: latestCompleted.scoredTier,
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

        const answerByQuestion = new Map(answers.map((a) => [a.questionId, a.answer]));
        const scorable: ScorableQuestion[] = questions.map((q) => ({
            id: q.id,
            criticality: q.criticality,
            // Absent means unanswered, which the scorer counts as NO. See the
            // scorer header: an unclaimed mitigation is an absent one.
            answer: (answerByQuestion.get(q.id) as AgentAnswerValue | undefined) ?? null,
        }));

        const result = scoreAgentRisk({
            autonomyLevel: agent.autonomyLevel,
            dataAccessScope: agent.dataAccessScope,
            reversibility: agent.reversibility,
            provenance: agent.provenance,
            questions: scorable,
        });

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
            },
        });

        // ── SEAM (Agentic 10/10) — EVIDENCE EMISSION. ──────────────────
        // A completed agent risk assessment is an audit artefact: it is the
        // document an assessor asks for when they ask how the tenant bounded
        // an agent's risk. It belongs in the evidence subsystem, attached to
        // the agent, with the score and the basis as its content.
        //
        // NOT wired here, and deliberately not silently skipped: the evidence
        // emission point for agentic artefacts is 10/10's, and inventing one
        // now would mean 10/10 either adopts a shape it did not choose or
        // migrates rows that already exist. The audit row above is the durable
        // record in the meantime — it is hash-chained, it carries the tier, the
        // score and the basis, and it is what a reconstruction would read.
        // 10/10 replaces this comment with the emission call; the assessment
        // row already holds everything such a call needs.

        return {
            assessmentId: assessment.id,
            agentId,
            tier: result.tier,
            score: result.score,
            band: result.band,
            floors: result.floors,
            breakdown: result.breakdown,
            scoredAt,
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
function stalenessFor(
    assessment: {
        basisAutonomyLevel: number | null;
        basisDataAccessScope: AgentScoringState['dataAccessScope'] | null;
        basisReversibility: AgentScoringState['reversibility'] | null;
        basisToolCount: number | null;
        basisModelRef: string | null;
    },
    agent: AgentScoringState,
): StalenessVerdict | null {
    if (
        assessment.basisAutonomyLevel === null ||
        assessment.basisDataAccessScope === null ||
        assessment.basisReversibility === null ||
        assessment.basisToolCount === null
    ) {
        return null;
    }
    return evaluateAssessmentStaleness(
        {
            autonomyLevel: assessment.basisAutonomyLevel,
            dataAccessScope: assessment.basisDataAccessScope,
            reversibility: assessment.basisReversibility,
            toolCount: assessment.basisToolCount,
            modelRef: assessment.basisModelRef,
        },
        currentBasis(agent),
    );
}

/**
 * Re-evaluate the standing assessment's freshness and persist the verdict.
 *
 * Idempotent and safe to call from anywhere that widens an agent — and it is
 * meant to be called from there, because the alternative is a nightly job that
 * leaves a window in which the register says an assessment is current when it
 * is not.
 *
 * `staleAt` is set ONCE and not moved by a later re-evaluation that finds the
 * same thing: the operator-facing question is "how long has this been stale",
 * and a timestamp that refreshes on every read answers "when did we last look",
 * which is a different and much less useful question.
 */
export async function refreshAgentAssessmentStaleness(ctx: RequestContext, agentId: string) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const agent = await loadAgentScoringState(db, ctx, agentId);
        const standing = await AgentRiskAssessmentRepository.findLatestCompleted(db, ctx, agentId);
        if (!standing) return { assessmentId: null, stale: false, triggers: [] as string[] };

        const verdict = stalenessFor(standing, agent);
        if (!verdict) return { assessmentId: standing.id, stale: false, triggers: [] as string[] };

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
                    // The tier that REMAINS in force. Stale warns; it does not
                    // deny, and the widening that made it stale is inert until
                    // somebody re-scores.
                    standingTier: standing.scoredTier,
                },
            });
        }

        return {
            assessmentId: standing.id,
            stale: verdict.stale,
            triggers: verdict.triggers,
            detail: verdict.detail,
            staleAt,
        };
    });
}

/** Every run against one agent, newest first — the assessment history. */
export async function listAgentRiskAssessments(ctx: RequestContext, agentId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        await loadAgentScoringState(db, ctx, agentId);
        return AgentRiskAssessmentRepository.listForAgent(db, ctx, agentId);
    });
}
