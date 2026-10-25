/**
 * The Flue engine, held to the driver conformance suite
 * (`tests/helpers/driver-conformance.ts`, Step 0b).
 *
 * ═══ WHAT IS REAL HERE ═══
 *
 * The boot (`ensureFlueRuntime`: the deployment's providers from
 * `buildFlueProviders`, `installFlueTelemetry`, `planFlueStart`, `start` with
 * `InflectAgent`), the driver (`runFlueDriver` → `executeFlueRun`), residency
 * (`planFlueRun` / `resolveFlueModel`), the tool core (`flueToolsFor` →
 * `offerToolSet` → `runGuardedTool`), the AI Guard's scanners and its mode
 * read, the run budget and the Art 12 writer (`recordModelDecision` →
 * `logAiDecision`).
 *
 * The model is a faux core behind each of the two transports the providers are
 * built on. A call that reaches the Anthropic transport is an external model
 * call, which is how the residency scenario counts.
 *
 * ═══ WHAT IS FAKED, AND WHY ONLY THIS ═══
 *
 * This project cannot load `pg`, so every module that reaches the database is
 * replaced by an in-memory fake: the ledger, the run row and its settlement,
 * the kill-switch read, the tenant settings reads, the decision-log insert and
 * the audit append. The funnel is faked at `runReadTool`, and it does the one
 * funnel check a scenario relies on, step 0 of `authorizeToolCall`: a killed
 * agent's call is refused with the error `denyToolCall` throws.
 *
 * The project runs as native ESM (CI passes `--experimental-vm-modules`), so
 * each fake is registered with `jest.unstable_mockModule`, and everything that
 * reaches one is imported after it, dynamically.
 */
import { jest } from '@jest/globals';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

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
    modelCalls: 0,
    ledger: [] as Array<{ kind: string; rec: Record<string, unknown> }>,
    decisionRows: [] as Array<{ inputDigest: string }>,
    funnelCalls: [] as Array<{ name: string; args: unknown }>,
    settlement: null as MockSettlement | null,
};

// The run-settlement fake writes this from inside the driver, where the
// compiler cannot see it, so read it through a call: a direct read after the
// reset to null is narrowed to `null` across the await.
function recordedSettlement(): MockSettlement | null {
    return mockState.settlement;
}

function mockKilled(): boolean {
    return mockState.killAfterModelCalls !== null && mockState.modelCalls >= mockState.killAfterModelCalls;
}

jest.unstable_mockModule('@/env', () => ({
    env: {
        NODE_ENV: 'test',
        ANTHROPIC_API_KEY: 'sk-conformance',
        AGENT_FLUE_MODEL: 'conformance-model',
        AI_LOCAL_BASE_URL: 'http://local-gateway.invalid',
        AI_LOCAL_MODEL: 'conformance-local-model',
    },
}));

jest.unstable_mockModule('@/lib/agentic/kill-switch', () => ({
    KILL_SWITCH_DRILL_AGENT_ID: 'kill-switch-drill',
    killRefusalMessage: (scope: string) => `This agent has been stopped by a ${scope} kill switch.`,
    resolveKillState: jest.fn(async () =>
        mockKilled() ? { scope: 'AGENT', switchId: 'sw-1', engagedAt: new Date('2026-10-25T00:00:00Z') } : null,
    ),
}));

jest.unstable_mockModule('@/lib/observability/integration-metrics', () => ({ recordAgentKillRefusal: jest.fn() }));
jest.unstable_mockModule('@/lib/observability/metrics', () => ({
    recordWorkflowContextIntegrityHalt: jest.fn(),
    recordAiDecisionLogged: jest.fn(),
    recordAiDecisionOutcome: jest.fn(),
    recordAiGuardVerdict: jest.fn(),
}));

jest.unstable_mockModule('@/lib/agentic/drivers/step-recorder', () => ({
    recordStep: jest.fn(async (_ctx: unknown, _runId: string, _seq: number, kind: string, rec: Record<string, unknown>) => {
        mockState.ledger.push({ kind, rec });
    }),
}));

