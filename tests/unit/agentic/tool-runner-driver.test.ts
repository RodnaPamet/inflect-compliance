/**
 * The Tool Runner engine, held to the driver conformance suite
 * (`tests/helpers/driver-conformance.ts`, Step 0b), and to Step 2b's hardening
 * list in `docs/claude-tool-runner-design.md`.
 *
 * ═══ WHAT IS REAL HERE ═══
 *
 * The driver (`runToolRunnerDriver` → `executeToolRunnerRun`), the residency
 * decision (`clientForRun`), the SDK client with its `messagesOnly`
 * middleware, the SDK's own tool runner, `lockedParams`, the tool core
 * (`offerToolSet` → `runGuardedTool`), the AI Guard's scanners and its mode
 * read, the run budget and the Art 12 writer.
 *
 * ═══ WHAT IS FAKED ═══
 *
 * The model: `global.fetch`, which the SDK client calls, answers each request
 * from the scripted turns. Every request it receives is a request that left
 * the client, so the bodies it records are what Anthropic would have received.
 * And every module that reaches the database, as in the Flue adapter: the
 * ledger, the run row and its settlement, the kill-switch read, the tenant
 * settings reads, the decision-log insert and the audit append. The funnel is
 * faked at `runReadTool`, keeping step 0 of `authorizeToolCall`.
 */
import type { ConformanceObservation, ConformanceRun, ScriptedTurn } from '../../helpers/driver-conformance';
import { strictMock } from '../../helpers/strict-mock';

// ─── Shared state for the fakes ─────────────────────────────────────

interface MockSettlement {
    status: string;
    reason: string | null;
    cap: string | null;
}

const mockState = {
    tools: [] as Array<{ name: string; result: string }>,
    residency: 'EXTERNAL' as 'EXTERNAL' | 'LOCAL_ONLY',
    alreadyTokens: 0,
    toolCallLimit: null as number | null,
    killAfterModelCalls: null as number | null,
    /** Engage the kill once the funnel has answered this many calls: a kill engaged WHILE a tool runs. */
    killAfterFunnelCalls: null as number | null,
    modelCalls: 0,
    ledger: [] as Array<{ kind: string; rec: Record<string, unknown> }>,
    decisionRows: [] as Array<{ inputDigest: string }>,
    decisionInputs: [] as unknown[],
    decisionSummaries: [] as Array<string | null | undefined>,
    funnelCalls: [] as Array<{ name: string; args: unknown }>,
    /** How long the funnel takes per tool, so concurrent calls would finish out of order. */
    funnelDelayMs: {} as Record<string, number>,
    settlement: null as MockSettlement | null,
    updates: [] as Array<Record<string, unknown>>,
};

function recordedSettlement(): MockSettlement | null {
    return mockState.settlement;
}

function mockKilled(): boolean {
    return (
        (mockState.killAfterModelCalls !== null && mockState.modelCalls >= mockState.killAfterModelCalls) ||
        (mockState.killAfterFunnelCalls !== null && mockState.funnelCalls.length >= mockState.killAfterFunnelCalls)
    );
}

jest.mock('@/env', () => ({
    env: {
        NODE_ENV: 'test',
        ANTHROPIC_API_KEY: 'sk-ant-conformance',
    },
}));

jest.mock('@/lib/agentic/kill-switch', () => ({
    KILL_SWITCH_DRILL_AGENT_ID: 'kill-switch-drill',
    killRefusalMessage: (scope: string) => `This agent has been stopped by a ${scope} kill switch.`,
    resolveKillState: jest.fn(async () =>
        mockKilled() ? { scope: 'AGENT', switchId: 'sw-1', engagedAt: new Date('2026-10-29T00:00:00Z') } : null,
    ),
}));

jest.mock('@/lib/observability/integration-metrics', () => ({ recordAgentKillRefusal: jest.fn() }));
jest.mock('@/lib/observability/metrics', () => ({
    recordWorkflowContextIntegrityHalt: jest.fn(),
    recordAiDecisionLogged: jest.fn(),
    recordAiDecisionOutcome: jest.fn(),
    recordAiGuardVerdict: jest.fn(),
}));

