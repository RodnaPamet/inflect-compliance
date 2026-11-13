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
    tools: [] as ConformanceRun['tools'][number][],
    /** Has the workspace acknowledged the external-AI business-data transfer (#3872)? */
    externalAiAcknowledged: false,
    /** The tenant's AI Guard mode, as the guard reads it. `null` is a tenant that never chose one. */
    aiGuardMode: null as 'STRICT' | null,
    residency: 'EXTERNAL' as 'EXTERNAL' | 'LOCAL_ONLY',
    alreadyTokens: 0,
    toolCallLimit: null as number | null,
    killAfterModelCalls: null as number | null,
    /** An operator aborts the run once this many model calls are answered (#5366). */
    abortAfterModelCalls: null as number | null,
    /** Engage the kill once the funnel has answered this many calls: a kill engaged WHILE a tool runs. */
    killAfterFunnelCalls: null as number | null,
    /** Make the kill-switch read throw once this many model calls are answered. */
    killReadFailsAfterModelCalls: null as number | null,
    modelCalls: 0,
    ledger: [] as Array<{ kind: string; rec: Record<string, unknown>; seq?: number }>,
    /** The run's proposals, as the compaction record read returns them (Step 2g). */
    proposals: [] as Array<{ id: string; kind: string; status: string; stepSeq: number | null }>,
    /** Engage the kill switch when a compaction reads the run's record (Step 2g). */
    killOnCompactionRead: false,
    decisionRows: [] as Array<{ inputDigest: string }>,
    decisionInputs: [] as unknown[],
    decisionSummaries: [] as Array<string | null | undefined>,
    funnelCalls: [] as Array<{ name: string; args: unknown }>,
    /** How long the funnel takes per tool, so concurrent calls would finish out of order. */
    funnelDelayMs: {} as Record<string, number>,
    settlement: null as MockSettlement | null,
    updates: [] as Array<Record<string, unknown>>,
    /** What the run's mount is asked for (Step 2d), resolved by the real gate. */
    skills: undefined as ConformanceRun['skills'],
    /** The pins the run's row recorded at admission. */
    pinnedSkills: [] as unknown[],
    /**
     * The organization's tool-call ceiling the turn caps read (#4594), or null
     * for a workspace with no organization: the product default, one.
     */
    orgToolCallsPerTurn: null as number | null,
    /** The organization's delegation ceiling (Step 2e), or null for the product default. */
    orgDelegationsPerTurn: null as number | null,
    /** The agent's circuit breaker reads OPEN once this many model calls are answered (Step 2e). */
    breakerOpenAfterModelCalls: null as number | null,
};

function recordedSettlement(): MockSettlement | null {
    return mockState.settlement;
}

function mockAborted(): boolean {
    return mockState.abortAfterModelCalls !== null && mockState.modelCalls >= mockState.abortAfterModelCalls;
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
        ANTHROPIC_API_KEY: 'sk-ant-conformance', // pragma: allowlist secret -- a placeholder; the faux fetch answers every request
    },
}));

jest.mock('@/lib/agentic/kill-switch', () => ({
    KILL_SWITCH_DRILL_AGENT_ID: 'kill-switch-drill',
    killRefusalMessage: (scope: string) => `This agent has been stopped by a ${scope} kill switch.`,
    resolveKillState: jest.fn(async () => {
        if (mockState.killReadFailsAfterModelCalls !== null && mockState.modelCalls >= mockState.killReadFailsAfterModelCalls) {
            throw new Error('the kill-switch store did not answer');
        }
        return mockKilled() ? { scope: 'AGENT', switchId: 'sw-1', engagedAt: new Date('2026-10-29T00:00:00Z') } : null;
    }),
}));

jest.mock('@/lib/observability/integration-metrics', () => ({ recordAgentKillRefusal: jest.fn() }));
jest.mock('@/lib/observability/metrics', () => ({
    recordWorkflowContextIntegrityHalt: jest.fn(),
    recordAiDecisionLogged: jest.fn(),
    recordAiDecisionOutcome: jest.fn(),
    recordAiGuardVerdict: jest.fn(),
}));

jest.mock('@/lib/agentic/drivers/step-recorder', () => ({
    recordStep: jest.fn(async (_ctx: unknown, _runId: string, seq: number, kind: string, rec: Record<string, unknown>) => {
        mockState.ledger.push({ kind, rec, seq });
    }),
}));

jest.mock('@/lib/agentic/drivers/run-settlement', () => {
    const settle = (status: string, reason: string | null, cap: string | null = null): string => {
        mockState.settlement = { status, reason, cap };
        return status;
    };
    return {
        // As the real one does (#5366): a write that settles does not land on
        // a row an operator aborted, and says so.
        updateRun: jest.fn(async (_c: unknown, _r: string, data: Record<string, unknown>) => {
            mockState.updates.push(data);
            if (typeof data.status === 'string') {
                if (mockAborted()) return false;
                settle(data.status, typeof data.errorMessage === 'string' ? data.errorMessage : null);
            }
            return true;
        }),
        isRunAborted: jest.fn(async () => mockAborted()),
        failRun: jest.fn(async (_c: unknown, _r: string, message: string) => settle('FAILED', message)),
        haltRunAtKill: jest.fn(async (_c: unknown, _r: string, _kill: unknown, message: string, _beside: unknown, prefix?: string) =>
            settle('ABORTED', `${prefix ?? 'flue'}_run_agent_killed: ${message}`),
        ),
        haltRunAtCap: jest.fn(async (_c: unknown, _r: string, halt: { kind: string; message: string }) =>
            settle('FAILED', halt.message, halt.kind),
        ),
        haltRunAtGuard: jest.fn(async (_c: unknown, _r: string, worst: string, _ruleIds?: unknown, _prefix?: string) =>
            settle(worst === 'QUARANTINED' ? 'ABORTED' : 'AWAITING_APPROVAL', `ai_guard_${worst.toLowerCase()}`),
        ),
    };
});

// No run here was parked on a deferred call (Step 2f): every segment opens afresh.
jest.mock('@/lib/agentic/drivers/deferral-store', () => ({
    readDecidedDeferral: jest.fn(async () => null),
    readDeferredProposal: jest.fn(async () => null),
    markDeferralResumedInTx: jest.fn(() => async () => undefined),
}));
jest.mock('@/lib/agentic/drivers/run-store', () => ({
    getRunRow: jest.fn(async () => ({
        costTokens: mockState.alreadyTokens,
        contextJson: null,
        contextHash: null,
        mountedSkills: mockState.pinnedSkills,
    })),
    proposedItemsSoFar: jest.fn(async () => 0),
    // The ledger the fakes recorded, as the database would return it (Step 2g).
    readCompactionRecord: jest.fn(async (_ctx: unknown, _runId: string, fromSeq: number) => {
        if (mockState.killOnCompactionRead) mockState.killAfterModelCalls = 0;
        return {
            complete: true,
            steps: mockState.ledger
                .filter((s) => (s.seq ?? -1) >= fromSeq)
                .map((s) => ({
                    seq: s.seq ?? -1,
                    kind: s.kind,
                    toolCalled: typeof s.rec.toolCalled === 'string' ? s.rec.toolCalled : null,
                    status: String(s.rec.status),
                    subagentName: typeof s.rec.subagent === 'string' ? s.rec.subagent : null,
                    guardVerdict: typeof s.rec.guardVerdict === 'string' ? s.rec.guardVerdict : null,
                    inputJson: s.rec.input === undefined ? null : JSON.stringify(s.rec.input),
                    outputJson: s.rec.output === undefined ? null : JSON.stringify(s.rec.output),
                })),
            proposals: [...mockState.proposals],
        };
    }),
}));

// THE DATABASE READ of the skill mount, and nothing else (Step 2d): the run's
// skills go through the real resolver and mount gate.
jest.mock('@/lib/agentic/flue/skills/tenant-mount', () => ({
    resolveRunSkillMount: jest.fn(async () => {
        const { conformanceSkillMount } = jest.requireActual('../../helpers/driver-conformance-skills') as typeof import('../../helpers/driver-conformance-skills');
        return conformanceSkillMount(mockState.skills);
    }),
}));

