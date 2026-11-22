/**
 * THE WORKER ROLE CHOOSES A MODEL, NEVER A ROUTE (D-L3-1, owner decision
 * 2026-11-11; docs/ai-architecture/nemotron-reasoning.md Phase 1).
 *
 * A Flue run's own model calls are the SUPERVISOR's; its subagents' are the
 * WORKER's. The worker may run on a different, smaller model — but both roles
 * obey the tenant's residency by the same rules (G1), and a deployment that
 * configures no worker model must answer exactly as it did before the role
 * axis existed.
 *
 * The env is a mutable object so one file can ask the same resolver with and
 * without a worker model configured.
 */
const mockEnv: Record<string, string | undefined> = {};

jest.mock('@/env', () => ({ env: mockEnv }));

import {
    FLUE_PROVIDER_IDS,
    flueOpeningModels,
    providerIdOf,
    resolveFlueModel,
    resolveFlueRoleModels,
    type FlueModelSelection,
} from '@/lib/agentic/flue/model-selection';
import { planFlueRun, refusalMessage } from '@/lib/agentic/flue/driver-plan';
import { workerModelOverride } from '@/lib/agentic/flue/subagents';
import { AnthropicAssistantProvider, SpecifierMismatchError } from '@/app-layer/ai/assistant/turn-provider';
import type { ProviderRequest } from '@/app-layer/ai/assistant/tool-loop';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

const SUPERVISOR = 'claude-sonnet-5-5';
const WORKER = 'claude-haiku-4-5';
const GATEWAY = 'http://gateway.internal:11434/v1';
const LOCAL_MODEL = 'llama-3.1-70b';

function configure(over: Record<string, string | undefined> = {}): void {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    Object.assign(mockEnv, {
        ANTHROPIC_API_KEY: 'sk-test',
        AGENT_FLUE_MODEL: SUPERVISOR,
        AI_LOCAL_BASE_URL: GATEWAY,
        AI_LOCAL_MODEL: LOCAL_MODEL,
        ...over,
    });
}

beforeEach(() => configure());

const EXTERNAL: FlueModelSelection = { residency: 'EXTERNAL' };
const LOCAL_ONLY: FlueModelSelection = { residency: 'LOCAL_ONLY' };

describe('the worker resolves to its configured model', () => {
    it('names AGENT_FLUE_WORKER_MODEL on the external provider, as a choice and not a fallback', () => {
        configure({ AGENT_FLUE_WORKER_MODEL: WORKER });
        expect(resolveFlueModel({ ...EXTERNAL, role: 'worker' })).toEqual({
            ok: true,
            residency: 'EXTERNAL',
            specifier: `${FLUE_PROVIDER_IDS.external}/${WORKER}`,
        });
    });

    it('leaves the supervisor on AGENT_FLUE_MODEL when a worker model is configured', () => {
        configure({ AGENT_FLUE_WORKER_MODEL: WORKER });
        expect(resolveFlueRoleModels(EXTERNAL)).toEqual({
            ok: true,
            residency: 'EXTERNAL',
            supervisor: `${FLUE_PROVIDER_IDS.external}/${SUPERVISOR}`,
            worker: `${FLUE_PROVIDER_IDS.external}/${WORKER}`,
            workerBasis: 'CONFIGURED',
        });
    });

    it('hands the run plan both specifiers, and a delegate the worker model as its override', () => {
        configure({ AGENT_FLUE_WORKER_MODEL: WORKER });
        const def = { key: 'posture-review', driver: 'flue', steps: [] } as unknown as WorkflowDefinition;
        const plan = planFlueRun(def, 0, EXTERNAL);
        expect(plan).toEqual({
            ok: true,
            residency: 'EXTERNAL',
            modelSpecifier: `${FLUE_PROVIDER_IDS.external}/${SUPERVISOR}`,
            workerModelSpecifier: `${FLUE_PROVIDER_IDS.external}/${WORKER}`,
            workerBasis: 'CONFIGURED',
        });
        if (!plan.ok) throw new Error('unreachable');
        expect(
            workerModelOverride({
                modelSpecifier: plan.modelSpecifier,
                workerModelSpecifier: plan.workerModelSpecifier,
            }),
        ).toBe(`${FLUE_PROVIDER_IDS.external}/${WORKER}`);
    });
});