jest.mock('@/lib/agentic/drivers/step-recorder', () => ({
    recordStep: jest.fn(async (_ctx: unknown, _runId: string, _seq: number, kind: string, rec: Record<string, unknown>) => {
        mockState.ledger.push({ kind, rec });
    }),
}));

jest.mock('@/lib/agentic/drivers/run-settlement', () => {
    const settle = (status: string, reason: string | null, cap: string | null = null): string => {
        mockState.settlement = { status, reason, cap };
        return status;
    };
    return {
        updateRun: jest.fn(async (_c: unknown, _r: string, data: Record<string, unknown>) => {
            mockState.updates.push(data);
            if (typeof data.status === 'string') {
                settle(data.status, typeof data.errorMessage === 'string' ? data.errorMessage : null);
            }
        }),
        failRun: jest.fn(async (_c: unknown, _r: string, message: string) => settle('FAILED', message)),
        haltRunAtKill: jest.fn(async (_c: unknown, _r: string, _kill: unknown, message: string, _beside: unknown, prefix?: string) =>
            settle('ABORTED', `${prefix ?? 'flue'}_run_agent_killed: ${message}`),
        ),
        haltRunAtCap: jest.fn(async (_c: unknown, _r: string, halt: { kind: string; message: string }) =>
            settle('FAILED', halt.message, halt.kind),
        ),
        haltRunAtGuard: jest.fn(async (_c: unknown, _r: string, worst: string) =>
            settle(worst === 'QUARANTINED' ? 'ABORTED' : 'AWAITING_APPROVAL', `ai_guard_${worst.toLowerCase()}`),
        ),
    };
});

jest.mock('@/lib/agentic/drivers/run-store', () => ({
    getRunRow: jest.fn(async () => ({
        costTokens: mockState.alreadyTokens,
        contextJson: null,
        contextHash: null,
        mountedSkills: [],
    })),
    proposedItemsSoFar: jest.fn(async () => 0),
}));

jest.mock('@/lib/agentic/circuit-breaker-store', () => ({ latchOnGuardBlock: jest.fn(async () => null) }));

jest.mock('@/lib/mcp/auth', () => ({
    resolveMcpInvocation: jest.fn(async (ctx: unknown) => ({
        ctx,
        autonomyCeiling: 6,
        governedAgentId: 'agent-conformance',
        policyCard:
            mockState.toolCallLimit === null ? null : { inForce: { value: { maxActionsPerRun: mockState.toolCallLimit } } },
    })),
}));

jest.mock('@/lib/auth/api-key-auth', () => ({ enforceApiKeyScope: jest.fn() }));

jest.mock('@/lib/mcp/tools/registry', () => ({
    loadableReadTools: jest.fn(() =>
        mockState.tools.map((t) => ({
            name: t.name,
            description: `The ${t.name} tool.`,
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            resourceScope: { resource: t.name, action: 'read' },
            authorize: { basis: 'effective', mirrors: `GET /${t.name}` },
        })),
    ),
    runReadTool: jest.fn(async (_inv: unknown, name: string, args: unknown) => {
        if (mockKilled()) {
            const { forbidden } = jest.requireActual('@/lib/errors/types');
            throw forbidden('This agent has been stopped by a AGENT kill switch.');
        }
        mockState.funnelCalls.push({ name, args });
        const delay = mockState.funnelDelayMs[name] ?? 0;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        const tool = mockState.tools.find((t) => t.name === name);
        return { content: [{ type: 'text', text: tool ? tool.result : '{}' }] };
    }),
}));

jest.mock('@/lib/mcp/tools/propose-tools', () => ({
    loadableProposeTools: jest.fn(() => []),
    runProposeTool: jest.fn(async () => ({ content: [] })),
    isProposeTool: () => false,
    proposedItemCount: () => 0,
}));