jest.unstable_mockModule('@/lib/agentic/drivers/run-settlement', () => {
    const settle = (status: string, reason: string | null, cap: string | null = null): string => {
        mockState.settlement = { status, reason, cap };
        return status;
    };
    return {
        updateRun: jest.fn(async () => undefined),
        failRun: jest.fn(async (_c: unknown, _r: string, message: string) => settle('FAILED', message)),
        haltRunAtKill: jest.fn(async (_c: unknown, _r: string, _kill: unknown, message: string) => settle('ABORTED', message)),
        haltRunAtCap: jest.fn(async (_c: unknown, _r: string, halt: { kind: string; message: string }) =>
            settle('FAILED', halt.message, halt.kind),
        ),
        haltRunAtGuard: jest.fn(async (_c: unknown, _r: string, worst: string) =>
            settle(worst === 'QUARANTINED' ? 'ABORTED' : 'AWAITING_APPROVAL', `ai_guard_${worst.toLowerCase()}`),
        ),
    };
});

jest.unstable_mockModule('@/lib/agentic/drivers/run-store', () => ({
    getRunRow: jest.fn(async () => ({
        costTokens: mockState.alreadyTokens,
        contextJson: null,
        contextHash: null,
        mountedSkills: [],
    })),
    proposedItemsSoFar: jest.fn(async () => 0),
}));

jest.unstable_mockModule('@/lib/agentic/circuit-breaker-store', () => ({ latchOnGuardBlock: jest.fn(async () => null) }));

jest.unstable_mockModule('@/lib/mcp/auth', () => ({
    resolveMcpInvocation: jest.fn(async (ctx: unknown) => ({
        ctx,
        autonomyCeiling: 6,
        governedAgentId: 'agent-conformance',
        policyCard:
            mockState.toolCallLimit === null ? null : { inForce: { value: { maxActionsPerRun: mockState.toolCallLimit } } },
    })),
}));

jest.unstable_mockModule('@/lib/auth/api-key-auth', () => ({ enforceApiKeyScope: jest.fn() }));

jest.unstable_mockModule('@/lib/mcp/tools/registry', () => ({
    loadableReadTools: jest.fn(() =>
        mockState.tools.map((t) => ({
            name: t.name,
            description: `The ${t.name} tool.`,
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            resourceScope: { resource: t.name, action: 'read' },
            authorize: { basis: 'effective', mirrors: `GET /${t.name}` },
        })),
    ),
    // THE FUNNEL, at its seam. Step 0 of `authorizeToolCall` is kept: a killed
    // agent's call is refused here, as the real funnel refuses it.
    runReadTool: jest.fn(async (_inv: unknown, name: string, args: unknown) => {
        if (mockKilled()) {
            // What `assertNotKilled` throws, through `denyToolCall`.
            const { forbidden } = await import('@/lib/errors/types');
            throw forbidden('This agent has been stopped by a AGENT kill switch.');
        }
        mockState.funnelCalls.push({ name, args });
        const tool = mockState.tools.find((t) => t.name === name);
        return { content: [{ type: 'text', text: tool ? tool.result : '{}' }] };
    }),
}));

jest.unstable_mockModule('@/lib/mcp/tools/propose-tools', () => ({
    loadableProposeTools: jest.fn(() => []),
    runProposeTool: jest.fn(async () => ({ content: [] })),
    isProposeTool: () => false,
    proposedItemCount: () => 0,
}));

jest.unstable_mockModule('@/lib/db/rls-middleware', () => {
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
    return { runInTenantContext: jest.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db)) };
});
// The AI Guard reads its mode here. No row is a tenant that never chose one,
// so the guard runs on its default mode, as it would in production.
jest.unstable_mockModule('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique: async () => null } }),
    ),
}));
jest.unstable_mockModule('@/lib/audit', () => ({ appendAuditEntry: jest.fn(async () => undefined) }));

jest.unstable_mockModule('@/lib/agentic/flue/skills/tenant-mount', () => ({
    resolveRunSkillMount: jest.fn(async () => ({ documents: [], pins: [] })),
}));
jest.unstable_mockModule('@/lib/agentic/subagent-fanout-policy', () => ({ readFanOutCap: jest.fn(async () => 1) }));

// ─── The wire, and nothing above it ─────────────────────────────────
//
// The deployment's real providers are built (`buildFlueProviders`, from the
// env above), and the real boot runs: `installFlueTelemetry`, `planFlueStart`
// and `start`. Only the two transports are replaced, each by a faux core, so
// a call that reaches the Anthropic transport is an external model call.
type FauxCore = ReturnType<typeof createFauxCore>;
const mockWire: { external?: FauxCore; local?: FauxCore } = {};
const streamsOf = (core: FauxCore) => ({
    stream: core.stream,
    streamSimple: core.streamSimple,
    fetchDeferred: core.fetchDeferred,
    cancelDeferred: core.cancelDeferred,
});
jest.unstable_mockModule('@earendil-works/pi-ai/api/anthropic-messages.lazy', () => ({
    anthropicMessagesApi: () => streamsOf(mockWire.external!),
}));
jest.unstable_mockModule('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
    openAICompletionsApi: () => streamsOf(mockWire.local!),
}));

