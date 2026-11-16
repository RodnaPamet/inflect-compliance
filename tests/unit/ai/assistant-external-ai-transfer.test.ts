/**
 * The in-product assistant asks the external-AI transfer gate before its first
 * model call (#3872; owner decision 2026-11-16).
 *
 * ═══ THE DEFECT THIS HOLDS SHUT ═══
 *
 * `/assistant/ask` and `/assistant/stream` accept API keys. For a key bound to
 * a registered agent, `resolveMcpInvocation` hands the turn that agent's
 * granted EXTERNAL tools, and `assistantTools` offers them (`loadableReadTools`
 * appends `inv.externalTools`). The assistant then sent their results to
 * Anthropic without asking `externalResidencyRefusal`, which Flue and the Tool
 * Runner both ask (#5364). A signed-in person is unaffected: they hold no
 * grants, so they are offered no external tool.
 *
 * ═══ THE SCENARIOS ARE THE ENGINES' OWN ═══
 *
 * The two `business-data-transfer-*` scenarios are taken from the driver
 * conformance table (`tests/helpers/driver-conformance.ts`) by id, run as an
 * assistant turn, and judged by the table's own assertions, so the assistant is
 * held to exactly what every engine is held to. The rest of that table is
 * about runs (a ledger, a kill switch, run rows) that a turn does not have, so
 * the suite as a whole is not this adapter's to pass.
 *
 * ═══ WHAT IS REAL ═══
 *
 * Both routes, `withApiErrorHandling`, `requirePermission`, the usecase and its
 * governed ordering, `assistantTools` → `flueToolsFor` → `offerToolSet` (the
 * offer and its external-connection record), `runGuardedTool` and the AI
 * Guard, the gate, `resolveFlueModel` and the Anthropic provider down to
 * `fetch`. A model call is a `fetch` to Anthropic, which is what is counted.
 *
 * ═══ WHAT IS FAKED ═══
 *
 * The context resolution (an agent-bound key, or a session), the audit sink,
 * the tenant settings row, the decision-log insert, the invocation's tool
 * catalogue and the funnel at `runReadTool` (exactly the seams the Flue
 * conformance adapter fakes), and the feature gate and rate limiter, which
 * need Redis and are not what this is about.
 */
import { strictMock } from '../../helpers/strict-mock';

jest.mock('@/env', () => ({
    env: {
        NODE_ENV: 'test',
        ANTHROPIC_API_KEY: 'sk-transfer-test', // pragma: allowlist secret — a placeholder; every request goes to a fetch double
        AGENT_FLUE_MODEL: 'claude-sonnet-5-5',
        AI_LOCAL_BASE_URL: 'http://gateway.internal',
        AI_LOCAL_MODEL: 'local-model',
    },
}));

const mockState = {
    tools: [] as ConformanceTool[],
    acknowledged: false,
    residency: 'EXTERNAL' as 'EXTERNAL' | 'LOCAL_ONLY',
    funnelCalls: [] as Array<{ name: string; args: unknown }>,
};

