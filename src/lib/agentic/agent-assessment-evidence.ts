/**
 * ── SEAM (Agentic 10/10) — the completed assessment as an EVIDENCE artefact.
 *
 * A completed agent risk assessment is the document an assessor asks for when
 * they ask how a tenant bounded an agent's risk: it names the agent, the tier,
 * the score behind the tier, and the state of the world the tier was true of.
 * That belongs in the evidence subsystem, attached to the agent, on the same
 * retention and review rails as every other audit artefact.
 *
 * ## Why the emission is not wired here
 *
 * The evidence emission point for AGENTIC artefacts is 10/10's to design.
 * Inventing one now would mean 10/10 either adopts a shape it did not choose or
 * migrates rows that already exist — and rows written under a guessed shape are
 * the expensive kind of guess, because they outlive the guess.
 *
 * ## Why it is not silently skipped either
 *
 * The failure this file exists to prevent is the product implying an artefact
 * exists when none does. So the DESCRIPTOR — everything an emission call would
 * need — is built for real, on every completion, and travels in the usecase's
 * return value and its audit row alongside an explicit `emitted: false`. A
 * caller reading the outcome can tell "there is an evidence record" from "there
 * is not, and here is why" without knowing anything about 10/10.
 *
 * Fails CLOSED in the only direction available to it: `emitted` is a literal
 * `false` that no code path can set to `true`, so nothing downstream can come
 * to believe an artefact was filed. When 10/10 lands, it replaces
 * `UNEMITTED_AGENT_ASSESSMENT_EVIDENCE` at the single call site in
 * `completeAgentRiskAssessment` with a real emission whose outcome carries the
 * evidence id.
 *
 * Wired by: 10/10.
 */
import type { AgentRiskTier } from '@prisma/client';

/** Everything an evidence record for one completed assessment would carry. */
export interface AgentAssessmentEvidenceDescriptor {
    agentId: string;
    agentName: string;
    assessmentId: string;
    tier: AgentRiskTier;
    score: number;
    /** The tier the additive score alone produced, before any axis floor. */
    band: AgentRiskTier;
    /** Which per-axis floors raised the tier above the band, if any. */
    floors: readonly string[];
    /** How much of the questionnaire was actually answered. */
    answeredQuestions: number;
    applicableQuestions: number;
    /** The agent state the score was true of — the basis, frozen. */
    basis: {
        autonomyLevel: number;
        dataAccessScope: string;
        reversibility: string;
        toolCount: number;
        modelRef: string | null;
    };
    scoredAt: Date;
    /** A one-line human title, so the artefact is legible in a list. */
    title: string;
}

export interface AgentAssessmentEvidenceOutcome {
    /**
     * Whether an evidence record was actually filed. Always `false` until 10/10
     * wires the emission — a literal type, so a caller cannot narrow it wrongly
     * and no branch can assume the artefact exists.
     */
    emitted: false;
    /** Why not, as a stable code an operator or a test can assert on. */
    reason: 'evidence_emission_unwired';
    descriptor: AgentAssessmentEvidenceDescriptor;
}

export interface AgentAssessmentEvidenceInput {
    agentId: string;
    agentName: string;
    assessmentId: string;
    tier: AgentRiskTier;
    score: number;
    band: AgentRiskTier;
    floors: readonly string[];
    applicableQuestions: number;
    unansweredQuestions: number;
    basis: AgentAssessmentEvidenceDescriptor['basis'];
    scoredAt: Date;
}

/**
 * Build the descriptor. Pure, and deliberately built even though nothing
 * consumes it: it is the part of the seam that can be WRONG, so it is the part
 * that is tested. A seam whose payload is only assembled on the day it is wired
 * is a seam that has never been checked.
 */
export function buildAgentAssessmentEvidence(
    input: AgentAssessmentEvidenceInput,
): AgentAssessmentEvidenceDescriptor {
    const answered = Math.max(0, input.applicableQuestions - input.unansweredQuestions);
    return {
        agentId: input.agentId,
        agentName: input.agentName,
        assessmentId: input.assessmentId,
        tier: input.tier,
        score: input.score,
        band: input.band,
        floors: [...input.floors],
        answeredQuestions: answered,
        applicableQuestions: input.applicableQuestions,
        basis: { ...input.basis },
        scoredAt: input.scoredAt,
        // The count is in the title on purpose: a run scored with nothing
        // answered is a legitimate artefact (it is the strictest tier that
        // agent can hold) but it is not the same artefact as a completed
        // questionnaire, and a list that renders them identically hides that.
        title:
            `Agent risk assessment — ${input.agentName}: ${input.tier} ` +
            `(${answered}/${input.applicableQuestions} answered)`,
    };
}

/**
 * The outcome the completion usecase reports while the emission is unwired.
 * Named rather than spelled inline so the seam is greppable and so deleting it
 * is a compile error rather than a silent no-op.
 */
export function unemittedAgentAssessmentEvidence(
    descriptor: AgentAssessmentEvidenceDescriptor,
): AgentAssessmentEvidenceOutcome {
    return { emitted: false, reason: 'evidence_emission_unwired', descriptor };
}