jest.mock('@/lib/agentic/circuit-breaker-store', () => ({
    latchOnGuardBlock: jest.fn(async () => null),
    // Read before every model call in both loops (Step 2e, owner decision 4).
    readBreakerLatch: jest.fn(async () => (mockState.breakerOpenAfterModelCalls !== null && mockState.modelCalls >= mockState.breakerOpenAfterModelCalls ? { state: 'OPEN' } : null)),
}));

// THE TURN CAPS' READ (#4594), and nothing else: the resolver is the real one.
jest.mock('@/lib/agentic/turn-caps-policy', () => ({
    readTurnCaps: jest.fn(async () => {
        const { resolveTurnCaps } = jest.requireActual('@/lib/agentic/turn-caps') as typeof import('@/lib/agentic/turn-caps');
        return resolveTurnCaps({
            organization:
                mockState.orgToolCallsPerTurn === null && mockState.orgDelegationsPerTurn === null
                    ? null
                    : {
                          delegationsPerTurn: mockState.orgDelegationsPerTurn ?? 3,
                          toolCallsPerTurn: mockState.orgToolCallsPerTurn ?? 1,
                      },
            workspace: null,
        });
    }),
}));

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
            ...(t.externalConnection
                ? {
                      externalConnection: {
                          connectionId: `conn-${t.externalConnection.name}`,
                          connectionName: t.externalConnection.name,
                          declaresWrite: false,
                          connectionRefusesWrites: false,
                          reachesBusinessSystem: t.externalConnection.reachesBusinessSystem,
                      },
                  }
                : {}),
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
            findUnique: async () => ({
                aiResidency: mockState.residency,
                aiLocalBaseUrl: null,
                aiLocalModel: null,
                externalAiBusinessDataAckAt: mockState.externalAiAcknowledged ? new Date('2026-11-01T00:00:00Z') : null,
                externalAiBusinessDataAckByUserId: mockState.externalAiAcknowledged ? 'user-conformance' : null,
            }),
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
        fn({
            tenantSecuritySettings: {
                findUnique: async () => (mockState.aiGuardMode ? { aiGuardMode: mockState.aiGuardMode } : null),
            },
        }),
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
import { KILL_UNREADABLE_MESSAGE } from '@/lib/agentic/tool-runner/execute';
import { latchOnGuardBlock } from '@/lib/agentic/circuit-breaker-store';
import { haltRunAtGuard } from '@/lib/agentic/drivers/run-settlement';
import { ENGINE_CAPS } from '@/lib/agentic/workflow-types';
import {
    describeDriverConformance,
    describeSubagentConformance,
    MOUNTABLE_REPOSITORY_SKILL,
    type SubagentConformanceObservation,
    type SubagentConformanceRun,
} from '../../helpers/driver-conformance';
import { delegationSpans } from '@/lib/agentic/delegation-spans';
import { projectRunSteps } from '@/lib/agentic/run-step-projection';
import { BREAKER_OPEN_MESSAGE } from '@/lib/agentic/tool-runner/execute';
import { subagentGuardSource } from '@/lib/agentic/tool-runner/tools';
import type { ProfileSubagent } from '@/lib/agentic/agent-profile';
import { conformanceSkillMount } from '../../helpers/driver-conformance-skills';
import { pinForRow } from '@/lib/agentic/flue/skills/mount-gate';
import { toolRunnerSuppliedToolNamesFor } from '@/lib/agentic/tool-runner/supplied-tools';
import { catalogBytes, loadSkill, loadSkillCorpus, MAX_CATALOG_BYTES } from '@/lib/agentic/flue/skills';
import { skillContentHash } from '@/lib/agentic/flue/skills/evaluation-record';
import { TOOL_RUNNER_PREAMBLE } from '@/lib/agentic/tool-runner/params';
import { SKILL_CATALOGUE_CLOSE, SKILL_CATALOGUE_OPEN } from '@/lib/agentic/tool-runner/skills';
import { createHash } from 'crypto';
import { COMPACTION_INSTRUCTION, COMPACTION_SUMMARY_MAX_TOKENS } from '@/lib/agentic/tool-runner/params';
import { RUN_STATE_CLOSE, RUN_STATE_OPEN, RUN_SUMMARY_OPEN, runSummaryText } from '@/lib/agentic/tool-runner/compaction';

// ─── The wire ───────────────────────────────────────────────────────

/** A turn as the faux model answers it: the conformance script, or raw content for a hardening case. */
type FauxTurn =
    | ScriptedTurn
    | {
          readonly raw: {
              content: unknown[];
              stop_reason: string;
              /** A usage figure for this one reply (Step 2g): the compaction trigger reads it. */
              usage?: { input_tokens: number; output_tokens: number };
          };
      };

const wire = {
    turns: [] as FauxTurn[],
    bodies: [] as Array<Record<string, unknown>>,
    urls: [] as string[],
};

const originalFetch = global.fetch;

function fauxResponse(turn: FauxTurn | undefined, n: number): { content: unknown[]; stop_reason: string; usage?: unknown } {
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

/** The pins admission would have recorded for this mount, or none when the gate refuses it. */
function pinsAdmissionRecords(skills: ConformanceRun['skills']): unknown[] {
    try {
        return conformanceSkillMount(skills).pins.map(pinForRow);
    } catch {
        return [];
    }
}

function reset(
    run: Pick<
        ConformanceRun,
        | 'tools'
        | 'residency'
        | 'alreadySpent'
        | 'toolCallLimit'
        | 'killAfterModelCalls'
        | 'abortAfterModelCalls'
        | 'skills'
        | 'externalAiAcknowledged'
    >,
    turns: readonly FauxTurn[],
): void {
    mockState.skills = run.skills;
    mockState.externalAiAcknowledged = run.externalAiAcknowledged === true;
    mockState.aiGuardMode = null;
    mockState.pinnedSkills = pinsAdmissionRecords(run.skills);
    mockState.tools = [...run.tools];
    mockState.residency = run.residency ?? 'EXTERNAL';
    mockState.alreadyTokens = run.alreadySpent?.tokens ?? 0;
    mockState.toolCallLimit = run.toolCallLimit ?? null;
    mockState.killAfterModelCalls = run.killAfterModelCalls ?? null;
    mockState.abortAfterModelCalls = run.abortAfterModelCalls ?? null;
    mockState.killAfterFunnelCalls = null;
    mockState.killReadFailsAfterModelCalls = null;
    mockState.modelCalls = 0;
    mockState.ledger = [];
    mockState.proposals = [];
    mockState.killOnCompactionRead = false;
    mockState.decisionRows = [];
    mockState.decisionInputs = [];
    mockState.decisionSummaries = [];
    mockState.funnelCalls = [];
    mockState.funnelDelayMs = {};
    mockState.orgToolCallsPerTurn = null;
    mockState.breakerOpenAfterModelCalls = null;
    mockState.orgDelegationsPerTurn = null;
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
    orgToolCallsPerTurn: number | null = null,
) {
    reset(run, turns);
    mockState.funnelDelayMs = { ...funnelDelayMs };
    mockState.orgToolCallsPerTurn = orgToolCallsPerTurn;
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
        // The engine's own tools, as it reports them to the register (Step 2d).
        reportedEngineTools: toolRunnerSuppliedToolNamesFor({ skillsMounted: (run.skills?.repository?.length ?? 0) + (run.skills?.tenant?.length ?? 0) > 0 }),
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
        // concurrent dispatch would finish, and record, them in reverse. The
        // organization allows three calls a turn (#4594), so none is refused
        // and the request asks for them in parallel: dispatch stays serial.
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
            3,
        );
        expect(wire.bodies[0].tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: false });
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

    it('a kill switch that cannot be read stops the run: it fails closed, before that turn\'s tools', async () => {
        const run = { tools: [LIST_RISKS], turns: [] };
        reset(run, [{ toolCalls: [{ name: 'list_risks', args: {} }] }, { text: 'done' }]);
        mockState.killReadFailsAfterModelCalls = 1;
        await runToolRunnerDriver(context(), `run-${Math.random().toString(36).slice(2)}`, DEFINITION, 0, Date.now());
        expect(wire.bodies).toHaveLength(1);
        expect(mockState.funnelCalls).toEqual([]);
        expect(recordedSettlement()).toEqual({ status: 'FAILED', reason: KILL_UNREADABLE_MESSAGE, cap: null });
    });
});