jest.mock('@/app-layer/ai/risk-assessment/feature-gate', () => ({ enforceFeatureGate: jest.fn() }));
jest.mock('@/app-layer/ai/risk-assessment/rate-limiter', () => ({
    checkRateLimit: jest.fn(),
    recordGeneration: jest.fn(),
}));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: jest.fn(async () => ({ id: 'audit-1', entryHash: 'h', previousHash: null })),
        appendAuditEntryOrQueue: jest.fn(async () => ({ id: 'audit-1', entryHash: 'h', previousHash: null })),
    }),
);
// ONE settings row for every reader of it: the assistant's posture read and the
// AI Guard's mode read. The guard finds no mode column and runs its default.
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_c: unknown, fn: (db: unknown) => unknown) =>
        fn({
            tenantSecuritySettings: {
                findUnique: async () => ({
                    aiResidency: mockState.residency,
                    aiLocalBaseUrl: null,
                    aiLocalModel: mockState.residency === 'LOCAL_ONLY' ? 'local-model' : null,
                    externalAiBusinessDataAckAt: mockState.acknowledged ? new Date('2026-11-01T00:00:00Z') : null,
                    externalAiBusinessDataAckByUserId: mockState.acknowledged ? 'user-owner' : null,
                }),
            },
        }),
}));
const logAiDecisionMock = jest.fn(async (..._args: unknown[]) => 'row-1');
jest.mock('@/app-layer/ai/decision-log', () => ({
    logAiDecision: (...args: unknown[]) => logAiDecisionMock(...args),
}));
jest.mock('@/app-layer/usecases/dashboard', () => ({
    getDashboardData: jest.fn().mockResolvedValue({
        stats: { risks: 3, highRisks: 1, openFindings: 2, openTasks: 4, evidence: 5, controls: 6 },
        recentActivity: [],
    }),
}));

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => getTenantCtxMock(...(args as [])),
}));