import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import type { ConformanceObservation, ConformanceRun, ScriptedTurn } from '../helpers/driver-conformance';

// Imported AFTER the registrations above. A static import would be evaluated
// before any of them.
const { runFlueDriver } = await import('@/lib/agentic/flue/driver');
const { FLUE_PROVIDER_IDS } = await import('@/lib/agentic/flue/model-selection');
const { runtimeToolNamesFor } = await import('@/lib/agentic/flue/runtime-tools');
const { describeDriverConformance } = await import('../helpers/driver-conformance');

mockWire.external = createFauxCore({ provider: FLUE_PROVIDER_IDS.external, models: [{ id: 'conformance-model' }] });
mockWire.local = createFauxCore({ provider: FLUE_PROVIDER_IDS.local, models: [{ id: 'conformance-local-model' }] });

const DEFINITION = {
    key: 'conformance',
    label: 'Conformance',
    driver: 'flue',
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

/** The tool names a transcript has offered, from its system messages. */
function offeredToolsIn(messages: ReadonlyArray<Record<string, unknown>>): string[] {
    const offered = new Set<string>();
    for (const m of messages) {
        if (m.role !== 'system') continue;
        for (const t of (m.toolsAdded as Array<{ name: string }> | undefined) ?? []) offered.add(t.name);
        for (const t of (m.toolsRemoved as Array<{ name: string }> | undefined) ?? []) offered.delete(t.name);
    }
    return [...offered].sort();
}

async function runOnFlue(run: ConformanceRun): Promise<ConformanceObservation> {
    mockState.tools = [...run.tools];
    mockState.residency = run.residency ?? 'EXTERNAL';
    mockState.alreadyTokens = run.alreadySpent?.tokens ?? 0;
    mockState.toolCallLimit = run.toolCallLimit ?? null;
    mockState.killAfterModelCalls = run.killAfterModelCalls ?? null;
    mockState.modelCalls = 0;
    mockState.ledger = [];
    mockState.decisionRows = [];
    mockState.funnelCalls = [];
    mockState.settlement = null;

    const modelInputs: string[] = [];
    let offeredTools: string[] = [];
    let externalModelCalls = 0;
    const script = (external: boolean) =>
        run.turns.map((turn: ScriptedTurn) => (ctx: { messages: Array<Record<string, unknown>> }) => {
            mockState.modelCalls += 1;
            if (external) externalModelCalls += 1;
            modelInputs.push(JSON.stringify(ctx.messages));
            if (offeredTools.length === 0) offeredTools = offeredToolsIn(ctx.messages);
            return turn.toolCalls
                ? fauxAssistantMessage(turn.toolCalls.map((c) => fauxToolCall(c.name, c.args)))
                : fauxAssistantMessage(turn.text ?? '');
        });
    mockWire.external!.setResponses(script(true) as never);
    mockWire.local!.setResponses(script(false) as never);

    const runId = `run-${Math.random().toString(36).slice(2)}`;
    const startedAt = Date.now() - (run.alreadySpent?.elapsedMs ?? 0);
    const outcome = await runFlueDriver(context(), runId, DEFINITION, 0, startedAt);

    const settlement = recordedSettlement();
    return {
        status: settlement?.status ?? outcome.status,
        haltReason: settlement?.reason ?? null,
        haltedCap: settlement?.cap ?? null,
        modelInputs,
        externalModelCalls,
        ledger: mockState.ledger.map((s) => ({
            kind: s.kind,
            toolCalled: typeof s.rec.toolCalled === 'string' ? s.rec.toolCalled : null,
            decisionDigest:
                typeof (s.rec.input as { decisionDigest?: unknown } | undefined)?.decisionDigest === 'string'
                    ? ((s.rec.input as { decisionDigest: string }).decisionDigest)
                    : null,
            modelCalls:
                typeof (s.rec.input as { modelCalls?: unknown } | undefined)?.modelCalls === 'number'
                    ? ((s.rec.input as { modelCalls: number }).modelCalls)
                    : null,
        })),
        decisionRows: [...mockState.decisionRows],
        funnelCalls: [...mockState.funnelCalls],
        offeredTools,
        reportedEngineTools: runtimeToolNamesFor({ skillsMounted: false }),
    };
}

describeDriverConformance({ engine: 'flue', run: runOnFlue });
