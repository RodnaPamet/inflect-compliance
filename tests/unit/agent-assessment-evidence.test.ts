/**
 * The evidence descriptor — the 10/10 seam's payload, checked before it ships.
 *
 * The emission point for agentic artefacts belongs to 10/10, so nothing here
 * writes an evidence row. What IS built on every completion is the descriptor,
 * and it is the part of the seam that can be WRONG: a payload only assembled on
 * the day it is wired is a payload nobody has ever looked at.
 *
 * Two properties carry the weight:
 *
 *   • `emitted` is a literal `false` no code path can set. A seam that reported
 *     an artefact filed when none was would be worse than a silent skip,
 *     because a reconstruction counting evidence rows would then be reading a
 *     claim rather than a record.
 *   • The title distinguishes a PROVISIONAL run — one scored with nothing
 *     answered, which the backfill produces and which is a legitimate artefact
 *     — from a completed questionnaire. A list that renders them identically
 *     hides the difference between "we assessed this" and "we defaulted it".
 */
import {
    buildAgentAssessmentEvidence,
    unemittedAgentAssessmentEvidence,
} from '@/lib/agentic/agent-assessment-evidence';

const BASIS = {
    autonomyLevel: 3,
    dataAccessScope: 'READ_TENANT_DATA',
    reversibility: 'COMPENSABLE',
    toolCount: 2,
    modelRef: null,
} as const;

const SCORED_AT = new Date('2026-09-05T09:00:00.000Z');

function build(overrides: Partial<Parameters<typeof buildAgentAssessmentEvidence>[0]> = {}) {
    return buildAgentAssessmentEvidence({
        agentId: 'agent-1',
        agentName: 'Nightly triage',
        assessmentId: 'assess-1',
        tier: 'MODERATE',
        score: 19,
        band: 'HIGH',
        floors: ['reversibility=TERMINAL floors at MODERATE'],
        applicableQuestions: 20,
        unansweredQuestions: 4,
        basis: { ...BASIS },
        scoredAt: SCORED_AT,
        ...overrides,
    });
}

describe('the descriptor carries what an assessor would ask for', () => {
    it('names the agent, the run, the tier and the score it came from', () => {
        expect(build()).toMatchObject({
            agentId: 'agent-1',
            agentName: 'Nightly triage',
            assessmentId: 'assess-1',
            tier: 'MODERATE',
            score: 19,
            band: 'HIGH',
            scoredAt: SCORED_AT,
        });
    });

    it('carries the BASIS, so the tier is legible against the state it judged', () => {
        // A tier without its basis is an opinion with no subject. This is the
        // same reason the assessment row freezes these columns.
        expect(build().basis).toEqual(BASIS);
    });

    it('answers = applicable − unanswered, and never goes negative', () => {
        expect(build().answeredQuestions).toBe(16);
        // Unrepresentable through the usecase, but the arithmetic must not
        // produce a negative count if the two ever disagree.
        expect(build({ applicableQuestions: 0, unansweredQuestions: 4 }).answeredQuestions).toBe(0);
    });

    it('copies the floors rather than aliasing the caller array', () => {
        // The descriptor outlives the score object it was built from, and a
        // shared array would let a later mutation rewrite a filed artefact.
        const floors = ['a'];
        const built = buildAgentAssessmentEvidence({
            agentId: 'a',
            agentName: 'n',
            assessmentId: 'x',
            tier: 'LOW',
            score: 1,
            band: 'LOW',
            floors,
            applicableQuestions: 1,
            unansweredQuestions: 0,
            basis: { ...BASIS },
            scoredAt: SCORED_AT,
        });
        floors.push('b');
        expect(built.floors).toEqual(['a']);
    });
});

describe('the title distinguishes a provisional run from a real one', () => {
    it('says how much of the questionnaire was actually answered', () => {
        expect(build().title).toBe('Agent risk assessment — Nightly triage: MODERATE (16/20 answered)');
    });

    it('a run with NOTHING answered is legible as such', () => {
        // What the backfill produces: a real artefact, and the strictest tier
        // the agent can hold — but not the same artefact as a filled-in
        // questionnaire, and the list must not render them identically.
        expect(build({ unansweredQuestions: 20 }).title).toContain('(0/20 answered)');
    });
});

describe('the unemitted outcome cannot claim an artefact exists', () => {
    it('reports emitted:false with a stable reason and the descriptor intact', () => {
        const outcome = unemittedAgentAssessmentEvidence(build());
        expect(outcome.emitted).toBe(false);
        expect(outcome.reason).toBe('evidence_emission_unwired');
        expect(outcome.descriptor.assessmentId).toBe('assess-1');
    });

    it('the flag is the literal false, so no branch can narrow it to true', () => {
        // Belt and braces on a type-level claim: `emitted: false` is a literal
        // type, and this is the runtime half of it. 10/10 replaces the whole
        // outcome rather than flipping this field.
        const outcome: { emitted: false } = unemittedAgentAssessmentEvidence(build());
        expect(outcome.emitted).not.toBe(true);
    });
});