// The invocation: the agent's granted tools, as `buildMcpInvocation` resolves
// them. A session (no agent) is offered no external tool, which is the case
// the registry fake below reproduces from `ctx.agentId`.
jest.mock('@/lib/mcp/auth', () => ({
    resolveMcpInvocation: jest.fn(async (ctx: unknown) => ({
        ctx,
        autonomyCeiling: 6,
        governedAgentId: (ctx as { agentId?: string }).agentId ?? null,
        policyCard: null,
    })),
}));
jest.mock('@/lib/auth/api-key-auth', () => ({ enforceApiKeyScope: jest.fn() }));
jest.mock('@/lib/mcp/tools/registry', () => ({
    loadableReadTools: jest.fn((inv: { ctx: { agentId?: string } }) =>
        mockState.tools
            // No grants, no external tool: what `buildMcpInvocation` gives a session.
            .filter((t) => t.externalConnection === undefined || inv.ctx.agentId !== undefined)
            .map((t) => ({
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
    // THE FUNNEL, at its seam.
    runReadTool: jest.fn(async (_inv: unknown, name: string, args: unknown) => {
        mockState.funnelCalls.push({ name, args });
        const tool = mockState.tools.find((t) => t.name === name);
        return { content: [{ type: 'text', text: tool ? tool.result : '{}' }] };
    }),
}));
jest.mock('@/lib/mcp/tools/propose-tools', () => ({
    PROPOSE_TOOLS: [],
    loadableProposeTools: jest.fn(() => []),
    runProposeTool: jest.fn(async () => ({ content: [] })),
    isProposeTool: () => false,
    proposedItemCount: () => 0,
}));
jest.mock('@/lib/validation/route', () => ({
    parseJsonBody: async () => ({ question: 'what is on order o1?' }),
}));

import { NextRequest } from 'next/server';

import * as askRoute from '@/app/api/t/[tenantSlug]/assistant/ask/route';
import * as streamRoute from '@/app/api/t/[tenantSlug]/assistant/stream/route';
import { __resetStreamCapacity } from '@/app-layer/ai/assistant/stream-capacity';
import type { AssistantStreamEvent } from '@/app-layer/ai/assistant/stream-events';
import {
    BUSINESS_SYSTEM_CONNECTION,
    CONFORMANCE_SCENARIOS,
    type ConformanceObservation,
    type ConformanceRun,
    type ConformanceTool,
    type ScenarioId,
    type ScriptedTurn,
} from '../../helpers/driver-conformance';
import { getPermissionsForRole } from '@/lib/permissions';

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

/** A context with a real permission set; an API key bound to an agent, or a session. */
function ctxFor(caller: 'agent-key' | 'session'): Record<string, unknown> {
    const permissions = getPermissionsForRole('ADMIN' as never);
    return {
        requestId: 'req-transfer',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        userId: 'user-1',
        role: 'ADMIN',
        permissions,
        appPermissions: permissions,
        ...(caller === 'agent-key'
            ? { apiKeyId: 'key-1', apiKeyScopes: ['*'], agentId: 'agent-1' }
            : {}),
    };
}

const routeArgs = () => ({ params: Promise.resolve({ tenantSlug: 'acme' }) });
const request = (path: string): NextRequest =>
    new NextRequest(`http://localhost/api/t/acme/assistant/${path}`, { method: 'POST', body: '{}' });

/** Anthropic's reply for one scripted turn. */
function anthropicReply(turn: ScriptedTurn, n: number): unknown {
    if (turn.toolCalls && turn.toolCalls.length > 0) {
        return {
            content: turn.toolCalls.map((c, i) => ({ type: 'tool_use', id: `tu-${n}-${i}`, name: c.name, input: c.args })),
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
        };
    }
    return {
        content: [{ type: 'text', text: turn.text ?? '' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
    };
}

/** `fetch`, scripted from the turns, recording every request it receives. */
function scriptedFetch(turns: readonly ScriptedTurn[]) {
    const sent: Array<{ url: string; body: string }> = [];
    const impl = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const body = String(init?.body ?? '');
        sent.push({ url: String(url), body });
        const turn = turns[Math.min(sent.length - 1, turns.length - 1)];
        return new Response(JSON.stringify(anthropicReply(turn, sent.length)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    });
    global.fetch = impl as unknown as typeof fetch;
    return { impl, sent };
}

const originalFetch = global.fetch;

beforeEach(() => {
    __resetStreamCapacity();
    getTenantCtxMock.mockReset();
    logAiDecisionMock.mockClear();
    mockState.tools = [];
    mockState.acknowledged = false;
    mockState.residency = 'EXTERNAL';
    mockState.funnelCalls = [];
});
afterEach(() => {
    global.fetch = originalFetch;
});

/** Make one turn through `/assistant/ask` and read back what it did. */
async function askTurn(run: ConformanceRun, caller: 'agent-key' | 'session' = 'agent-key') {
    mockState.tools = [...run.tools];
    mockState.acknowledged = run.externalAiAcknowledged === true;
    mockState.residency = run.residency ?? 'EXTERNAL';
    getTenantCtxMock.mockResolvedValue(ctxFor(caller));
    const wire = scriptedFetch(run.turns);

    const res = await askRoute.POST(request('ask') as never, routeArgs() as never);
    const body = (await res.json()) as { message?: string; error?: { message?: string; code?: string } };

    const obs: ConformanceObservation = {
        status: res.status === 200 ? 'COMPLETED' : 'FAILED',
        haltReason: res.status === 200 ? null : (body.error?.message ?? null),
        haltedCap: null,
        modelInputs: wire.sent.map((s) => s.body),
        externalModelCalls: wire.sent.filter((s) => s.url === ANTHROPIC).length,
        ledger: [],
        decisionRows: [],
        funnelCalls: [...mockState.funnelCalls],
        offeredTools:
            wire.sent.length === 0
                ? []
                : (JSON.parse(wire.sent[0].body) as { tools: Array<{ name: string }> }).tools.map((t) => t.name),
        reportedEngineTools: [],
    };
    return { res, body, obs, wire };
}

function scenario(id: ScenarioId) {
    const s = CONFORMANCE_SCENARIOS.find((x) => x.id === id);
    if (!s) throw new Error(`conformance table has no scenario "${id}"`);
    return s;
}

describe('the engines\' transfer scenarios, run as an assistant turn through /assistant/ask', () => {
    for (const id of [
        'business-data-transfer-refused-unacknowledged',
        'business-data-transfer-acknowledged-proceeds',
    ] as const) {
        const s = scenario(id);
        it(`${id}: ${s.title}`, async () => {
            const { obs } = await askTurn(s.run);
            s.assert(obs, s.run);
        });
    }
});

describe('the refusal, read at the route', () => {
    const refused = scenario('business-data-transfer-refused-unacknowledged').run;

    it('is a 403 naming the assistant, the reason and the connection, and nothing reaches the provider', async () => {
        const { res, body, wire } = await askTurn(refused);

        expect(res.status).toBe(403);
        expect(body.error?.message).toMatch(/^assistant_external_ai_business_data_unacknowledged: this assistant turn would read /);
        expect(body.error?.message).toContain(`(${BUSINESS_SYSTEM_CONNECTION})`);
        // The provider seam: not one request.
        expect(wire.impl).not.toHaveBeenCalled();
        expect(mockState.funnelCalls).toHaveLength(0);
        // No model was called, so no Art 12 row claims one was.
        expect(logAiDecisionMock).not.toHaveBeenCalled();
    });

    it('arrives on the stream as a refusal that names the connection, with no answer and no model call', async () => {
        mockState.tools = [...refused.tools];
        getTenantCtxMock.mockResolvedValue(ctxFor('agent-key'));
        const wire = scriptedFetch(refused.turns);

        const res = await streamRoute.POST(request('stream') as never, routeArgs() as never);
        expect(res.status).toBe(200);
        const events = (await res.text())
            .split('\n\n')
            .map((b) => b.trim())
            .filter((b) => b.startsWith('data: '))
            .map((b) => JSON.parse(b.slice('data: '.length)) as AssistantStreamEvent);

        const refusal = events.find((e) => e.type === 'refusal') as { reason: string } | undefined;
        expect(refusal?.reason).toContain(BUSINESS_SYSTEM_CONNECTION);
        expect(refusal?.reason).toContain('No model was called');
        expect(events.some((e) => e.type === 'answer')).toBe(false);
        expect(wire.impl).not.toHaveBeenCalled();
        expect(mockState.funnelCalls).toHaveLength(0);
    });
});

describe('who and what it does not touch', () => {
    const businessRun = scenario('business-data-transfer-refused-unacknowledged').run;

    it('a signed-in person is unaffected: offered no external tool, so the model is asked', async () => {
        // The same unacknowledged workspace, the same catalogue. A session holds
        // no grants, so the business-system tool is never offered and there is
        // nothing to transfer.
        const { res, body, obs } = await askTurn(
            {
                tools: [
                    ...businessRun.tools,
                    { name: 'list_risks', result: '{"risks":[{"id":"r1","title":"Vendor outage"}]}' },
                ],
                turns: [{ text: 'You have one risk.' }],
            },
            'session',
        );
        expect(res.status).toBe(200);
        expect(body.message).toBe('You have one risk.');
        expect(obs.externalModelCalls).toBe(1);
        expect(obs.offeredTools).toEqual(['list_risks']);
    });

    it('an agent-bound key whose external connection carries no business data is not refused', async () => {
        // The gate refuses on `reachesBusinessSystem === true` alone; the
        // control that it is not refusing every external tool.
        const { res, obs } = await askTurn({
            tools: [
                {
                    name: 'wiki_search',
                    result: '{"pages":[]}',
                    externalConnection: { name: 'Team wiki', reachesBusinessSystem: false },
                },
            ],
            turns: [{ text: 'Nothing found.' }],
        });
        expect(res.status).toBe(200);
        expect(obs.externalModelCalls).toBe(1);
    });

    it('LOCAL_ONLY still answers locally: no model call, no refusal, the keyword router answers', async () => {
        // Residency decides first. A LOCAL_ONLY workspace calls no external
        // model, so it transfers nothing, and the gate is never reached.
        const { res, body, obs } = await askTurn({ ...businessRun, residency: 'LOCAL_ONLY' });
        expect(res.status).toBe(200);
        expect(body.message).toMatch(/Posture:|What would you like to know\?|risk/);
        expect(obs.externalModelCalls).toBe(0);
        expect(obs.modelInputs).toHaveLength(0);
        expect(obs.funnelCalls).toHaveLength(0);
    });
});
