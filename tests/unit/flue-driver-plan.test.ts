/**
 * WHETHER A RUN MAY START, AND WHAT IT WOULD REASON AGAINST.
 *
 * The driver is split because a Flue run needs two things no jest project can
 * load together — Prisma, and an ESM-only runtime under which `pg` does not
 * load at all. Everything DECIDABLE therefore lives on this side, where it can
 * be exercised exhaustively and cheaply; dispatch and collection live on the
 * other, where a runtime is genuinely needed to mean anything.
 *
 * This file is the decidable half. It is deliberately exhaustive over the
 * refusal set, because each refusal is a sentence an operator reads off a
 * stopped run.
 */
import { planFlueRun, refusalMessage, type FlueStartRefusal } from '@/lib/agentic/flue/driver-plan';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

jest.mock('@/env', () => ({
    env: {
        ANTHROPIC_API_KEY: 'sk-test',
        ANTHROPIC_MODEL: 'claude-haiku-4-5',
        AI_LOCAL_BASE_URL: 'http://gw:11434/v1',
        AI_LOCAL_MODEL: 'llama-3.1-70b',
    },
}));

const def = (over: Partial<WorkflowDefinition> = {}): WorkflowDefinition =>
    ({
        key: 'wf',
        name: 'A workflow',
        description: 'd',
        driver: 'flue',
        steps: [
            { kind: 'READ', label: 'a', tool: 'list_risks' },
            { kind: 'SYNTHESIS', label: 'b', synthesize: () => ({ text: 'x' }) },
        ],
        ...over,
    }) as WorkflowDefinition;

describe('a run that may start', () => {
    it('resolves the model for an EXTERNAL workspace', () => {
        expect(planFlueRun(def(), 0, { residency: 'EXTERNAL' })).toEqual({
            ok: true,
            residency: 'EXTERNAL',
            modelSpecifier: 'inflect-external/claude-haiku-4-5',
        });
    });

    it('resolves the LOCAL model for a LOCAL_ONLY workspace', () => {
        // Stated as a prohibition as well as an equality: the failure that
        // matters is a LOCAL_ONLY run resolving to the external provider id,
        // and an equality alone would not say so.
        const out = planFlueRun(def(), 0, { residency: 'LOCAL_ONLY' });
        expect(out).toEqual({
            ok: true,
            residency: 'LOCAL_ONLY',
            modelSpecifier: 'inflect-local/llama-3.1-70b',
        });
        expect(out.ok && out.modelSpecifier.startsWith('inflect-external')).toBe(false);
    });
});

describe('refusal ORDER — the most specific answer wins', () => {
    it('a definition asking for another driver is refused BEFORE residency arithmetic', () => {
        // Both would refuse: the definition wants static, AND the workspace is
        // LOCAL_ONLY with no gateway. "You asked for something else" is the
        // better answer for a run that never wanted this engine; telling it
        // about an unconfigured gateway would send someone to fix the wrong
        // thing.
        // BOTH refusals must genuinely apply, or order cannot be what decides.
        // The first draft passed `localBaseUrl: null` and left the env gateway
        // in place, so the model resolved fine and only one refusal was ever
        // live — the assertion passed against a reordered implementation,
        // which the mutation proof caught and the assertion did not.
        const mocked = jest.requireMock('@/env') as { env: Record<string, unknown> };
        const saved = mocked.env.AI_LOCAL_BASE_URL;
        mocked.env.AI_LOCAL_BASE_URL = undefined;
        try {
            const out = planFlueRun(def({ driver: 'static' }), 0, { residency: 'LOCAL_ONLY' });
            expect(out).toEqual({ ok: false, reason: 'DEFINITION_ASKED_FOR_ANOTHER_DRIVER' });
        } finally {
            mocked.env.AI_LOCAL_BASE_URL = saved;
        }
    });

    it('a resume past the last step is refused before the model is resolved', () => {
        // Nothing to execute. Dispatching an agent with no work would put a
        // no-op in the ledger, where it reads as a run that did something.
        expect(planFlueRun(def(), 2, { residency: 'EXTERNAL' })).toEqual({
            ok: false,
            reason: 'NO_STEPS_REMAIN',
        });
        // …and at the last valid index it still starts, so the boundary is
        // `>=` and not an off-by-one.
        expect(planFlueRun(def(), 1, { residency: 'EXTERNAL' }).ok).toBe(true);
    });

    it('forwards the model refusal when the engine itself is wanted', () => {
        // The gateway has to be removed from the ENV, not merely passed as
        // null: `resolveFlueModel` reads `sel.localBaseUrl || env.AI_LOCAL_BASE_URL`,
        // so a null override falls back rather than disabling. My first draft
        // asserted the refusal against a null override and got `ok: true` —
        // the test was wrong, not the code, and the semantics are worth
        // stating where the next reader will look.
        const mocked = jest.requireMock('@/env') as { env: Record<string, unknown> };
        const saved = mocked.env.AI_LOCAL_BASE_URL;
        mocked.env.AI_LOCAL_BASE_URL = undefined;
        try {
            expect(planFlueRun(def(), 0, { residency: 'LOCAL_ONLY' })).toEqual({
                ok: false,
                reason: 'LOCAL_GATEWAY_NOT_CONFIGURED',
            });
        } finally {
            mocked.env.AI_LOCAL_BASE_URL = saved;
        }
    });

    it('a per-tenant override is a FALLBACK source, not a kill switch', () => {
        // The semantics the case above depends on, asserted directly so it is
        // not folded into a comment: passing null uses the env value.
        expect(planFlueRun(def(), 0, { residency: 'LOCAL_ONLY', localBaseUrl: null }).ok).toBe(true);
    });
});

describe('every refusal says what to do about it', () => {
    const ALL: FlueStartRefusal[] = [
        'DEFINITION_ASKED_FOR_ANOTHER_DRIVER',
        'NO_STEPS_REMAIN',
        'LOCAL_GATEWAY_NOT_CONFIGURED',
        'LOCAL_MODEL_NOT_CONFIGURED',
        'EXTERNAL_CREDENTIAL_NOT_CONFIGURED',
    ];

    it('names a distinct, prefixed message for each', () => {
        // These land in `WorkflowRun.errorMessage`, which the run list and the
        // run detail page show. A bare enum value would be a code someone has
        // to look up while a run is stopped.
        const messages = ALL.map(refusalMessage);
        expect(new Set(messages).size).toBe(ALL.length);
        // Filtered to the offenders rather than looped with `expect(m)` inside.
        // A loop binding is a subject the Class D ratchet cannot resolve, so
        // each such site is a counted blind spot — and this form is stronger
        // anyway: it names WHICH message is wrong instead of failing on the
        // first, and it keeps the all-N claim that `.some()` would weaken.
        expect(messages.filter((m) => !/^flue_[a-z_]+: /.test(m))).toEqual([]);
    });

    it('the residency refusal explains the RESIDENCY, not just the gap', () => {
        // The one an operator is most likely to meet, and the one where the
        // obvious fix (point it at the external vendor) is the wrong one.
        expect(refusalMessage('LOCAL_GATEWAY_NOT_CONFIGURED')).toMatch(/LOCAL_ONLY/);
        expect(refusalMessage('LOCAL_GATEWAY_NOT_CONFIGURED')).toMatch(/residency boundary/);
    });
});