describe('tool calls per turn (#4594): the cap the organization and the workspace set', () => {
    const TWO_IN_ONE_TURN: readonly FauxTurn[] = [
        { toolCalls: [{ name: 'list_risks', args: {} }, { name: 'list_controls', args: {} }] },
        { text: 'done' },
    ];

    it('at a cap of one, a turn asking for two runs the first and refuses the second, named and recorded', async () => {
        await drive({ tools: [LIST_RISKS, LIST_CONTROLS], turns: [] }, TWO_IN_ONE_TURN);

        // The request asked for one call: today's request, byte for byte.
        expect(JSON.stringify(wire.bodies[0].tool_choice)).toBe('{"type":"auto","disable_parallel_tool_use":true}');
        // The funnel was asked once; the second call never reached it.
        expect(mockState.funnelCalls.map((c) => c.name)).toEqual(['list_risks']);
        const toolSteps = mockState.ledger.filter((s) => s.kind === 'TOOL_CALL').map((s) => s.rec);
        expect(toolSteps).toHaveLength(2);
        expect(toolSteps[0]).toMatchObject({ toolCalled: 'list_risks', status: 'DONE' });
        expect(toolSteps[1]).toMatchObject({
            toolCalled: 'list_controls',
            status: 'FAILED',
            output: { refused: 'TOOL_CALLS_PER_TURN_EXCEEDED', cap: 1, madeThisTurn: 1 },
        });
        // The model read why, as the second call's tool error, in the next request.
        const followUp = JSON.stringify(wire.bodies[1].messages);
        expect(followUp).toContain('tool_calls_per_turn_exceeded: this turn has already made 1 tool call');
        // A refusal is the model's to work around; the run carries on and completes.
        expect(recordedSettlement()?.status).toBe('COMPLETED');
    });

    it('at a cap of two, both calls of the turn run, and the request lets the model ask for both', async () => {
        await drive({ tools: [LIST_RISKS, LIST_CONTROLS], turns: [] }, TWO_IN_ONE_TURN, DEFINITION, {}, 2);

        expect(wire.bodies[0].tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: false });
        expect(mockState.funnelCalls.map((c) => c.name)).toEqual(['list_risks', 'list_controls']);
        const toolSteps = mockState.ledger.filter((s) => s.kind === 'TOOL_CALL').map((s) => s.rec);
        expect(toolSteps.map((r) => [r.toolCalled, r.status])).toEqual([
            ['list_risks', 'DONE'],
            ['list_controls', 'DONE'],
        ]);
        expect(recordedSettlement()?.status).toBe('COMPLETED');
    });

    it('the count is per turn: a cap of one admits one call in each of two turns', async () => {
        await drive({ tools: [LIST_RISKS, LIST_CONTROLS], turns: [] }, [
            { toolCalls: [{ name: 'list_risks', args: {} }] },
            { toolCalls: [{ name: 'list_controls', args: {} }] },
            { text: 'done' },
        ]);
        expect(mockState.funnelCalls.map((c) => c.name)).toEqual(['list_risks', 'list_controls']);
        expect(mockState.ledger.filter((s) => s.kind === 'TOOL_CALL').every((s) => s.rec.status === 'DONE')).toBe(true);
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

    it('plans a run that mounts skills, which this engine serves since Step 2d', () => {
        expect(planToolRunnerRun({ ...DEFINITION, skills: ['some-skill'] }, 0, EXTERNAL)).toMatchObject({ ok: true });
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
            'TOOL_RUNNER_LOCAL_ONLY_UNSERVED',
            'EXTERNAL_CREDENTIAL_NOT_CONFIGURED',
            'SDK_AMBIENT_HEADERS_SET',
        ] as const;
        const sentences = reasons.map(refusalMessage);
        expect(new Set(sentences).size).toBe(reasons.length);
        expect(sentences.filter((sentence) => !sentence.startsWith('tool_runner_'))).toEqual([]);
    });
});

// ─── Step 2d: skills on the Tool Runner engine ──────────────────────

interface ToolResultBlock {
    type: 'tool_result';
    tool_use_id: string;
    content: unknown;
    is_error?: boolean;
}

/** Every tool result one request carried, in order. */
function toolResultsOf(body: Record<string, unknown> | undefined): ToolResultBlock[] {
    const messages = (body?.messages ?? []) as Array<{ role: string; content: unknown }>;
    return messages.flatMap((m) =>
        Array.isArray(m.content) ? (m.content as Array<{ type?: string }>).filter((b): b is ToolResultBlock => b.type === 'tool_result') : [],
    );
}

const systemTextOf = (body: Record<string, unknown> | undefined): string =>
    ((body?.system ?? []) as Array<{ text: string }>).map((b) => b.text).join('\n');

