/**
 * A LOCAL_ONLY tenant's reasoning never leaves the building — decided by
 * WHICH MODEL a run may ask for, not by which provider is registered.
 *
 * ── WHY THE DECISION LIVES HERE AT ALL ──────────────────────────────────────
 *
 * The runtime's `setProvider` mutates a module-scoped singleton, so building a
 * provider per run races across concurrent runs and the loser executes against
 * the winner's. With `aiResidency: LOCAL_ONLY` documented as a HARD invariant,
 * that race is a cross-tenant egress. The safe shape registers each provider
 * once and chooses per run by model specifier — which is what this resolves.
 * `tests/guards/flue-refused-capabilities.test.ts` keeps the unsafe shape out.
 *
 * ── AND WHY IT REFUSES WHERE THE RISK FACTORY FALLS BACK ────────────────────
 *
 * `ai/risk-assessment` degrades an unconfigured tenant to a deterministic
 * stub, which is right there: a knowledge-base template is a real answer. A
 * reasoning loop has no such substitute, so an unconfigured run must not
 * start — a stub-backed "agent run" would emit steps, charge tokens and queue
 * proposals that nothing reasoned about.
 */
import { resolveFlueModel, FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';

jest.mock('@/env', () => ({
    env: {
        ANTHROPIC_API_KEY: 'sk-test',
        ANTHROPIC_MODEL: 'claude-haiku-4-5',
        AI_LOCAL_BASE_URL: 'http://gateway.internal:11434/v1',
        AI_LOCAL_MODEL: 'llama-3.1-70b',
    },
}));

describe('which model a Flue run may ask for', () => {
    it('routes an EXTERNAL tenant to the external provider', () => {
        const out = resolveFlueModel({ residency: 'EXTERNAL' });
        expect(out).toEqual({
            ok: true,
            residency: 'EXTERNAL',
            specifier: `${FLUE_PROVIDER_IDS.external}/claude-haiku-4-5`,
        });
    });

    it('routes a LOCAL_ONLY tenant to the LOCAL provider', () => {
        // The invariant. The specifier must name the local provider id, which
        // is what makes `Models` delegate the stream to it.
        const out = resolveFlueModel({ residency: 'LOCAL_ONLY' });
        expect(out).toEqual({
            ok: true,
            residency: 'LOCAL_ONLY',
            specifier: `${FLUE_PROVIDER_IDS.local}/llama-3.1-70b`,
        });
    });

    it('a LOCAL_ONLY tenant NEVER resolves to the external provider id', () => {
        // The assertion with teeth, stated as a prohibition rather than an
        // equality: a future branch that returned the external specifier for
        // some LOCAL_ONLY sub-case would satisfy "ok: true" above if the case
        // above were the only one written.
        // SERVABLE selections must resolve, and resolve locally. Asserting
        // `ok` here keeps the teeth: without it a resolver that refused
        // everything would satisfy the prohibition vacuously.
        for (const sel of [
            { residency: 'LOCAL_ONLY' as const },
            { residency: 'LOCAL_ONLY' as const, localModel: 'mistral-7b' },
        ]) {
            const out = resolveFlueModel(sel);
            expect(out.ok).toBe(true);
            if (out.ok) expect(out.specifier.startsWith(FLUE_PROVIDER_IDS.local)).toBe(true);
        }

        // An UNSERVED tenant gateway refuses — and the prohibition still holds
        // the way it matters. This case used to assert `ok: true`, which was
        // stricter than the intent stated above: it resolved, locally, and
        // then dispatched to the DEPLOYMENT's gateway, which is the residency
        // breach this file exists to prevent.
        const unserved = resolveFlueModel({
            residency: 'LOCAL_ONLY',
            localBaseUrl: 'http://other:8080/v1',
        });
        expect(unserved).toEqual({ ok: false, reason: 'LOCAL_GATEWAY_NOT_SERVED' });
    });

    it('a per-tenant override beats the env default', () => {
        const out = resolveFlueModel({ residency: 'LOCAL_ONLY', localModel: 'mistral-7b' });
        expect(out).toEqual({
            ok: true,
            residency: 'LOCAL_ONLY',
            specifier: `${FLUE_PROVIDER_IDS.local}/mistral-7b`,
        });
    });

    it('treats an ABSENT residency as EXTERNAL, matching the column default', () => {
        // `AiResidency` defaults to EXTERNAL in the schema. Reading absence as
        // LOCAL_ONLY would be safer-looking and wrong — it would refuse every
        // tenant that never set the field.
        expect(resolveFlueModel(undefined).ok).toBe(true);
        expect(resolveFlueModel({}).ok).toBe(true);
        const out = resolveFlueModel({ residency: null });
        expect(out.ok && out.residency).toBe('EXTERNAL');
    });
});

describe('an unconfigured run is refused, not quietly downgraded', () => {
    const realEnv = jest.requireMock('@/env') as { env: Record<string, unknown> };

    afterEach(() => {
        realEnv.env.AI_LOCAL_BASE_URL = 'http://gateway.internal:11434/v1';
        realEnv.env.AI_LOCAL_MODEL = 'llama-3.1-70b';
        realEnv.env.ANTHROPIC_API_KEY = 'sk-test';
    });

    it('LOCAL_ONLY with no gateway refuses — it does NOT fall through to external', () => {
        // The failure mode this whole module exists to prevent. Falling back
        // would honour the letter of "the run happened" and break the
        // residency invariant completely.
        realEnv.env.AI_LOCAL_BASE_URL = undefined;
        expect(resolveFlueModel({ residency: 'LOCAL_ONLY' })).toEqual({
            ok: false,
            reason: 'LOCAL_GATEWAY_NOT_CONFIGURED',
        });
    });

    it('LOCAL_ONLY refuses a tenant gateway this deployment does not serve', () => {
        // THE RESIDENCY HOLE. The tenant nominated its own gateway, and the
        // `inflect-local` provider is built once at boot from
        // AI_LOCAL_BASE_URL alone. Accepting the tenant value here decided the
        // run may proceed and then did not carry: the dispatch went to the
        // DEPLOYMENT's endpoint, sending that workspace's content somewhere it
        // did not nominate — under the one setting that exists to stop exactly
        // that.
        realEnv.env.AI_LOCAL_BASE_URL = 'https://gateway.deployment.internal';
        expect(
            resolveFlueModel({
                residency: 'LOCAL_ONLY',
                localBaseUrl: 'https://gateway.tenant.internal',
            }),
        ).toEqual({ ok: false, reason: 'LOCAL_GATEWAY_NOT_SERVED' });
    });

    it('LOCAL_ONLY allows a tenant gateway that IS the served one', () => {
        // The positive control. A tenant that names the same endpoint the
        // deployment serves is asking for nothing that cannot be honoured, and
        // must not be refused — without this the test above would pass under
        // an implementation that refused every per-tenant value.
        realEnv.env.AI_LOCAL_BASE_URL = 'https://gateway.deployment.internal';
        expect(
            resolveFlueModel({
                residency: 'LOCAL_ONLY',
                localBaseUrl: 'https://gateway.deployment.internal',
            }),
        ).toEqual({
            ok: true,
            residency: 'LOCAL_ONLY',
            specifier: 'inflect-local/llama-3.1-70b',
        });
    });

    it('LOCAL_ONLY with no tenant gateway still uses the deployment one', () => {
        // The common case must keep working: most tenants set nothing and
        // inherit the deployment gateway.
        realEnv.env.AI_LOCAL_BASE_URL = 'https://gateway.deployment.internal';
        expect(resolveFlueModel({ residency: 'LOCAL_ONLY' })).toEqual({
            ok: true,
            residency: 'LOCAL_ONLY',
            specifier: 'inflect-local/llama-3.1-70b',
        });
    });

    it('LOCAL_ONLY with a gateway but no model names THAT gap specifically', () => {
        // Two different operator actions, so two different reasons. One
        // catch-all would send someone to check the wrong setting.
        realEnv.env.AI_LOCAL_MODEL = undefined;
        expect(resolveFlueModel({ residency: 'LOCAL_ONLY' })).toEqual({
            ok: false,
            reason: 'LOCAL_MODEL_NOT_CONFIGURED',
        });
    });

    it('EXTERNAL with no credential refuses rather than starting a run it cannot finish', () => {
        realEnv.env.ANTHROPIC_API_KEY = undefined;
        expect(resolveFlueModel({ residency: 'EXTERNAL' })).toEqual({
            ok: false,
            reason: 'EXTERNAL_CREDENTIAL_NOT_CONFIGURED',
        });
    });

    it('every refusal reason is distinct — the denominator', () => {
        // Three reasons, three settings. If two collapsed to one string the
        // assertions above would still pass individually.
        realEnv.env.AI_LOCAL_BASE_URL = undefined;
        const a = resolveFlueModel({ residency: 'LOCAL_ONLY' });
        realEnv.env.AI_LOCAL_BASE_URL = 'http://gateway.internal:11434/v1';
        realEnv.env.AI_LOCAL_MODEL = undefined;
        const b = resolveFlueModel({ residency: 'LOCAL_ONLY' });
        realEnv.env.AI_LOCAL_MODEL = 'llama-3.1-70b';
        realEnv.env.ANTHROPIC_API_KEY = undefined;
        const c = resolveFlueModel({ residency: 'EXTERNAL' });

        const reasons = [a, b, c].map((r) => (r.ok ? 'OK' : r.reason));
        expect(new Set(reasons).size).toBe(3);
    });
});
