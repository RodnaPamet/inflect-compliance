/**
 * The assistant's env kill switch (#3842).
 *
 * ═══ WHY THIS IS A UNIT TEST AND NOT A RENDERED ONE ═══
 *
 * The gate used to be a prop on `AppShell`, and the rendered test asserted on
 * that prop. The mount moved to the tenant layout — `AppShell.tsx` is inside a
 * SHARED_UI_ROOT and importing the assistant into it added a `domain-import`
 * edge that `tests/guards/shared-ui-coupling-ratchet` counts by population.
 *
 * The layout is a server component, so there is no sensible way to render its
 * conditional. What can regress is the predicate it calls, which is this
 * function — so the test follows the gate rather than the markup it used to
 * live behind.
 */

const ENV_BASE = {
    AI_RISK_ENABLED: 'true',
    AI_RISK_SUGGESTIONS_ENABLED: 'true',
    AI_QUESTIONNAIRE_ENABLED: 'true',
    AI_RISK_PLAN_REQUIRED: '',
};

/** Load the gate fresh with one env value for the assistant flag. */
function loadGate(assistantFlag: string | undefined) {
    jest.resetModules();
    jest.doMock('@/env', () => ({
        env: { ...ENV_BASE, AI_ASSISTANT_ENABLED: assistantFlag },
    }));
    // Required inside the isolated module registry, so the module under test
    // binds to the mocked env rather than the real one.

    return require('@/app-layer/ai/risk-assessment/feature-gate') as typeof import('@/app-layer/ai/risk-assessment/feature-gate');
}

afterEach(() => {
    jest.resetModules();
});

describe('isAiFeatureEnabled follows the env flag', () => {
    it('is on when the flag is unset — the feature ships enabled', () => {
        // The schema's own default is 'true', so an operator who has never
        // heard of this variable gets the assistant.
        expect(loadGate(undefined).isAiFeatureEnabled('assistant')).toBe(true);
    });

    it("is off for 'false', which is what the kill switch sets", () => {
        expect(loadGate('false').isAiFeatureEnabled('assistant')).toBe(false);
    });

    it("is off for 'FALSE' too — the comparison is case-insensitive", () => {
        // `isOn` lowercases before comparing. An operator who types FALSE in a
        // deployment config means it, and a case-sensitive check would leave
        // the feature running after they thought they had stopped it.
        expect(loadGate('FALSE').isAiFeatureEnabled('assistant')).toBe(false);
    });

    it('is on for any other value, rather than failing closed on a typo', () => {
        // Deliberate and worth stating: only the exact word turns it off. A
        // mistyped 'flase' leaves the feature ON, which is the right direction
        // for a flag whose off-state removes a surface users can see — the
        // alternative silently withdraws a feature nobody asked to withdraw.
        expect(loadGate('true').isAiFeatureEnabled('assistant')).toBe(true);
        expect(loadGate('flase').isAiFeatureEnabled('assistant')).toBe(true);
    });

    it('gates the assistant INDEPENDENTLY of the other AI features', () => {
        // The reason the per-feature map exists: an operator must be able to
        // stop the assistant while leaving risk suggestions running. A single
        // AI_ENABLED switch would make that impossible.
        const gate = loadGate('false');
        expect(gate.isAiFeatureEnabled('assistant')).toBe(false);
        expect(gate.isAiFeatureEnabled('risk')).toBe(true);
        expect(gate.isAiFeatureEnabled('questionnaire')).toBe(true);
    });
});