describe('Step 2d: skills on the Tool Runner engine', () => {
    const SKILL = loadSkill(MOUNTABLE_REPOSITORY_SKILL);
    const activate = (name: string): ScriptedTurn => ({ toolCalls: [{ name: 'activate_skill', args: { name } }] });

    it('puts the catalogue after the preamble, offers activate_skill, and returns the pinned instructions', async () => {
        const run: ConformanceRun = {
            tools: [LIST_RISKS],
            turns: [activate(SKILL.name), { text: 'done' }],
            skills: { repository: [SKILL.name] },
        };
        const outcome = await drive(run);
        expect(outcome.status).toBe('COMPLETED');
        expect(wire.bodies).toHaveLength(2);

        // The catalogue: one line per mounted skill, the line the budget measures,
        // fenced, after the preamble.
        const system = systemTextOf(wire.bodies[0]);
        expect(system.startsWith(TOOL_RUNNER_PREAMBLE)).toBe(true);
        expect(system).toContain(`${SKILL_CATALOGUE_OPEN}\n${SKILL.name}: ${SKILL.description}\n${SKILL_CATALOGUE_CLOSE}`);

        // The tool: offered beside the resolved set, naming only mounted skills.
        const tools = wire.bodies[0]?.tools as Array<{ name: string; input_schema: { properties: { name: { enum: string[] } } } }>;
        expect(tools.map((t) => t.name)).toEqual(['list_risks', 'activate_skill']);
        expect(tools[1].input_schema.properties.name.enum).toEqual([SKILL.name]);

        // The answer: the instructions, labelled with the pin the row recorded.
        const [result] = toolResultsOf(wire.bodies[1]);
        expect(result.is_error).toBeUndefined();
        expect(result.content).toBe(
            `<skill name="${SKILL.name}" version="${SKILL.metadata.version}" content_hash="${skillContentHash(SKILL.instructions)}">\n${SKILL.instructions}\n</skill>`,
        );

        // In the ledger as a TOOL_CALL step naming the pin; never a funnel call.
        const activation = mockState.ledger.find((s) => s.rec.toolCalled === 'activate_skill');
        expect(activation).toMatchObject({
            kind: 'TOOL_CALL',
            rec: { status: 'DONE', input: { name: SKILL.name, contentHash: skillContentHash(SKILL.instructions) } },
        });
        expect(mockState.funnelCalls).toEqual([]);
    });

    it('answers a name this run did not mount with an error naming the reason, and returns no skill text', async () => {
        const outcome = await drive({
            tools: [LIST_RISKS],
            // Another shipped skill, and a name nobody mounted: neither is in this run.
            turns: [activate('soa-authoring'), activate('another-tenants-skill'), { text: 'done' }],
            skills: { repository: [SKILL.name] },
        });
        expect(outcome.status).toBe('COMPLETED');
        expect(wire.bodies).toHaveLength(3);
        const results = [...toolResultsOf(wire.bodies[1]).slice(-1), ...toolResultsOf(wire.bodies[2]).slice(-1)];
        expect(results.map((r) => ({ isError: r.is_error, content: String(r.content) }))).toEqual([
            { isError: true, content: expect.stringContaining('skill_not_mounted') },
            { isError: true, content: expect.stringContaining('skill_not_mounted') },
        ]);
        // Not the other shipped skill's text, not the name the model sent back.
        const soa = loadSkill('soa-authoring');
        expect(JSON.stringify(wire.bodies)).not.toContain(soa.instructions.slice(0, 80));
        expect(mockState.ledger.filter((s) => s.rec.toolCalled === 'activate_skill').map((s) => s.rec.output)).toEqual([
            { refused: 'SKILL_NOT_MOUNTED' },
            { refused: 'SKILL_NOT_MOUNTED' },
        ]);
    });

    it('a run that mounts no skill gets no catalogue and no activate_skill', async () => {
        await drive({ tools: [LIST_RISKS], turns: [{ text: 'done' }] });
        expect(wire.bodies).toHaveLength(1);
        expect(systemTextOf(wire.bodies[0])).not.toContain(SKILL_CATALOGUE_OPEN);
        expect((wire.bodies[0]?.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['list_risks']);
    });

    it('a mount that no longer matches the pins the row recorded stops the run before any model call', async () => {
        const run: ConformanceRun = { tools: [LIST_RISKS], turns: [{ text: 'done' }], skills: { repository: [SKILL.name] } };
        reset(run, run.turns);
        // Admission pinned a different text than this segment would mount.
        mockState.pinnedSkills = [{ name: SKILL.name, version: SKILL.metadata.version, contentHash: `sha256:${'0'.repeat(64)}` }];
        const outcome = await runToolRunnerDriver(context(), 'run-drift', DEFINITION, 0, Date.now());
        expect(outcome.status).toBe('FAILED');
        expect(recordedSettlement()?.reason).toMatch(/^skill_pin_drift: .*nhi-ownership-attribution/);
        expect(wire.bodies).toHaveLength(0);
    });

    it('a mount whose catalogue is over the per-run budget stops the run before any model call', async () => {
        // Every shipped skill together is over 2 KiB of catalogue.
        const everySkill = loadSkillCorpus().skills.map((s) => s.name);
        expect(catalogBytes(loadSkillCorpus().skills)).toBeGreaterThan(MAX_CATALOG_BYTES);
        const outcome = await drive({ tools: [LIST_RISKS], turns: [{ text: 'done' }], skills: { repository: everySkill } });
        expect(outcome.status).toBe('FAILED');
        expect(recordedSettlement()?.reason).toMatch(/^skill_not_mountable: .*over the 2048 budget/);
        expect(wire.bodies).toHaveLength(0);
    });
});

// ─── What went over the wire, on each MODEL_CALL step (2H evidence on the run page) ──

describe('each MODEL_CALL step records its request by shape', () => {
    it('names the path and the body keys, says no thread member was sent, and carries no value', async () => {
        await drive({ tools: [LIST_RISKS], turns: [{ toolCalls: [{ name: 'list_risks', args: {} }] }, { text: 'done' }] });
        const modelSteps = mockState.ledger.filter((s) => s.kind === 'MODEL_CALL');
        // Positive control: two calls were made, so there are two shapes to read.
        expect(modelSteps).toHaveLength(2);
        for (const step of modelSteps) {
            const wire = (step.rec.input as { wire?: unknown }).wire;
            expect(wire).toEqual({
                method: 'POST',
                path: '/v1/messages',
                bodyKeys: expect.arrayContaining(['messages', 'model', 'system', 'tools']),
                threadMember: 'absent',
            });
            expect((wire as { bodyKeys: string[] }).bodyKeys).not.toContain('thread');
        }
        // Names only: the system prompt went out, and is in no step's wire record.
        const sentSystem = JSON.stringify(wire0System());
        expect(sentSystem).toContain('Inflect, a compliance platform');
        expect(JSON.stringify(modelSteps.map((s) => (s.rec.input as { wire?: unknown }).wire))).not.toContain('Inflect, a compliance platform');
    });
});

function wire0System(): unknown {
    return wire.bodies[0]?.system;
}

// ─── #5372: a resumed run's specification, and the guard before the caps ──

describe('a resumed run is handed its whole specification (#5372)', () => {
    const TWO_STEPS = {
        ...DEFINITION,
        steps: [
            { kind: 'READ', tool: 'list_risks', label: 'Read the risks' },
            { kind: 'SYNTHESIS', label: 'Say what you found' },
        ],
    } as unknown as WorkflowDefinition;

    it.each([1, 2, 7])('resumed at ledger seq %i, the first request still lists every declared step', async (fromSeq) => {
        // `fromSeq` counts ledger rows (model and tool calls), not declared
        // steps: a run that made seven calls has not covered seven steps of a
        // two-step specification.
        reset({ tools: [LIST_RISKS] }, [{ text: 'done' }]);
        await runToolRunnerDriver(context(), `run-${Math.random().toString(36).slice(2)}`, TWO_STEPS, fromSeq, Date.now());
        expect(wire.bodies).toHaveLength(1);
        const sent = JSON.stringify(wire.bodies[0].messages);
        expect(sent).toContain('1. [READ] Read the risks');
        expect(sent).toContain('2. [SYNTHESIS] Say what you found');
    });
});

describe('a model answer\'s guard verdict is noted before the caps are charged (#5372)', () => {
    const SECRET_REPLY = 'Here is the key: AKIAIOSFODNN7EXAMPLE'; // pragma: allowlist secret

    beforeEach(() => {
        jest.mocked(latchOnGuardBlock).mockClear();
    });

    it('a QUARANTINED answer that also crosses the token cap settles at the guard, and latches the breaker', async () => {
        reset({ tools: [LIST_RISKS], alreadySpent: { tokens: ENGINE_CAPS.MAX_TOKENS - 1 } }, [{ text: SECRET_REPLY }]);
        mockState.aiGuardMode = 'STRICT';
        await runToolRunnerDriver(context(), `run-${Math.random().toString(36).slice(2)}`, DEFINITION, 0, Date.now());
        expect(wire.bodies).toHaveLength(1);
        expect(recordedSettlement()).toEqual({ status: 'ABORTED', reason: 'ai_guard_quarantined', cap: null });
        expect(latchOnGuardBlock).toHaveBeenCalledTimes(1);
        // Settled under this engine's own name, not Flue's.
        expect(jest.mocked(haltRunAtGuard).mock.calls.at(-1)?.[4]).toBe('tool_runner');
    });

    it('a QUARANTINED answer that also crosses the wall clock settles at the guard', async () => {
        // The clock is charged after the call returns. Started just inside
        // the cap, the call itself carries the run over it.
        reset({ tools: [LIST_RISKS] }, [{ text: SECRET_REPLY }]);
        mockState.aiGuardMode = 'STRICT';
        const start = Date.now();
        // Inside the cap until the model has answered, past it afterwards.
        jest.spyOn(Date, 'now').mockImplementation(() => (mockState.modelCalls > 0 ? start + ENGINE_CAPS.WALL_CLOCK_MS + 1 : start));
        try {
            await runToolRunnerDriver(context(), `run-${Math.random().toString(36).slice(2)}`, DEFINITION, 0, start);
        } finally {
            jest.mocked(Date.now).mockRestore();
        }
        expect(wire.bodies).toHaveLength(1);
        expect(recordedSettlement()).toEqual({ status: 'ABORTED', reason: 'ai_guard_quarantined', cap: null });
        expect(latchOnGuardBlock).toHaveBeenCalledTimes(1);
    });

    it('a CLEAN answer that crosses the token cap still settles at the cap (positive control)', async () => {
        reset({ tools: [LIST_RISKS], alreadySpent: { tokens: ENGINE_CAPS.MAX_TOKENS - 1 } }, [{ text: 'One risk, owned.' }]);
        mockState.aiGuardMode = 'STRICT';
        await runToolRunnerDriver(context(), `run-${Math.random().toString(36).slice(2)}`, DEFINITION, 0, Date.now());
        expect(recordedSettlement()?.cap).toBe('TOKENS');
        expect(latchOnGuardBlock).not.toHaveBeenCalled();
    });
});

// ─── Step 2e: inline sub-agents ─────────────────────────────────────

/** A profile version run, read-only, carrying the sub-agents given. */
function profileDef(subagents: readonly ProfileSubagent[], toolNames: readonly string[]): WorkflowDefinition {
    return {
        ...DEFINITION,
        key: 'agent-profile:p1@v1:test-run',
        profile: {
            profileId: 'p1',
            agentId: 'agent-conformance',
            versionId: 'v1',
            version: 1,
            instructions: 'Answer the question, delegating where a sub-agent fits.',
            instructionsHash: 'h',
            toolNames: [...toolNames],
            skillRefs: [],
            modelTier: 'balanced',
            effort: 'medium',
            maxTurns: 10,
            outputKind: 'ANSWER_ONLY',
            allowedTriggers: ['TEST_RUN'],
            ...(subagents.length > 0 ? { subagents } : {}),
        },
    } as unknown as WorkflowDefinition;
}

const sub = (name: string, toolNames: readonly string[], over: Partial<ProfileSubagent> = {}): ProfileSubagent => ({
    name,
    instructions: `You are ${name}. Use your tools and answer briefly.`,
    toolNames: [...toolNames],
    skillRefs: [],
    maxTurns: 5,
    ...over,
});

interface DriveOpts {
    fromSeq?: number;
    orgDelegationsPerTurn?: number | null;
    orgToolCallsPerTurn?: number | null;
    killAfterFunnelCalls?: number | null;
    breakerOpenAfterModelCalls?: number | null;
}

async function driveProfile(run: ConformanceRun, def: WorkflowDefinition, opts: DriveOpts = {}) {
    reset(run, run.turns);
    mockState.orgDelegationsPerTurn = opts.orgDelegationsPerTurn ?? null;
    mockState.orgToolCallsPerTurn = opts.orgToolCallsPerTurn ?? null;
    mockState.killAfterFunnelCalls = opts.killAfterFunnelCalls ?? null;
    mockState.breakerOpenAfterModelCalls = opts.breakerOpenAfterModelCalls ?? null;
    return runToolRunnerDriver(context(), `run-${Math.random().toString(36).slice(2)}`, def, opts.fromSeq ?? 0, Date.now());
}

/** The ledger, with whose step each was and what refused it. */
function ledgerSteps() {
    return mockState.ledger.map((s) => {
        const output = s.rec.output as { refused?: unknown } | undefined;
        return {
            kind: s.kind,
            toolCalled: typeof s.rec.toolCalled === 'string' ? s.rec.toolCalled : null,
            status: String(s.rec.status),
            subagent: typeof s.rec.subagent === 'string' ? s.rec.subagent : null,
            refused: typeof output?.refused === 'string' ? output.refused : null,
        };
    });
}

const requestTools = () => wire.bodies.map((b) => ((b.tools as Array<{ name: string }> | undefined) ?? []).map((t) => t.name).sort());

async function runSubagentsOnToolRunner(run: SubagentConformanceRun): Promise<SubagentConformanceObservation> {
    const versionTools = run.versionTools ?? run.tools.map((t) => t.name);
    const def = profileDef(
        run.subagents.map((s) => sub(s.name, s.toolNames, { ...(s.instructions ? { instructions: s.instructions } : {}), ...(s.maxTurns ? { maxTurns: s.maxTurns } : {}) })),
        versionTools,
    );
    const outcome = await driveProfile(run, def);
    const settlement = recordedSettlement();
    return {
        status: settlement?.status ?? outcome.status,
        haltReason: settlement?.status === 'COMPLETED' ? null : (settlement?.reason ?? null),
        haltedCap: settlement?.cap ?? null,
        modelInputs: wire.bodies.map((b) => JSON.stringify(b.messages)),
        externalModelCalls: wire.urls.filter((u) => new URL(u).origin === 'https://api.anthropic.com').length,
        ledger: mockState.ledger.map((s) => ({
            kind: s.kind,
            toolCalled: typeof s.rec.toolCalled === 'string' ? s.rec.toolCalled : null,
            decisionDigest: null,
            modelCalls: null,
        })),
        decisionRows: [...mockState.decisionRows],
        funnelCalls: [...mockState.funnelCalls],
        offeredTools: requestTools()[0] ?? [],
        reportedEngineTools: toolRunnerSuppliedToolNamesFor({ skillsMounted: false, subagentsDefined: run.subagents.length > 0 }),
        steps: ledgerSteps(),
        requestTools: requestTools(),
    };
}

describeSubagentConformance({ engine: 'tool-runner', run: runSubagentsOnToolRunner });

const delegate = (subagent: string, task = 'List the open risks.') => ({ toolCalls: [{ name: 'delegate', args: { subagent, task } }] });
const call = (name: string) => ({ toolCalls: [{ name, args: {} }] });

describe('Step 2e: inline sub-agents on the Tool Runner engine', () => {
    it('a delegation runs the child under its own instructions and subset, labels every child step, and closes the span with its marker', async () => {
        const def = profileDef([sub('risk_reader', ['list_risks'])], ['list_risks', 'list_controls']);
        reset({ tools: [LIST_RISKS, LIST_CONTROLS] }, [delegate('risk_reader'), call('list_risks'), { text: 'One risk: r1.' }, { text: 'done' }]);
        await runToolRunnerDriver(context(), 'run-sub', def, 0, Date.now());

        expect(recordedSettlement()?.status).toBe('COMPLETED');
        expect(wire.bodies).toHaveLength(4);
        // The child's request: its own instructions, the task, its subset.
        const childSystem = systemTextOf(wire.bodies[1]);
        expect(childSystem).toContain('You are risk_reader.');
        expect(childSystem).not.toContain('Answer the question, delegating');
        expect(JSON.stringify(wire.bodies[1].messages)).toContain('List the open risks.');
        expect(requestTools()[1]).toEqual(['list_risks']);
        // The parent's description lists the names and nothing of the child's text.
        const delegateDef = (wire.bodies[0].tools as Array<{ name: string; description: string }>).find((t) => t.name === 'delegate');
        expect(delegateDef?.description).toContain('risk_reader');
        expect(delegateDef?.description).not.toContain('Use your tools and answer briefly');

        expect(ledgerSteps()).toEqual([
            { kind: 'MODEL_CALL', toolCalled: null, status: 'DONE', subagent: null, refused: null },
            { kind: 'MODEL_CALL', toolCalled: null, status: 'DONE', subagent: 'risk_reader', refused: null },
            { kind: 'TOOL_CALL', toolCalled: 'list_risks', status: 'DONE', subagent: 'risk_reader', refused: null },
            { kind: 'MODEL_CALL', toolCalled: null, status: 'DONE', subagent: 'risk_reader', refused: null },
            { kind: 'TOOL_CALL', toolCalled: 'delegate', status: 'DONE', subagent: null, refused: null },
            { kind: 'MODEL_CALL', toolCalled: null, status: 'DONE', subagent: null, refused: null },
        ]);
        // The marker carries the span and never the task or the answer.
        const marker = mockState.ledger[4].rec;
        expect(marker.input).toMatchObject({ agent: 'risk_reader', taskId: 'toolu_0_0', fromSeq: 0 });
        expect(JSON.stringify(marker)).not.toContain('List the open risks.');
        expect(JSON.stringify(marker)).not.toContain('One risk: r1.');
        expect(marker.output).toEqual({ outcome: 'answered', modelCalls: 2, toolCalls: 1 });
        // The run page groups the child's steps under the delegation.
        const rows = projectRunSteps(
            undefined,
            mockState.ledger.map((s, seq) => ({
                id: `s${seq}`,
                seq,
                kind: s.kind,
                status: String(s.rec.status),
                toolCalled: typeof s.rec.toolCalled === 'string' ? s.rec.toolCalled : null,
                inputJson: s.rec.input === undefined ? null : JSON.stringify(s.rec.input),
                outputJson: null,
                guardVerdict: null,
                guardRuleIds: [],
                costTokens: null,
                at: new Date(),
                actorUserId: null,
                subagentName: typeof s.rec.subagent === 'string' ? s.rec.subagent : null,
            })),
            [],
        );
        const spans = delegationSpans(rows);
        expect(spans.map((sp) => ({ agent: sp.agent, steps: sp.steps.map((r) => r.seq) }))).toEqual([
            { agent: 'risk_reader', steps: [1, 2, 3] },
        ]);
        expect(rows.map((r) => r.subagent)).toEqual([null, 'risk_reader', 'risk_reader', 'risk_reader', null, null]);
        // The child's tool call ran under the sub-agent's guard source, over the parent's invocation.
        expect(mockState.funnelCalls.map((c) => c.name)).toEqual(['list_risks']);
        expect(subagentGuardSource('risk_reader')).toBe('tool-runner-subagent.risk_reader');
    });

    it('a version without sub-agents is offered no delegate, and its request is unchanged', async () => {
        await driveProfile({ tools: [LIST_RISKS], turns: [{ text: 'done' }] }, profileDef([], ['list_risks']));
        expect(requestTools()[0]).toEqual(['list_risks']);
        expect(systemTextOf(wire.bodies[0])).not.toContain('You are a sub-agent');
    });

    it('the parent\'s caps halt a child loop: the tool-call cap stops the child mid-delegation and settles the run at that cap', async () => {
        const def = profileDef([sub('risk_reader', ['list_risks'])], ['list_risks']);
        await driveProfile(
            {
                tools: [LIST_RISKS],
                toolCallLimit: 1,
                turns: [delegate('risk_reader'), call('list_risks'), call('list_risks'), { text: 'never' }, { text: 'never' }],
            },
            def,
        );
        expect(recordedSettlement()?.cap).toBe('TOOL_CALLS');
        expect(mockState.funnelCalls).toHaveLength(1);
        // No request after the cap latched: parent, child, child.
        expect(wire.bodies).toHaveLength(3);
        // The marker still closes the span, naming the run's stop.
        const marker = mockState.ledger.find((s) => s.rec.toolCalled === 'delegate');
        expect(marker?.rec.status).toBe('FAILED');
        expect((marker?.rec.output as { outcome: string }).outcome).toBe('RUN_STOPPED_CAP');
    });

    it('the kill switch halts a child before its next model call', async () => {
        const def = profileDef([sub('risk_reader', ['list_risks'])], ['list_risks']);
        await driveProfile(
            { tools: [LIST_RISKS], turns: [delegate('risk_reader'), call('list_risks'), { text: 'never' }, { text: 'never' }] },
            def,
            // Engaged while the child's tool call runs.
            { killAfterFunnelCalls: 1 },
        );
        expect(recordedSettlement()?.status).toBe('ABORTED');
        expect(recordedSettlement()?.reason).toMatch(/kill/);
        // The parent's call and the child's first: the child's second never left.
        expect(wire.bodies).toHaveLength(2);
        const marker = mockState.ledger.find((s) => s.rec.toolCalled === 'delegate');
        expect((marker?.rec.output as { outcome: string }).outcome).toBe('RUN_STOPPED_KILL');
    });

    it('the breaker is read before every model call in the parent loop: OPEN stops the run before its next call', async () => {
        await driveProfile(
            { tools: [LIST_RISKS], turns: [call('list_risks'), { text: 'never' }] },
            DEFINITION,
            { breakerOpenAfterModelCalls: 1 },
        );
        expect(wire.bodies).toHaveLength(1);
        expect(recordedSettlement()).toEqual({ status: 'FAILED', reason: BREAKER_OPEN_MESSAGE, cap: null });
    });

    it('the breaker read before a child\'s model call stops the delegation and the run', async () => {
        const def = profileDef([sub('risk_reader', ['list_risks'])], ['list_risks']);
        await driveProfile(
            { tools: [LIST_RISKS], turns: [delegate('risk_reader'), call('list_risks'), { text: 'never' }, { text: 'never' }] },
            def,
            { breakerOpenAfterModelCalls: 2 },
        );
        expect(wire.bodies).toHaveLength(2);
        expect(recordedSettlement()?.reason).toBe(BREAKER_OPEN_MESSAGE);
    });

    it('each parent model call charges one STEPS before it is sent: a run with two steps left halts before its second call', async () => {
        // Two steps left: the first model call takes one, its tool call the
        // other, and the second model call finds none. Before Step 2e only the
        // tool call was charged, and the second call went out.
        reset({ tools: [LIST_RISKS] }, [call('list_risks'), { text: 'never' }]);
        await runToolRunnerDriver(context(), 'run-steps', DEFINITION, ENGINE_CAPS.MAX_STEPS - 2, Date.now());
        expect(wire.bodies).toHaveLength(1);
        expect(recordedSettlement()?.cap).toBe('STEPS');
    });

    it('a delegation counts against the turn\'s tool-call cap: at one call a turn, a second call naming delegate is refused', async () => {
        const def = profileDef([sub('risk_reader', ['list_risks'])], ['list_risks']);
        await driveProfile(
            {
                tools: [LIST_RISKS],
                turns: [
                    { toolCalls: [{ name: 'list_risks', args: {} }, { name: 'delegate', args: { subagent: 'risk_reader', task: 'x' } }] },
                    { text: 'done' },
                ],
            },
            def,
        );
        const refused = ledgerSteps().filter((st) => st.refused !== null);
        expect(refused).toEqual([
            { kind: 'TOOL_CALL', toolCalled: 'delegate', status: 'FAILED', subagent: null, refused: 'TOOL_CALLS_PER_TURN_EXCEEDED' },
        ]);
        expect(wire.bodies).toHaveLength(2);
    });

    it('at a delegation cap of 0 the delegation is refused, saying delegation is disabled, and no child request leaves', async () => {
        const def = profileDef([sub('risk_reader', ['list_risks'])], ['list_risks']);
        await driveProfile({ tools: [LIST_RISKS], turns: [delegate('risk_reader'), { text: 'done alone' }] }, def, { orgDelegationsPerTurn: 0 });
        expect(wire.bodies).toHaveLength(2);
        const marker = mockState.ledger.find((st) => st.rec.toolCalled === 'delegate');
        expect(marker?.rec.status).toBe('FAILED');
        expect((marker?.rec.output as { outcome: string }).outcome).toBe('DELEGATIONS_PER_TURN_EXCEEDED');
        expect(JSON.stringify(toolResultsOf(wire.bodies[1]))).toContain('delegation_disabled');
        expect(recordedSettlement()?.status).toBe('COMPLETED');
    });

    it('a name outside the enum is refused SUBAGENT_NOT_DEFINED and never echoed', async () => {
        const def = profileDef([sub('risk_reader', ['list_risks'])], ['list_risks']);
        await driveProfile({ tools: [LIST_RISKS], turns: [delegate('impostor_zz9'), { text: 'done' }] }, def);
        const marker = mockState.ledger.find((st) => st.rec.toolCalled === 'delegate');
        expect((marker?.rec.output as { outcome: string }).outcome).toBe('SUBAGENT_NOT_DEFINED');
        expect(JSON.stringify(mockState.ledger)).not.toContain('impostor_zz9');
        expect(JSON.stringify(toolResultsOf(wire.bodies[1]))).not.toContain('impostor_zz9');
        expect(wire.bodies).toHaveLength(2);
    });

    it('a sub-agent whose tools the agent no longer reaches is refused with nothing sent, naming what was lost', async () => {
        // The version names list_controls; the agent no longer holds it.
        const def = profileDef([sub('control_reader', ['list_controls'])], ['list_risks', 'list_controls']);
        await driveProfile({ tools: [LIST_RISKS], turns: [delegate('control_reader'), { text: 'done' }] }, def);
        expect(wire.bodies).toHaveLength(2);
        const marker = mockState.ledger.find((st) => st.rec.toolCalled === 'delegate');
        expect((marker?.rec.output as { outcome: string }).outcome).toBe('SUBAGENT_HAS_NO_TOOLS');
        expect((marker?.rec.input as { toolsLost: unknown }).toolsLost).toEqual([{ name: 'list_controls', reason: 'PROFILE_TOOL_NOT_GRANTED' }]);
    });
});

// ─── Step 2g: context compaction ────────────────────────────────────

describe('Step 2g: compaction on the Tool Runner engine (#5531)', () => {
    /** A tool round whose reply reports `inputTokens`, so the next request's estimate is near it. */
    const bigRound = (inputTokens: number, names: readonly string[] = ['list_risks'], withThinking = false): FauxTurn => ({
        raw: {
            content: [
                ...(withThinking ? [{ type: 'thinking', thinking: 'I should read the risks first.', signature: 'sig_abc' }] : []),
                { type: 'text', text: 'Reading.' },
                ...names.map((name, j) => ({ type: 'tool_use', id: `toolu_big_${j}`, name, input: {} })),
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: inputTokens, output_tokens: 5 },
        },
    });
    const SUMMARY = 'Read the risks: r1 is open. Next: answer.';
    const summaryTurn = (text = SUMMARY, stopReason = 'end_turn'): FauxTurn => ({
        raw: { content: [{ type: 'text', text }], stop_reason: stopReason },
    });
    const isSummaryRequest = (b: Record<string, unknown>) => JSON.stringify(b.tool_choice) === '{"type":"none"}';
    const compactionSteps = () =>
        mockState.ledger.filter((s) => s.kind === 'MODEL_CALL' && (s.rec.input as { purpose?: unknown }).purpose === 'compaction');
    const messagesOf = (b: Record<string, unknown>) => b.messages as Array<{ role: string; content: unknown }>;
    /** A profile run over scripted wire turns, raw ones included. */
    const driveFaux = (def: WorkflowDefinition, tools: ConformanceRun['tools'], turns: readonly FauxTurn[]) => {
        reset({ tools }, turns);
        return runToolRunnerDriver(context(), `run-${Math.random().toString(36).slice(2)}`, def, 0, Date.now());
    };

    it('fires at the threshold and not below it: 15% of the run\'s TOKENS limit, 30,000 under the engine cap', async () => {
        await drive({ tools: [LIST_RISKS], turns: [] }, [bigRound(29_000), { text: 'done' }]);
        expect(wire.bodies).toHaveLength(2);
        expect(wire.bodies.some(isSummaryRequest)).toBe(false);
        expect(compactionSteps()).toEqual([]);

        await drive({ tools: [LIST_RISKS], turns: [] }, [bigRound(30_000), summaryTurn(), { text: 'done' }]);
        expect(wire.bodies).toHaveLength(3);
        expect(isSummaryRequest(wire.bodies[1])).toBe(true);
        expect(compactionSteps()).toHaveLength(1);
        expect(recordedSettlement()?.status).toBe('COMPLETED');
    });

    it('the summary request is the run\'s own request with tool_choice none and Inflect\'s instruction appended', async () => {
        await drive({ tools: [LIST_RISKS], turns: [] }, [bigRound(40_000, ['list_risks'], true), summaryTurn(), { text: 'done' }]);
        const [first, summary] = wire.bodies;
        for (const key of ['model', 'system', 'tools', 'thinking', 'output_config', 'fallbacks']) {
            expect({ key, value: summary[key] }).toEqual({ key, value: first[key] });
        }
        expect(summary.tool_choice).toEqual({ type: 'none' });
        expect(summary.max_tokens).toBe(COMPACTION_SUMMARY_MAX_TOKENS);
        expect(summary).not.toHaveProperty('thread');
        // The history unchanged, thinking block included, then the instruction.
        const msgs = messagesOf(summary);
        expect(msgs[0]).toEqual(messagesOf(first)[0]);
        expect(JSON.stringify(msgs[1])).toContain('"signature":"sig_abc"');
        expect(msgs.at(-1)).toEqual({ role: 'user', content: COMPACTION_INSTRUCTION });
    });

    it('rebuilds the next request by code: the opening message, the run-state block, the summary, and the last turn verbatim with thinking dropped', async () => {
        await drive({ tools: [LIST_RISKS], turns: [] }, [bigRound(40_000, ['list_risks'], true), summaryTurn(), { text: 'done' }]);
        const [first, summary, next] = wire.bodies;
        const history = messagesOf(summary).slice(0, -1);
        const msgs = messagesOf(next);
        expect(msgs).toHaveLength(5);
        // 1. The opening message, byte for byte.
        expect(JSON.stringify(msgs[0])).toBe(JSON.stringify(messagesOf(first)[0]));
        // 2. Inflect's block, from the ledger: one tool call, clean.
        expect(msgs[1]).toEqual({
            role: 'user',
            content: [
                'Inflect wrote the block below from this run\'s own record. It is complete for the conversation so far, and the summary after it does not repeat it.',
                RUN_STATE_OPEN,
                'Skills activated: none.',
                'Refused tool calls: none.',
                'Proposals made: none.',
                'Delegations: none.',
                'Guard verdicts: 1 clean. Any other verdict stops the run, so there is none.',
                RUN_STATE_CLOSE,
            ].join('\n'),
        });
        // 3. The summary, fenced as the model's.
        expect(msgs[2]).toEqual({ role: 'user', content: runSummaryText(SUMMARY) });
        // 4. The last assistant turn: every block as sent, but the thinking block.
        const lastAssistant = history[1] as { content: Array<{ type: string }> };
        expect(lastAssistant.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
        expect(msgs[3]).toEqual({ role: 'assistant', content: lastAssistant.content.filter((b) => b.type !== 'thinking') });
        // 5. The turn's tool results, exactly as the runner produced them.
        expect(JSON.stringify(msgs[4])).toBe(JSON.stringify(history[2]));
        expect(toolResultsOf(next).map((r) => r.content)).toEqual([LIST_RISKS.result]);
        // System and tools are unchanged on the request after it.
        expect(next.system).toEqual(first.system);
        expect(next.tools).toEqual(first.tools);
    });

    it('a refusal and a pending proposal reach the model through the run-state block, never only through the summary', async () => {
        // Two calls in one turn at a cap of one: the second is refused.
        reset({ tools: [LIST_RISKS, LIST_CONTROLS] }, [
            bigRound(40_000, ['list_risks', 'list_controls']),
            summaryTurn('The run read r1.'),
            { text: 'done' },
        ]);
        mockState.proposals = [{ id: 'prop_pending_1', kind: 'FINDING', status: 'PENDING', stepSeq: 1 }];
        await runToolRunnerDriver(context(), 'run-refusal', DEFINITION, 0, Date.now());
        const block = String(messagesOf(wire.bodies[2])[1].content);
        expect(block.startsWith('Inflect wrote the block below')).toBe(true);
        expect(block).toContain('- step 3: list_controls (TOOL_CALLS_PER_TURN_EXCEEDED)');
        expect(block).toContain('- prop_pending_1: FINDING, PENDING');
        // And the refusal's tool error is still in the last turn, verbatim.
        expect(toolResultsOf(wire.bodies[2]).map((r) => r.is_error === true)).toEqual([false, true]);
    });

    it('an activated skill\'s pinned text is re-taught verbatim after a compaction', async () => {
        const SKILL = loadSkill(MOUNTABLE_REPOSITORY_SKILL);
        await drive(
            { tools: [LIST_RISKS], turns: [], skills: { repository: [SKILL.name] } },
            [{ toolCalls: [{ name: 'activate_skill', args: { name: SKILL.name } }] }, bigRound(40_000), summaryTurn(), { text: 'done' }],
        );
        expect(wire.bodies).toHaveLength(4);
        const block = String(messagesOf(wire.bodies[3])[1].content);
        expect(block).toContain(
            `<skill name="${SKILL.name}" version="${SKILL.metadata.version}" content_hash="${skillContentHash(SKILL.instructions)}">\n${SKILL.instructions}\n</skill>`,
        );
    });

    it('the summary call is charged one STEPS and its tokens', async () => {
        await drive({ tools: [LIST_RISKS], turns: [] }, [bigRound(40_000), summaryTurn(), { text: 'done' }]);
        const [step] = compactionSteps();
        // Three model calls of 10/5 or 40,000/5 tokens each: the summary's 15 counted.
        expect(step.rec.tokens).toBe(15);
        expect(mockState.updates.at(-1)?.costTokens).toBe(40_005 + 15 + 15);
        // Steps: call, tool, summary, call: four charged, four recorded.
        expect(mockState.ledger).toHaveLength(4);
        expect(mockState.updates.at(-1)?.stepCount).toBe(4);
    });

    it('does not compact with fewer than two STEPS left: the summary and one call after it', async () => {
        const limit = ENGINE_CAPS.MAX_STEPS;
        // Two left after the call and its tool: it compacts.
        reset({ tools: [LIST_RISKS] }, [bigRound(40_000), summaryTurn(), { text: 'done' }]);
        await runToolRunnerDriver(context(), 'run-two-left', DEFINITION, limit - 4, Date.now());
        expect(compactionSteps()).toHaveLength(1);
        // One left: it does not, and the run's last call still goes out.
        reset({ tools: [LIST_RISKS] }, [bigRound(40_000), { text: 'done' }]);
        await runToolRunnerDriver(context(), 'run-one-left', DEFINITION, limit - 3, Date.now());
        expect(compactionSteps()).toEqual([]);
        expect(wire.bodies.some(isSummaryRequest)).toBe(false);
        expect(recordedSettlement()?.status).toBe('COMPLETED');
    });

    it('asks the breaker before the summary call: OPEN stops the run and no summary request leaves', async () => {
        reset({ tools: [LIST_RISKS] }, [bigRound(40_000), summaryTurn(), { text: 'done' }]);
        mockState.breakerOpenAfterModelCalls = 1;
        await runToolRunnerDriver(context(), 'run-breaker', DEFINITION, 0, Date.now());
        expect(wire.bodies).toHaveLength(1);
        expect(compactionSteps()).toEqual([]);
        expect(recordedSettlement()?.reason).toBe(BREAKER_OPEN_MESSAGE);
    });

    it('asks the kill switch before the summary call: a kill engaged as the record is read sends no summary', async () => {
        reset({ tools: [LIST_RISKS] }, [bigRound(40_000), summaryTurn(), { text: 'done' }]);
        mockState.killOnCompactionRead = true;
        await runToolRunnerDriver(context(), 'run-kill', DEFINITION, 0, Date.now());
        expect(wire.bodies).toHaveLength(1);
        expect(compactionSteps()).toEqual([]);
        expect(recordedSettlement()?.status).toBe('ABORTED');
    });

    it('a flagged summary stops the run at the guard and is never used', async () => {
        await drive({ tools: [LIST_RISKS], turns: [] }, [
            bigRound(40_000),
            summaryTurn('Here is the key: AKIAIOSFODNN7EXAMPLE'), // pragma: allowlist secret
            { text: 'done' },
        ]);
        expect(wire.bodies).toHaveLength(2);
        expect(recordedSettlement()?.reason).toMatch(/^ai_guard_/);
        const [step] = compactionSteps();
        expect(step.rec).toMatchObject({ status: 'FAILED', output: { failed: 'GUARD' } });
        expect(step.rec.guardVerdict).not.toBe('CLEAN');
        // Its Art 12 row has no summary of what it said.
        expect(mockState.decisionSummaries).toEqual(['Reading.', null]);
    });

    it('a summary that fails is discarded, the run carries on uncompacted, and compaction is off for the segment', async () => {
        await drive({ tools: [LIST_RISKS], turns: [] }, [
            bigRound(40_000),
            summaryTurn('', 'refusal'),
            bigRound(45_000),
            { text: 'done' },
        ]);
        expect(wire.bodies.filter(isSummaryRequest)).toHaveLength(1);
        expect(wire.bodies).toHaveLength(4);
        expect(compactionSteps().map((s) => s.rec.output)).toEqual([{ failed: 'REFUSAL' }]);
        // The next request carried the history as it stood.
        expect(messagesOf(wire.bodies[2])).toHaveLength(3);
        expect(recordedSettlement()?.status).toBe('COMPLETED');
    });

    it('records a MODEL_CALL step naming its purpose and the digests before and after, its own Art 12 row, and keeps every original step', async () => {
        await drive({ tools: [LIST_RISKS], turns: [] }, [bigRound(40_000), summaryTurn(), { text: 'done' }]);
        expect(mockState.ledger.map((s) => [s.kind, (s.rec.input as { purpose?: string } | undefined)?.purpose ?? null])).toEqual([
            ['MODEL_CALL', null],
            ['TOOL_CALL', null],
            ['MODEL_CALL', 'compaction'],
            ['MODEL_CALL', null],
        ]);
        const digests = mockState.ledger
            .filter((s) => s.kind === 'MODEL_CALL')
            .map((s) => s.rec.input as Record<string, unknown>);
        const [before, compaction, after] = digests;
        expect(compaction.compactedFromDigest).toBe(before.decisionDigest);
        expect((mockState.ledger[2].rec.output as { compactedToDigest: string }).compactedToDigest).toBe(after.decisionDigest);
        expect(compaction.summaryDigest).toBe(`sha256:${createHash('sha256').update(SUMMARY, 'utf8').digest('hex')}`);
        expect(compaction).toMatchObject({ modelCalls: 1, messagesSummarised: 3, estimatedTokensBefore: expect.any(Number) });
        // One Art 12 row per model call, the summary's included, over the request that left.
        expect(mockState.decisionRows.map((r) => r.inputDigest)).toEqual(digests.map((d) => d.decisionDigest));
        expect(computeInputDigest(mockState.decisionInputs[1])).toBe(compaction.decisionDigest);
        expect(mockState.decisionSummaries[1]).toBe(SUMMARY);
        // The summary's text never reaches the ledger.
        expect(JSON.stringify(mockState.ledger)).not.toContain(SUMMARY);
    });

    it('a profile version that turns compaction off is never compacted, and one that lowers the threshold is compacted sooner', async () => {
        const withThreshold = (value: number) =>
            ({ ...profileDef([], ['list_risks']), profile: { ...profileDef([], ['list_risks']).profile, compactionThresholdTokens: value } }) as WorkflowDefinition;
        await driveFaux(withThreshold(0), [LIST_RISKS], [bigRound(40_000), { text: 'done' }]);
        expect(compactionSteps()).toEqual([]);
        await driveFaux(withThreshold(12_000), [LIST_RISKS], [bigRound(12_500), summaryTurn(), { text: 'done' }]);
        expect(compactionSteps()).toHaveLength(1);
        // Positive control: the engine's threshold alone would not have fired.
        await driveFaux(profileDef([], ['list_risks']), [LIST_RISKS], [bigRound(12_500), { text: 'done' }]);
        expect(compactionSteps()).toEqual([]);
    });

    it('a sub-agent compacts its own history on the run\'s one budget, and never touches its parent\'s', async () => {
        const def = profileDef([sub('risk_reader', ['list_risks'])], ['list_risks', 'list_controls']);
        await driveFaux(def, [LIST_RISKS, LIST_CONTROLS], [
            delegate('risk_reader'),
            bigRound(40_000),
            summaryTurn(),
            { text: 'One risk: r1.' },
            { text: 'done' },
        ]);
        expect(recordedSettlement()?.status).toBe('COMPLETED');
        expect(wire.bodies).toHaveLength(5);
        // The summary request is the CHILD's: its system prompt and its task.
        const summary = wire.bodies[2];
        expect(isSummaryRequest(summary)).toBe(true);
        expect(summary.system).toEqual(wire.bodies[1].system);
        expect(JSON.stringify(messagesOf(summary)[0])).toBe(JSON.stringify(messagesOf(wire.bodies[1])[0]));
        // The child's next request carries its own block, which names no delegation.
        const childBlock = String(messagesOf(wire.bodies[3])[1].content);
        expect(childBlock).toContain(RUN_STATE_OPEN);
        expect(childBlock).not.toContain('Delegations');
        // The step is the child's, and the parent's history is not compacted.
        const [step] = compactionSteps();
        expect(step.rec.subagent).toBe('risk_reader');
        const parentNext = JSON.stringify(wire.bodies[4].messages);
        expect(parentNext).not.toContain(RUN_STATE_OPEN);
        expect(parentNext).not.toContain(RUN_SUMMARY_OPEN);
        expect(messagesOf(wire.bodies[4])).toHaveLength(3);
        // One budget: every call's tokens, the child's summary included.
        expect(mockState.updates.at(-1)?.costTokens).toBe(15 + 40_005 + 15 + 15 + 15);
    });
});