jest.mock('@/lib/db/rls-middleware', () => {
    const db = {
        tenantSecuritySettings: {
            findUnique: async () => ({ aiResidency: mockState.residency, aiLocalBaseUrl: null, aiLocalModel: null }),
        },
        registeredAgent: { findFirst: async () => ({ aiSystemId: 'ai-system-conformance' }) },
        aiDecisionLog: {
            create: async ({ data }: { data: { inputDigest: string } }) => {
                mockState.decisionRows.push({ inputDigest: data.inputDigest });
                return { id: `decision-${mockState.decisionRows.length}` };
            },
        },
    };
    return {
        // The real module's other exports, which the Prisma client the real
        // audit module loads needs; only the tenant-context entry is faked.
        ...jest.requireActual('@/lib/db/rls-middleware'),
        runInTenantContext: jest.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db)),
    };
});
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique: async () => null } }),
    ),
}));
// Strict, so an audit export the engine reaches that this fixture forgot fails
// loudly rather than resolving to undefined.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: jest.fn(async () => undefined),
    }),
);

// The decision log, real, with its input captured on the way through.
jest.mock('@/app-layer/ai/decision-log', () => {
    const actual = jest.requireActual('@/app-layer/ai/decision-log');
    return {
        ...actual,
        logAiDecision: jest.fn(async (db: unknown, ctx: unknown, input: { sanitizedInput: unknown; outputSummary?: string | null }) => {
            mockState.decisionInputs.push(input.sanitizedInput);
            mockState.decisionSummaries.push(input.outputSummary);
            return actual.logAiDecision(db, ctx, input);
        }),
    };
});

import type { RequestContext } from '@/app-layer/types';
import { computeInputDigest } from '@/app-layer/ai/decision-log';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { runToolRunnerDriver, planToolRunnerRun, refusalMessage } from '@/lib/agentic/tool-runner/driver';
import { describeDriverConformance } from '../../helpers/driver-conformance';

// ─── The wire ───────────────────────────────────────────────────────

/** A turn as the faux model answers it: the conformance script, or raw content for a hardening case. */
type FauxTurn = ScriptedTurn | { readonly raw: { content: unknown[]; stop_reason: string } };

const wire = {
    turns: [] as FauxTurn[],
    bodies: [] as Array<Record<string, unknown>>,
    urls: [] as string[],
};

const originalFetch = global.fetch;

function fauxResponse(turn: FauxTurn | undefined, n: number): { content: unknown[]; stop_reason: string } {
    if (turn === undefined) return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
    if ('raw' in turn) return turn.raw;
    if (turn.toolCalls) {
        return {
            content: turn.toolCalls.map((c, j) => ({ type: 'tool_use', id: `toolu_${n}_${j}`, name: c.name, input: c.args })),
            stop_reason: 'tool_use',
        };
    }
    return { content: [{ type: 'text', text: turn.text ?? '' }], stop_reason: 'end_turn' };
}

