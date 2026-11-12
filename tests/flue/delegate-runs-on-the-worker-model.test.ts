/**
 * A DELEGATE IS SERVED ON THE WORKER'S MODEL, AND THE PARENT ON THE
 * SUPERVISOR'S (D-L3-1, docs/ai-architecture/nemotron-reasoning.md Phase 1).
 *
 * Observed through the provider: the faux response factory receives the
 * `Model` the runtime resolved for each call, so which model served the
 * delegate's turn is read off the wire rather than off the binding. With no
 * worker specifier in the binding the delegate inherits the parent's model —
 * the shape every run had before the role axis.
 */
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Context, Model } from '@earendil-works/pi-ai';
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { InflectAgent } from '@/lib/agentic/flue/agent';
import { bindRun, releaseRun, type FlueRunBinding } from '@/lib/agentic/flue/run-binding';
import { SPECIALISTS } from '@/lib/agentic/flue/subagents';
import { _resetDelegationCounts } from '@/lib/agentic/flue/delegation-gate';
import { systemPromptText } from './declared-tools';

const SUPERVISOR_MODEL = 'supervisor-model';
const WORKER_MODEL = 'worker-model';
const SPEC = SPECIALISTS.find((s) => s.name === 'risk_analyst');

function tool(name: string): FlueRunBinding['tools'][number] {
    return {
        name,
        description: `The ${name} tool.`,
        input: v.strictObject({}),
        annotations: { readOnlyHint: true, destructiveHint: false, title: name },
        run: async () => '{}',
    };
}

beforeEach(() => {
    _resetDelegationCounts();
});

/** Which model served the parent's turns and the delegate's, by prompt. */
async function modelsServing(runId: string, withWorker: boolean): Promise<{ parent: string[]; delegate: string[] }> {
    if (!SPEC) throw new Error('no risk_analyst specialist');
    const faux = fauxProvider({
        models: [{ id: SUPERVISOR_MODEL }, { id: WORKER_MODEL }],
    });
    const parent: string[] = [];
    const delegate: string[] = [];
    const needle = SPEC.instructions.slice(0, 40);
    const record = (context: Context, model: Model<string>): void => {
        (systemPromptText(context).includes(needle) ? delegate : parent).push(model.id);
    };

    bindRun(runId, {
        tools: [tool('list_risks')],
        skills: [],
        modelSpecifier: `${faux.provider.id}/${SUPERVISOR_MODEL}`,
        ...(withWorker ? { workerModelSpecifier: `${faux.provider.id}/${WORKER_MODEL}` } : {}),
        maxSubagentsPerTurn: 3,
    });

    faux.setResponses([
        (context, _o, _s, model) => {
            record(context, model);
            return fauxAssistantMessage([fauxToolCall('task', { prompt: 'assess', agent: SPEC.name })]);
        },
        (context, _o, _s, model) => {
            record(context, model);
            return fauxAssistantMessage('delegate answer');
        },
        (context, _o, _s, model) => {
            record(context, model);
            return fauxAssistantMessage('parent answer');
        },
        fauxAssistantMessage('spare'),
    ]);

    const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
    try {
        const agent = init(InflectAgent, { id: runId });
        await agent.read(await agent.dispatch({ message: 'go', initialData: { runId } }));
    } finally {
        await flue.stop();
        releaseRun(runId);
    }
    return { parent, delegate };
}

describe('the role axis reaches the wire', () => {
    it('serves the delegate on the worker model and the parent on the supervisor model', async () => {
        const served = await modelsServing('run-worker-role', true);
        expect(served.delegate).toEqual([WORKER_MODEL]);
        expect(served.parent.length).toBeGreaterThan(0);
        expect(new Set(served.parent)).toEqual(new Set([SUPERVISOR_MODEL]));
    });

    it('serves the delegate on the parent\'s model when no worker is bound', async () => {
        const served = await modelsServing('run-no-worker', false);
        expect(served.delegate).toEqual([SUPERVISOR_MODEL]);
        expect(new Set(served.parent)).toEqual(new Set([SUPERVISOR_MODEL]));
    });
});
