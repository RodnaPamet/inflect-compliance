/**
 * Assessment staleness — each trigger fires, and an unrelated edit does not.
 *
 * The second half is the one that matters in practice. A staleness detector
 * that fires on everything is indistinguishable, from inside the product, from
 * one that fires on nothing: both mean the flag carries no information, and the
 * operator learns to ignore it. So every trigger is asserted to fire ALONE (no
 * companion trigger rides along) and a battery of risk-NEUTRAL and
 * risk-REDUCING edits is asserted to produce an empty verdict.
 *
 * The one-directional design is asserted directly rather than described: an
 * agent whose autonomy is LOWERED, whose scope is NARROWED, whose reversibility
 * IMPROVES, or which has a tool REVOKED is not stale, because the tier still in
 * force was scored against a wider state and an over-restrictive cap is a safe
 * error.
 */
import {
    STALENESS_TRIGGERS,
    evaluateAssessmentStaleness,
    type AssessmentBasis,
} from '@/lib/agentic/agent-assessment-staleness';

/** The state a completed assessment froze. Deliberately mid-ladder on every
 *  axis so an edit can move in either direction from here. */
const BASIS: AssessmentBasis = {
    autonomyLevel: 3,
    dataAccessScope: 'READ_TENANT_DATA',
    reversibility: 'COMPENSABLE',
    toolCount: 2,
    modelRef: 'model-a',
};

const unchanged = () => ({ ...BASIS });

describe('each trigger fires on its own change', () => {
    it('AUTONOMY_RAISED', () => {
        const v = evaluateAssessmentStaleness(BASIS, { ...unchanged(), autonomyLevel: 5 });
        expect(v.stale).toBe(true);
        expect(v.triggers).toEqual(['AUTONOMY_RAISED']);
        expect(v.detail).toEqual(['autonomyLevel 3 → 5']);
    });

    it('TOOL_GRANTED', () => {
        const v = evaluateAssessmentStaleness(BASIS, { ...unchanged(), toolCount: 3 });
        expect(v.stale).toBe(true);
        expect(v.triggers).toEqual(['TOOL_GRANTED']);
        expect(v.detail).toEqual(['granted tools 2 → 3']);
    });

    it('DATA_SCOPE_WIDENED', () => {
        const v = evaluateAssessmentStaleness(BASIS, {
            ...unchanged(),
            dataAccessScope: 'WRITE_TENANT_DATA',
        });
        expect(v.stale).toBe(true);
        expect(v.triggers).toEqual(['DATA_SCOPE_WIDENED']);
    });

    it('MODEL_CHANGED', () => {
        const v = evaluateAssessmentStaleness(BASIS, { ...unchanged(), modelRef: 'model-b' });
        expect(v.stale).toBe(true);
        expect(v.triggers).toEqual(['MODEL_CHANGED']);
    });

    /**
     * The fifth trigger, beyond the four the brief names. Reversibility is a
     * scorer input carrying the strongest floor in the table, so leaving it out
     * would make it the one axis you could worsen without re-assessing.
     */
    it('REVERSIBILITY_WORSENED', () => {
        const v = evaluateAssessmentStaleness(BASIS, { ...unchanged(), reversibility: 'TERMINAL' });
        expect(v.stale).toBe(true);
        expect(v.triggers).toEqual(['REVERSIBILITY_WORSENED']);
    });

    it('every declared trigger code is reachable — none is decoration', () => {
        const seen = new Set<string>();
        for (const current of [
            { ...unchanged(), autonomyLevel: 6 },
            { ...unchanged(), toolCount: 9 },
            { ...unchanged(), dataAccessScope: 'EXTERNAL_EGRESS' as const },
            { ...unchanged(), reversibility: 'TERMINAL' as const },
            { ...unchanged(), modelRef: 'model-z' },
        ]) {
            for (const t of evaluateAssessmentStaleness(BASIS, current).triggers) seen.add(t);
        }
        expect([...seen].sort()).toEqual([...STALENESS_TRIGGERS].sort());
    });
});

describe('an unrelated edit does NOT mark the assessment stale', () => {
    it('nothing changed at all', () => {
        const v = evaluateAssessmentStaleness(BASIS, unchanged());
        expect(v.stale).toBe(false);
        expect(v.triggers).toEqual([]);
        expect(v.detail).toEqual([]);
    });

    /**
     * The risk-REDUCING direction on every axis. The stored tier was scored
     * against a WIDER state, so it is merely too high — an over-restrictive cap
     * is a safe error, and re-assessment is optional rather than owed.
     */
    it.each([
        ['autonomy lowered', { autonomyLevel: 1 }],
        ['a tool revoked', { toolCount: 1 }],
        ['every tool revoked', { toolCount: 0 }],
        ['data scope narrowed', { dataAccessScope: 'READ_METADATA' as const }],
        ['data scope narrowed to NONE', { dataAccessScope: 'NONE' as const }],
        ['reversibility improved', { reversibility: 'REVERSIBLE' as const }],
    ])('%s is not stale', (_label, patch) => {
        const v = evaluateAssessmentStaleness(BASIS, { ...unchanged(), ...patch });
        expect(v.stale).toBe(false);
        expect(v.triggers).toEqual([]);
    });

    /**
     * Fields that are not scorer inputs cannot reach this function at all —
     * `AssessmentBasis` has no name, owner, description or vendor. That is the
     * structural version of "an unrelated edit does not mark stale": renaming
     * an agent is not something the comparison could notice even if it wanted
     * to. Asserted on the TYPE's own key set so widening the basis without
     * thinking about staleness is a failing test rather than a silent new
     * trigger.
     */
    it('the basis carries only the scorer inputs, so unrelated fields cannot trigger it', () => {
        expect(Object.keys(BASIS).sort()).toEqual([
            'autonomyLevel',
            'dataAccessScope',
            'modelRef',
            'reversibility',
            'toolCount',
        ]);
    });
});

describe('the model reference, where NULL is a real state', () => {
    const noModel: AssessmentBasis = { ...BASIS, modelRef: null };

    it('never declared, still not declared, is NOT a change', () => {
        const v = evaluateAssessmentStaleness(noModel, { ...noModel });
        expect(v.stale).toBe(false);
    });

    it('declaring a model for the first time IS a change', () => {
        const v = evaluateAssessmentStaleness(noModel, { ...noModel, modelRef: 'model-a' });
        expect(v.triggers).toEqual(['MODEL_CHANGED']);
        expect(v.detail).toEqual(['modelRef (none) → model-a']);
    });

    it('withdrawing a declared model IS a change — there is no safer model', () => {
        const v = evaluateAssessmentStaleness(BASIS, { ...unchanged(), modelRef: null });
        expect(v.triggers).toEqual(['MODEL_CHANGED']);
    });
});

describe('several changes at once are all reported', () => {
    it('names every trigger that fired, not just the first', () => {
        const v = evaluateAssessmentStaleness(BASIS, {
            autonomyLevel: 6,
            dataAccessScope: 'EXTERNAL_EGRESS',
            reversibility: 'TERMINAL',
            toolCount: 7,
            modelRef: 'model-b',
        });
        expect(v.stale).toBe(true);
        expect([...v.triggers].sort()).toEqual([...STALENESS_TRIGGERS].sort());
        expect(v.detail).toHaveLength(STALENESS_TRIGGERS.length);
    });
});
