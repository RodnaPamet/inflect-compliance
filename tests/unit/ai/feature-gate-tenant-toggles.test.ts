/**
 * The per-tenant half of the AI gate.
 *
 *     effective = env_global AND env_feature AND tenant_master AND tenant_feature
 *
 * Four properties, in order of what they cost if wrong:
 *
 *   1. FAIL CLOSED. An unreadable settings row refuses. A tenant that turned AI
 *      off may have done so contractually, and running a model for them because
 *      a row was briefly unreadable is a breach that cannot be undone.
 *   2. The env still wins. A tenant row cannot re-enable what the deploy forbids
 *      — otherwise the kill switch is not one.
 *   3. NO DATABASE READ when the env already refused. The gate runs on every AI
 *      request; paying a round trip to confirm a `false` constant is waste, and
 *      asserting it is the only way that stays true.
 *   4. `enforceFeatureGate` and `checkFeatureGateWithPlan` agree. They are two
 *      entry points to one decision, and a predicate added to one and not the
 *      other is the shape of #3909 — a surface allowed by one path and refused
 *      by another.
 */
import type { RequestContext } from '@/app-layer/types';

const findUnique = jest.fn();

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique } }),
}));

// requireActual-spread, NOT a bare object: `isolateModules` re-requires the
// whole graph below the gate, and several of those modules import other names
// from this barrel. Replacing only `warn` keeps them working.
jest.mock('@/lib/observability/logger', () => {
    const actual = jest.requireActual('@/lib/observability/logger');
    return { ...actual, logger: { ...actual.logger, warn: jest.fn() } };
});

const baseCtx = {
    userId: 'u1',
    tenantId: 't1',
    requestId: 'r1',
    role: 'ADMIN',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
} as unknown as RequestContext;

/** Load a fresh gate under an env snapshot — the flags are module constants. */
function loadGate(envOverrides: Record<string, string | undefined>) {
    // `!` rather than `= null as any`: the sibling suite uses the cast and the
    // `any` ratchet counts it. A definite-assignment assertion says the same
    // thing — `isolateModules` runs its callback synchronously, so `mod` is
    // assigned before the return — without spending a cap.
    let mod!: typeof import('@/app-layer/ai/risk-assessment/feature-gate');
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(envOverrides)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    jest.isolateModules(() => {
        mod = require('@/app-layer/ai/risk-assessment/feature-gate');
    });
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return mod;
}

const ALL_ENV_ON = {
    AI_RISK_ENABLED: 'true',
    AI_RISK_SUGGESTIONS_ENABLED: 'true',
    AI_ASSISTANT_ENABLED: 'true',
    AI_QUESTIONNAIRE_ENABLED: 'true',
};

beforeEach(() => {
    findUnique.mockReset();
});

describe('the tenant toggle is ANDed into the gate', () => {
    it('allows when the tenant row says on', async () => {
        findUnique.mockResolvedValue({ aiEnabled: true, aiAssistantEnabled: true });
        const gate = loadGate(ALL_ENV_ON);
        await expect(gate.checkFeatureGateWithPlan(baseCtx, 'assistant')).resolves.toEqual({
            allowed: true,
        });
    });

    it('allows when there is NO settings row at all', async () => {
        // An absent row means "never configured", and all four columns default
        // to true. Reading absence as OFF would disable AI for exactly the
        // tenants nobody has looked at — the opposite choice from
        // `processCanvasEnabled`, and deliberately so: that is an opt-in module,
        // this is an opt-out setting.
        findUnique.mockResolvedValue(null);
        const gate = loadGate(ALL_ENV_ON);
        await expect(gate.checkFeatureGateWithPlan(baseCtx, 'risk')).resolves.toEqual({
            allowed: true,
        });
    });

    it('refuses the one feature the tenant turned off, naming it', async () => {
        findUnique.mockResolvedValue({ aiEnabled: true, aiAssistantEnabled: false });
        const gate = loadGate(ALL_ENV_ON);
        const result = await gate.checkFeatureGateWithPlan(baseCtx, 'assistant');
        expect(result.allowed).toBe(false);
        // Names the FEATURE, not just "unavailable": the reader has to know
        // which switch to look at.
        expect(result.reason).toContain('assistant');
        expect(result.reason).toContain('workspace');
    });

    it('refuses EVERY feature when the tenant master switch is off', async () => {
        const gate = loadGate(ALL_ENV_ON);
        for (const feature of ['risk', 'assistant', 'questionnaire'] as const) {
            // The per-feature column stays TRUE in each case, so a gate that
            // only read its own column would allow all three.
            findUnique.mockResolvedValue({
                aiEnabled: false,
                aiRiskSuggestionsEnabled: true,
                aiAssistantEnabled: true,
                aiQuestionnaireEnabled: true,
            });
            const result = await gate.checkFeatureGateWithPlan(baseCtx, feature);
            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('AI features are turned off for this workspace');
        }
    });

    it('REFUSES when the settings read throws — fail closed', async () => {
        findUnique.mockRejectedValue(new Error('connection terminated'));
        const gate = loadGate(ALL_ENV_ON);
        const result = await gate.checkFeatureGateWithPlan(baseCtx, 'assistant');
        expect(result.allowed).toBe(false);
        // The reason says the availability is UNKNOWN rather than claiming the
        // tenant turned it off: a reader chasing this must not be sent to a
        // settings page that shows the feature on.
        expect(result.reason).toContain('could not be confirmed');
    });

    it('does NOT read the database when the env already refused', async () => {
        const gate = loadGate({ ...ALL_ENV_ON, AI_ASSISTANT_ENABLED: 'false' });
        const result = await gate.checkFeatureGateWithPlan(baseCtx, 'assistant');
        expect(result.allowed).toBe(false);
        expect(findUnique).not.toHaveBeenCalled();
    });

    it('a tenant row of ON cannot re-enable what the env forbids', async () => {
        // The kill-switch property. If this ever allows, an operator has no way
        // to stop AI without a deploy.
        findUnique.mockResolvedValue({ aiEnabled: true, aiAssistantEnabled: true });
        const gate = loadGate({ ...ALL_ENV_ON, AI_RISK_ENABLED: 'false' });
        await expect(
            gate.checkFeatureGateWithPlan(baseCtx, 'assistant'),
        ).resolves.toMatchObject({ allowed: false });
    });
});

describe('enforceFeatureGate shares the predicate', () => {
    it('throws when the tenant toggle refuses', async () => {
        // Driven through `enforceFeatureGate`, NOT `checkFeatureGateWithPlan`:
        // the two are separate entry points and this is the one the routes
        // call. A predicate wired into only the other would leave every route
        // ungated while the tests above stayed green.
        findUnique.mockResolvedValue({ aiEnabled: true, aiQuestionnaireEnabled: false });
        const gate = loadGate(ALL_ENV_ON);
        await expect(gate.enforceFeatureGate(baseCtx, 'questionnaire')).rejects.toThrow(
            /questionnaire/i,
        );
    });

    it('resolves when the tenant toggle allows', async () => {
        findUnique.mockResolvedValue({ aiEnabled: true, aiQuestionnaireEnabled: true });
        const gate = loadGate(ALL_ENV_ON);
        await expect(gate.enforceFeatureGate(baseCtx, 'questionnaire')).resolves.toBeUndefined();
    });

    it('throws on an unreadable row, like the check path', async () => {
        findUnique.mockRejectedValue(new Error('connection terminated'));
        const gate = loadGate(ALL_ENV_ON);
        await expect(gate.enforceFeatureGate(baseCtx, 'risk')).rejects.toThrow(
            /could not be confirmed/,
        );
    });
});