describe('an unset worker equals the supervisor — today\'s behaviour, byte for byte', () => {
    it('falls back to the supervisor\'s specifier and records the fallback', () => {
        expect(resolveFlueModel({ ...EXTERNAL, role: 'worker' })).toEqual({
            ok: true,
            residency: 'EXTERNAL',
            specifier: `${FLUE_PROVIDER_IDS.external}/${SUPERVISOR}`,
            fallback: 'worker_fallback',
        });
        expect(resolveFlueRoleModels(EXTERNAL)).toMatchObject({
            supervisor: `${FLUE_PROVIDER_IDS.external}/${SUPERVISOR}`,
            worker: `${FLUE_PROVIDER_IDS.external}/${SUPERVISOR}`,
            workerBasis: 'worker_fallback',
        });
    });

    it('treats a blank worker variable as unset, not as a model named ""', () => {
        configure({ AGENT_FLUE_WORKER_MODEL: '   ' });
        expect(resolveFlueRoleModels(EXTERNAL)).toMatchObject({ workerBasis: 'worker_fallback' });
    });

    it('answers a role-less (supervisor) ask with the exact pre-role-axis object', () => {
        // No `fallback` key on a supervisor answer, configured worker or not:
        // every existing caller's `toEqual` still holds.
        configure({ AGENT_FLUE_WORKER_MODEL: WORKER });
        const expected = { ok: true, residency: 'EXTERNAL', specifier: `${FLUE_PROVIDER_IDS.external}/${SUPERVISOR}` };
        expect(resolveFlueModel(EXTERNAL)).toEqual(expected);
        expect(resolveFlueModel({ ...EXTERNAL, role: 'supervisor' })).toEqual(expected);
        expect(resolveFlueModel(undefined)).toEqual(expected);
    });

    it('gives a delegate NO model override, so it inherits the parent\'s as it always did', () => {
        const def = { key: 'posture-review', driver: 'flue', steps: [] } as unknown as WorkflowDefinition;
        const plan = planFlueRun(def, 0, EXTERNAL);
        if (!plan.ok) throw new Error('unreachable');
        expect(plan.workerModelSpecifier).toBe(plan.modelSpecifier);
        expect(workerModelOverride(plan)).toBeUndefined();
        // And a binding that predates the role axis (no worker field at all).
        expect(workerModelOverride({ modelSpecifier: plan.modelSpecifier })).toBeUndefined();
    });
});

describe('a LOCAL_ONLY tenant never resolves either role externally', () => {
    it('keeps the worker on the local route even with an external worker model configured', () => {
        configure({ AGENT_FLUE_WORKER_MODEL: WORKER });
        const both = resolveFlueRoleModels(LOCAL_ONLY);
        expect(both).toEqual({
            ok: true,
            residency: 'LOCAL_ONLY',
            supervisor: `${FLUE_PROVIDER_IDS.local}/${LOCAL_MODEL}`,
            worker: `${FLUE_PROVIDER_IDS.local}/${LOCAL_MODEL}`,
            workerBasis: 'worker_fallback',
        });
        if (!both.ok) throw new Error('unreachable');
        expect(providerIdOf(both.worker)).not.toBe(FLUE_PROVIDER_IDS.external);
        expect(both.worker.includes(WORKER)).toBe(false);
    });

    it('refuses BOTH roles with the same named reason when there is no local route', () => {
        // An external worker model and an external credential are both
        // configured: a worker that fell through to the external branch would
        // resolve here instead of refusing.
        configure({ AGENT_FLUE_WORKER_MODEL: WORKER, AI_LOCAL_BASE_URL: undefined });
        const supervisor = resolveFlueModel({ ...LOCAL_ONLY, role: 'supervisor' });
        const worker = resolveFlueModel({ ...LOCAL_ONLY, role: 'worker' });
        expect(supervisor).toEqual({ ok: false, reason: 'LOCAL_GATEWAY_NOT_CONFIGURED' });
        expect(worker).toEqual(supervisor);
        expect(resolveFlueRoleModels(LOCAL_ONLY)).toEqual(supervisor);
    });

    it('refuses both roles when the gateway names no model', () => {
        configure({ AGENT_FLUE_WORKER_MODEL: WORKER, AI_LOCAL_MODEL: undefined });
        expect(resolveFlueModel({ ...LOCAL_ONLY, role: 'worker' })).toEqual({
            ok: false,
            reason: 'LOCAL_MODEL_NOT_CONFIGURED',
        });
    });
});