beforeEach(() => {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const n = wire.bodies.length;
        wire.bodies.push(body);
        wire.urls.push(String(input));
        mockState.modelCalls += 1;
        const answer = fauxResponse(wire.turns[n], n);
        return new Response(
            JSON.stringify({
                id: `msg_${n}`,
                type: 'message',
                role: 'assistant',
                model: String(body.model),
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 5 },
                ...answer,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;
});

afterEach(() => {
    global.fetch = originalFetch;
});

const DEFINITION = {
    key: 'conformance',
    name: 'Conformance',
    description: 'Read the risks and say what you found.',
    driver: 'tool-runner',
    readOnly: true,
    steps: [{ kind: 'READ', tool: 'list_risks', label: 'Read the risks' }],
} as unknown as WorkflowDefinition;

function context(): RequestContext {
    return {
        requestId: `req-${Math.random().toString(36).slice(2)}`,
        userId: 'user-conformance',
        tenantId: 'tenant-conformance',
        tenantSlug: 'tenant-conformance',
        role: 'ADMIN',
        agentId: 'agent-conformance',
    } as unknown as RequestContext;
}

function reset(run: Pick<ConformanceRun, 'tools' | 'residency' | 'alreadySpent' | 'toolCallLimit' | 'killAfterModelCalls'>, turns: readonly FauxTurn[]): void {
    mockState.tools = [...run.tools];
    mockState.residency = run.residency ?? 'EXTERNAL';
    mockState.alreadyTokens = run.alreadySpent?.tokens ?? 0;
    mockState.toolCallLimit = run.toolCallLimit ?? null;
    mockState.killAfterModelCalls = run.killAfterModelCalls ?? null;
    mockState.killAfterFunnelCalls = null;
    mockState.modelCalls = 0;
    mockState.ledger = [];
    mockState.decisionRows = [];
    mockState.decisionInputs = [];
    mockState.decisionSummaries = [];
    mockState.funnelCalls = [];
    mockState.funnelDelayMs = {};
    mockState.settlement = null;
    mockState.updates = [];
    wire.turns = [...turns];
    wire.bodies = [];
    wire.urls = [];
}

async function drive(
    run: ConformanceRun,
    turns: readonly FauxTurn[] = run.turns,
    def: WorkflowDefinition = DEFINITION,
    funnelDelayMs: Record<string, number> = {},
) {
    reset(run, turns);
    mockState.funnelDelayMs = { ...funnelDelayMs };
    const runId = `run-${Math.random().toString(36).slice(2)}`;
    const startedAt = Date.now() - (run.alreadySpent?.elapsedMs ?? 0);
    const outcome = await runToolRunnerDriver(context(), runId, def, 0, startedAt);
    return outcome;
}

async function runOnToolRunner(run: ConformanceRun): Promise<ConformanceObservation> {
    const outcome = await drive(run);
    const settlement = recordedSettlement();
    const firstTools = (wire.bodies[0]?.tools as Array<{ name: string }> | undefined) ?? [];
    return {
        status: settlement?.status ?? outcome.status,
        haltReason: settlement?.status === 'COMPLETED' ? null : (settlement?.reason ?? null),
        haltedCap: settlement?.cap ?? null,
        modelInputs: wire.bodies.map((b) => JSON.stringify(b.messages)),
        externalModelCalls: wire.urls.filter((u) => new URL(u).origin === 'https://api.anthropic.com').length,
        ledger: mockState.ledger.map((s) => {
            const input = s.rec.input as { decisionDigest?: unknown; modelCalls?: unknown } | undefined;
            return {
                kind: s.kind,
                toolCalled: typeof s.rec.toolCalled === 'string' ? s.rec.toolCalled : null,
                decisionDigest: typeof input?.decisionDigest === 'string' ? input.decisionDigest : null,
                modelCalls: typeof input?.modelCalls === 'number' ? input.modelCalls : null,
            };
        }),
        decisionRows: [...mockState.decisionRows],
        funnelCalls: [...mockState.funnelCalls],
        offeredTools: firstTools.map((t) => t.name).sort(),
        // This engine supplies no tool of its own in Step 2b (skills arrive in 2d).
        reportedEngineTools: [],
    };
}

describeDriverConformance({ engine: 'tool-runner', run: runOnToolRunner });

// ─── Step 2b's hardening list ───────────────────────────────────────

const LIST_RISKS = { name: 'list_risks', result: '{"risks":[{"id":"r1"}]}' };
const LIST_CONTROLS = { name: 'list_controls', result: '{"controls":[{"id":"c1"}]}' };
const LIST_ASSETS = { name: 'list_assets', result: '{"assets":[{"id":"a1"}]}' };

describe('Step 2b hardening', () => {
    it('no request leaves with a server-held thread: no body carries a `thread` member', async () => {
        await drive({ tools: [LIST_RISKS], turns: [{ toolCalls: [{ name: 'list_risks', args: {} }] }, { text: 'done' }] });
        // Positive control: two requests were sent, so the check has a population.
        expect(wire.bodies).toHaveLength(2);
        expect(wire.bodies.map((b) => 'thread' in b)).toEqual([false, false]);
    });

    it('every request carries the locked parameters on the wire', async () => {
        await drive({ tools: [LIST_RISKS], turns: [{ text: 'done' }] });
        const [body] = wire.bodies;
        expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body).not.toHaveProperty('temperature');
        expect(body).not.toHaveProperty('mcp_servers');
        expect((body.tools as Array<{ type?: string }>).every((t) => t.type === undefined || t.type === 'custom')).toBe(true);
    });

    it('dispatches tool calls one at a time, in the order the model asked, when one turn asks for three', async () => {
        // The runner starts all three at once. The first is the slowest, so
        // concurrent dispatch would finish, and record, them in reverse.
        const slowestFirst = { list_controls: 30, list_risks: 15, list_assets: 0 };
        await drive(
            { tools: [LIST_RISKS, LIST_CONTROLS, LIST_ASSETS], turns: [] },
            [
                {
                    toolCalls: [
                        { name: 'list_controls', args: {} },
                        { name: 'list_risks', args: {} },
                        { name: 'list_assets', args: {} },
                    ],
                },
                { text: 'done' },
            ],
            DEFINITION,
            slowestFirst,
        );
        const toolSteps = mockState.ledger.filter((s) => s.kind === 'TOOL_CALL').map((s) => s.rec.toolCalled);
        expect(toolSteps).toEqual(['list_controls', 'list_risks', 'list_assets']);
        expect(slowestFirst).toEqual(mockState.funnelDelayMs);
        expect(mockState.funnelCalls.map((c) => c.name)).toEqual(['list_controls', 'list_risks', 'list_assets']);
        expect(recordedSettlement()?.status).toBe('COMPLETED');
    });

    it('one MODEL_CALL step and one decision row per model call, and the digest is of the request that went out', async () => {
        await drive({ tools: [LIST_RISKS], turns: [{ toolCalls: [{ name: 'list_risks', args: {} }] }, { text: 'done' }] });
        const modelSteps = mockState.ledger.filter((s) => s.kind === 'MODEL_CALL');
        expect(modelSteps).toHaveLength(wire.bodies.length);
        expect(mockState.decisionRows).toHaveLength(wire.bodies.length);
        for (const [i, step] of modelSteps.entries()) {
            const digest = (step.rec.input as { decisionDigest: string }).decisionDigest;
            // The row and the step name the same digest...
            expect(mockState.decisionRows[i].inputDigest).toBe(digest);
            // ...taken over the runner's params for that call, which are the
            // request that left: its messages, model and system are the body's.
            const params = mockState.decisionInputs[i] as Record<string, unknown>;
            expect(computeInputDigest(params)).toBe(digest);
            expect(params.messages).toEqual(wire.bodies[i].messages);
            expect(params.model).toBe(wire.bodies[i].model);
            expect(params.system).toEqual(wire.bodies[i].system);
        }
        // Two calls see two different conversations, so two digests.
        expect(new Set(modelSteps.map((s) => (s.rec.input as { decisionDigest: string }).decisionDigest)).size).toBe(2);
    });

    it('a refusal settles the run with a named reason and runs no tool from that turn', async () => {
        await drive({ tools: [LIST_RISKS], turns: [] }, [
            {
                raw: {
                    content: [{ type: 'tool_use', id: 'toolu_refused', name: 'list_risks', input: {} }],
                    stop_reason: 'refusal',
                },
            },
        ]);
        expect(recordedSettlement()?.status).toBe('FAILED');
        expect(recordedSettlement()?.reason).toMatch(/^tool_runner_model_refused:/);
        expect(mockState.funnelCalls).toEqual([]);
        expect(mockState.ledger.filter((s) => s.kind === 'TOOL_CALL')).toEqual([]);
        expect(wire.bodies).toHaveLength(1);
    });

    it.each([
        ['max_tokens', 'tool_runner_max_tokens:'],
        ['model_context_window_exceeded', 'tool_runner_context_exhausted:'],
    ])('a %s stop settles the run with its own named reason', async (stopReason, prefix) => {
        await drive({ tools: [LIST_RISKS], turns: [] }, [{ raw: { content: [{ type: 'text', text: 'partial' }], stop_reason: stopReason } }]);
        expect(recordedSettlement()?.reason?.startsWith(prefix)).toBe(true);
        expect(mockState.funnelCalls).toEqual([]);
    });

    it('a flagged model answer stops the run at the guard, and its text is not kept as the summary', async () => {
        await drive({ tools: [LIST_RISKS], turns: [] }, [{ text: 'Here is the key: AKIAIOSFODNN7EXAMPLE' }]); // pragma: allowlist secret
        expect(['AWAITING_APPROVAL', 'ABORTED']).toContain(recordedSettlement()?.status);
        expect(recordedSettlement()?.reason).toMatch(/^ai_guard_/);
        // The call is still on the record, with no summary of what it said.
        expect(mockState.decisionSummaries).toEqual([null]);
    });

    it('a clean model answer is kept as that call\'s summary (positive control)', async () => {
        await drive({ tools: [LIST_RISKS], turns: [] }, [{ text: 'One risk, owned.' }]);
        expect(recordedSettlement()?.status).toBe('COMPLETED');
        expect(mockState.decisionSummaries).toEqual(['One risk, owned.']);
    });

    it('a run with no tool to offer sends nothing and settles EMPTY_CATALOGUE', async () => {
        await drive({ tools: [], turns: [{ text: 'done' }] });
        expect(wire.bodies).toEqual([]);
        expect(recordedSettlement()?.status).toBe('EMPTY_CATALOGUE');
    });

    it('a kill found after a model call stops that turn\'s tools from starting', async () => {
        // Engaged during the first call: the loop body's check finds it before
        // the runner runs the turn's tools, so no TOOL_CALL step exists at all.
        await drive(
            { tools: [LIST_RISKS], turns: [], killAfterModelCalls: 1 },
            [{ toolCalls: [{ name: 'list_risks', args: {} }] }, { text: 'done' }],
        );
        expect(wire.bodies).toHaveLength(1);
        expect(mockState.ledger.filter((s) => s.kind === 'TOOL_CALL')).toEqual([]);
        expect(recordedSettlement()?.status).toBe('ABORTED');
        expect(recordedSettlement()?.reason).toMatch(/^tool_runner_run_agent_killed:/);
    });

    it('a kill engaged while a tool runs stops the run before the next model call is sent', async () => {
        // Engaged by the funnel's first answer, after the loop body has checked.
        await drive(
            { tools: [LIST_RISKS], turns: [] },
            [{ toolCalls: [{ name: 'list_risks', args: {} }] }, { text: 'done' }],
        );
        expect(wire.bodies).toHaveLength(2); // control: without the hook, the run goes on
        mockState.killAfterFunnelCalls = null;

        const run = { tools: [LIST_RISKS], turns: [] };
        reset(run, [{ toolCalls: [{ name: 'list_risks', args: {} }] }, { text: 'done' }]);
        mockState.killAfterFunnelCalls = 1;
        const runId = `run-${Math.random().toString(36).slice(2)}`;
        await runToolRunnerDriver(context(), runId, DEFINITION, 0, Date.now());
        expect(mockState.funnelCalls.map((c) => c.name)).toEqual(['list_risks']);
        expect(wire.bodies).toHaveLength(1);
        expect(recordedSettlement()?.status).toBe('ABORTED');
        expect(recordedSettlement()?.reason).toMatch(/^tool_runner_run_agent_killed:/);
    });
});

describe('planning a run refuses before anything is sent', () => {
    const EXTERNAL = { residency: 'EXTERNAL' as const };

    it('refuses a definition that asks for another engine', () => {
        expect(planToolRunnerRun({ ...DEFINITION, driver: 'flue' }, 0, EXTERNAL)).toEqual({
            ok: false,
            reason: 'DEFINITION_ASKED_FOR_ANOTHER_DRIVER',
        });
    });

    it('refuses a run that mounts skills, which this engine does not serve until Step 2d', () => {
        expect(planToolRunnerRun({ ...DEFINITION, skills: ['some-skill'] }, 0, EXTERNAL)).toEqual({
            ok: false,
            reason: 'SKILLS_NOT_SERVED',
        });
    });

    it('refuses a LOCAL_ONLY tenant by name', () => {
        expect(planToolRunnerRun(DEFINITION, 0, { residency: 'LOCAL_ONLY' })).toEqual({
            ok: false,
            reason: 'TOOL_RUNNER_LOCAL_ONLY_UNSERVED',
        });
    });

    it('names every refusal in its own sentence', () => {
        const reasons = [
            'DEFINITION_ASKED_FOR_ANOTHER_DRIVER',
            'NO_STEPS_REMAIN',
            'SKILLS_NOT_SERVED',
            'TOOL_RUNNER_LOCAL_ONLY_UNSERVED',
            'EXTERNAL_CREDENTIAL_NOT_CONFIGURED',
            'SDK_AMBIENT_HEADERS_SET',
        ] as const;
        const sentences = reasons.map(refusalMessage);
        expect(new Set(sentences).size).toBe(reasons.length);
        expect(sentences.filter((sentence) => !sentence.startsWith('tool_runner_'))).toEqual([]);
    });
});
