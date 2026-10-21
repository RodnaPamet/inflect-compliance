/**
 * GAP-2 — per-feature AI enable flags.
 *
 * Each AI feature (risk / assistant / questionnaire) carries an
 * independent enable flag that is ANDed with the global
 * `AI_RISK_ENABLED` master switch. This proves an operator can disable
 * ONE feature in isolation, and that the global switch still kills ALL.
 *
 * The flags are read at module load, so each case sets env then
 * re-imports the gate module via `jest.isolateModules`.
 */
import type { RequestContext } from '@/app-layer/types';

const baseCtx = {
    userId: 'u1',
    tenantId: 't1',
    role: 'ADMIN',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
} as unknown as RequestContext;

/** Load a fresh copy of the gate module under a specific env snapshot. */
function loadGate(envOverrides: Record<string, string | undefined>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: typeof import('@/app-layer/ai/risk-assessment/feature-gate') = null as any;
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(envOverrides)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    jest.isolateModules(() => {
        mod = require('@/app-layer/ai/risk-assessment/feature-gate');
    });
    // restore
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return mod;
}

describe('GAP-2 — per-feature AI enable flags', () => {
    it('all features allowed when every flag defaults on', () => {
        const gate = loadGate({
            AI_RISK_ENABLED: undefined,
            AI_RISK_SUGGESTIONS_ENABLED: undefined,
            AI_ASSISTANT_ENABLED: undefined,
            AI_QUESTIONNAIRE_ENABLED: undefined,
        });
        expect(gate.checkFeatureGate(baseCtx, 'risk').allowed).toBe(true);
        expect(gate.checkFeatureGate(baseCtx, 'assistant').allowed).toBe(true);
        expect(gate.checkFeatureGate(baseCtx, 'questionnaire').allowed).toBe(true);
    });

    it('disabling ONE feature leaves the others enabled', () => {
        const gate = loadGate({
            AI_RISK_ENABLED: 'true',
            AI_ASSISTANT_ENABLED: 'false',
            AI_RISK_SUGGESTIONS_ENABLED: 'true',
            AI_QUESTIONNAIRE_ENABLED: 'true',
        });
        const assistant = gate.checkFeatureGate(baseCtx, 'assistant');
        expect(assistant.allowed).toBe(false);
        expect(assistant.reason).toContain('assistant');
        // The others are untouched.
        expect(gate.checkFeatureGate(baseCtx, 'risk').allowed).toBe(true);
        expect(gate.checkFeatureGate(baseCtx, 'questionnaire').allowed).toBe(true);
    });

    it('per-feature flag for risk gates risk suggestions independently', () => {
        const gate = loadGate({
            AI_RISK_ENABLED: 'true',
            AI_RISK_SUGGESTIONS_ENABLED: 'false',
            AI_ASSISTANT_ENABLED: 'true',
            AI_QUESTIONNAIRE_ENABLED: 'true',
        });
        expect(gate.checkFeatureGate(baseCtx, 'risk').allowed).toBe(false);
        expect(gate.checkFeatureGate(baseCtx, 'assistant').allowed).toBe(true);
    });

    it('global master switch OFF kills every feature regardless of per-feature flags', () => {
        const gate = loadGate({
            AI_RISK_ENABLED: 'false',
            AI_RISK_SUGGESTIONS_ENABLED: 'true',
            AI_ASSISTANT_ENABLED: 'true',
            AI_QUESTIONNAIRE_ENABLED: 'true',
        });
        for (const f of ['risk', 'assistant', 'questionnaire'] as const) {
            const r = gate.checkFeatureGate(baseCtx, f);
            expect(r.allowed).toBe(false);
            expect(r.reason).toContain('disabled');
        }
    });

    it('enforceFeatureGate throws 403 for a disabled feature', () => {
        // SYNCHRONOUSLY, still. An env flag needs no I/O to read, so it is
        // refused in the gate's synchronous prologue — the property
        // `feature-gate-plan-entitlement` pins under "a forgotten `await` can
        // never weaken the gate".
        const gate = loadGate({ AI_QUESTIONNAIRE_ENABLED: 'false' });
        expect(() => gate.enforceFeatureGate(baseCtx, 'questionnaire')).toThrow();
    });
});