describe('the run records both roles where it opens', () => {
    it('records both specifiers and the worker basis', () => {
        configure({ AGENT_FLUE_WORKER_MODEL: WORKER });
        expect(flueOpeningModels(EXTERNAL)).toEqual({
            modelSupervisor: `${FLUE_PROVIDER_IDS.external}/${SUPERVISOR}`,
            modelWorker: `${FLUE_PROVIDER_IDS.external}/${WORKER}`,
            modelWorkerBasis: 'CONFIGURED',
            modelRefusal: null,
        });
    });

    it('records the fallback when no worker model is configured', () => {
        expect(flueOpeningModels(EXTERNAL)).toMatchObject({ modelWorkerBasis: 'worker_fallback' });
    });

    it('records the refusal, and no specifier, when neither role resolves', () => {
        configure({ ANTHROPIC_API_KEY: undefined });
        expect(flueOpeningModels(EXTERNAL)).toEqual({
            modelSupervisor: null,
            modelWorker: null,
            modelWorkerBasis: null,
            modelRefusal: 'EXTERNAL_CREDENTIAL_NOT_CONFIGURED',
        });
    });
});

describe('the socket re-check still refuses a mismatched specifier, for either role', () => {
    const req = (specifier: string): ProviderRequest => ({
        specifier,
        system: 'system',
        question: 'question',
        history: [],
        tools: [],
    });

    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
    });

    it.each(['supervisor', 'worker'] as const)(
        'refuses a LOCAL_ONLY %s specifier at the external socket, sending nothing',
        async (role) => {
            configure({ AGENT_FLUE_WORKER_MODEL: WORKER });
            const choice = resolveFlueModel({ ...LOCAL_ONLY, role });
            if (!choice.ok) throw new Error('expected a local specifier');
            const sent = jest.fn();
            global.fetch = sent as unknown as typeof fetch;

            await expect(new AnthropicAssistantProvider('key').complete(req(choice.specifier))).rejects.toBeInstanceOf(
                SpecifierMismatchError,
            );
            expect(sent).not.toHaveBeenCalled();
        },
    );

    it('accepts the configured external worker specifier and sends the worker model id', async () => {
        configure({ AGENT_FLUE_WORKER_MODEL: WORKER });
        const choice = resolveFlueModel({ ...EXTERNAL, role: 'worker' });
        if (!choice.ok) throw new Error('expected an external specifier');
        const bodies: string[] = [];
        global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
            bodies.push(String(init?.body));
            return {
                ok: true,
                status: 200,
                json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
            } as unknown as Response;
        }) as unknown as typeof fetch;

        await new AnthropicAssistantProvider('key').complete(req(choice.specifier));
        expect(bodies).toHaveLength(1);
        expect(JSON.parse(bodies[0]).model).toBe(WORKER);
    });

    it('names the engine refusal for a worker on another route', () => {
        // The engine's second gate (`execute.ts`) refuses a worker specifier
        // whose provider differs from the supervisor's; its sentence says why.
        expect(refusalMessage('WORKER_ROUTE_MISMATCH')).toMatch(/^flue_worker_route_mismatch: /);
    });
});
