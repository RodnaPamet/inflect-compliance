/**
 * A RETRIED TOOL RUNNER RUN CONTINUES ITS CONVERSATION (#5854 item 3; owner
 * decision 2026-11-24).
 *
 * Real database, the worker's own body (`executeQueuedWorkflowRun`) with its
 * run lease, and the Tool Runner engine; the model is a fake `fetch` answering
 * Anthropic's Messages API, and the one tool whose executions are counted
 * (`list_risks`) runs through the real funnel with its usecase counted. A
 * worker "dies" the way a takeover sees it: its lease is handed to a dead
 * holder whose lease has already lapsed, and the next execution claims the
 * run over it.
 *
 *   • After two completed turns, the next attempt continues from turn three:
 *     the first two turns' calls are not made again, and the model is sent
 *     exactly the request the dead attempt sent for turn three.
 *   • A call in flight when the worker died is answered
 *     `TOOL_CALL_OUTCOME_UNKNOWN`, and one it never started `TOOL_CALL_NOT_RUN`;
 *     neither is executed again.
 *   • The checkpoint is ciphertext at rest, and it is cleared at settlement.
 *   • A tool withdrawn between the attempts is refused at the continuation.
 *   • An operator's Abort, a kill and the wall-clock cap still stop a
 *     continued run, and the continuation does not buy back time.
 *   • Two tenants: neither reads nor writes the other's checkpoint.
 */
const envOverride: Record<string, string | undefined> = {
    AGENT_PROFILES: '1',
    AGENT_DRIVER_TOOL_RUNNER: '1',
    ANTHROPIC_API_KEY: 'sk-ant-integration-faux-key', // pragma: allowlist secret -- a placeholder; the fake fetch answers every request
};
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) => (typeof key === 'string' && key in envOverride ? envOverride[key] : Reflect.get(target, key)),
        }),
    };
});
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async () => undefined),
}));
// THE COUNTED TOOL. `list_risks` runs through the real funnel; only its usecase
// is wrapped, to count executions and, once, to let the worker "die" while the
// call is in flight.
const toolHooks = { listRisksCalls: 0, duringListRisks: null as null | (() => Promise<void>) };
jest.mock('@/app-layer/usecases/risk', () => {
    const actual = jest.requireActual('@/app-layer/usecases/risk');
    return {
        ...actual,
        listRisks: jest.fn(async (...args: unknown[]) => {
            toolHooks.listRisksCalls += 1;
            const hook = toolHooks.duringListRisks;
            toolHooks.duringListRisks = null;
            if (hook) await hook();
            return (actual.listRisks as (...a: unknown[]) => Promise<unknown>)(...args);
        }),
    };
});

import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { abortWorkflowRun, executeQueuedWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { createAgentProfile, startAgentProfileTestRun, submitAgentProfileVersion } from '@/app-layer/usecases/agent-profiles';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import type { RequestContext } from '@/app-layer/types';
import { readCheckpoint, writeCheckpoint } from '@/lib/agentic/drivers/checkpoint-store';
import {
    TOOL_CALL_NOT_RUN,
    TOOL_CALL_NOT_RUN_MESSAGE,
    TOOL_CALL_OUTCOME_UNKNOWN,
    TOOL_CALL_OUTCOME_UNKNOWN_MESSAGE,
} from '@/lib/agentic/tool-runner/transcript';
import { TOOL_WITHDRAWN_BEFORE_CONTINUATION } from '@/lib/agentic/tool-runner/tools';
import { _resetInFlightRunsForTesting } from '@/lib/agentic/in-flight-runs';
import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import type { RunLeaseTiming } from '@/lib/agentic/run-lease';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `trcont-${randomUUID().slice(0, 8)}`;
const TENANTS = { A: `ta-${SUITE}`, B: `tb-${SUITE}` } as const;
type Tenant = keyof typeof TENANTS;
const USERS = {
    A: { owner: `ua-owner-${SUITE}`, admin: `ua-admin-${SUITE}` },
    B: { owner: `ub-owner-${SUITE}`, admin: `ub-admin-${SUITE}` },
} as const;
const AGENTS = { A: `ag-a-${SUITE}`, B: `ag-b-${SUITE}` } as const;
const MARK = { A: 'aquamarine-continuation', B: 'vermilion-continuation' } as const;

/** Short, so a takeover is decided in well under a second; the shape is the production one. */
const TIMING: RunLeaseTiming = { ttlMs: 2_000, renewMs: 150 };

const ctx = (t: Tenant, who: 'owner' | 'admin'): RequestContext =>
    makeRequestContext(who === 'owner' ? 'OWNER' : 'ADMIN', { tenantId: TENANTS[t], tenantSlug: TENANTS[t], userId: USERS[t][who] });

const version = (): AgentProfileVersionInput => ({
    instructions: 'Work through the open risks and controls, then answer.',
    toolNames: ['list_controls', 'list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 20,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN'],
});

// ─── The fake model ─────────────────────────────────────────────────

type Reply = { content: unknown[]; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } };
const wire = {
    bodies: [] as Array<Record<string, unknown>>,
    script: [] as Reply[],
    /** Called while request `n` is in flight, before its answer returns. */
    during: null as null | ((n: number) => Promise<void>),
};
const originalFetch = global.fetch;

const toolUse = (id: string, name: string, extra: unknown[] = []): Reply => ({
    content: [...extra, { type: 'tool_use', id, name, input: {} }],
    stop_reason: 'tool_use',
});
const finalAnswer: Reply = { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' };

function installFakeModel(): void {
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const n = wire.bodies.length;
        wire.bodies.push(body);
        await wire.during?.(n);
        const reply = wire.script[n] ?? finalAnswer;
        return new Response(
            JSON.stringify({
                id: `msg_${n}`,
                type: 'message',
                role: 'assistant',
                model: String(body.model),
                stop_sequence: null,
                usage: reply.usage ?? { input_tokens: 10, output_tokens: 5 },
                content: reply.content,
                stop_reason: reply.stop_reason,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;
}

/** One attempt of the worker, with the model answering `script` and `during` run while request `n` is in flight. */
async function attempt(
    t: Tenant,
    runId: string,
    script: Reply[],
    during: null | ((n: number) => Promise<void>) = null,
): Promise<{ outcome: Awaited<ReturnType<typeof executeQueuedWorkflowRun>>; bodies: Array<Record<string, unknown>> }> {
    wire.bodies = [];
    wire.script = script;
    wire.during = during;
    try {
        const outcome = await executeQueuedWorkflowRun(TENANTS[t], runId, { leaseTiming: TIMING });
        return { outcome, bodies: [...wire.bodies] };
    } finally {
        wire.during = null;
    }
}

/**
 * THE WORKER DIES, as its successor sees it: the run is held by a holder that
 * will never renew, whose lease has already lapsed. The attempt that held it
 * is fenced from here on, as a dead process would be silent.
 */
async function dieNow(runId: string): Promise<void> {
    await prisma.$executeRaw`UPDATE "WorkflowRun" SET "leaseHolder" = 'a-worker-that-died', "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = ${runId}`;
}

const stepsOf = (runId: string) =>
    prisma.workflowStep.findMany({
        where: { runId },
        select: { seq: true, kind: true, toolCalled: true, status: true },
        orderBy: { seq: 'asc' },
    });

async function stepOutput(t: Tenant, runId: string, seq: number): Promise<unknown> {
    const row = await runInTenantContext(ctx(t, 'admin'), (db) =>
        db.workflowStep.findFirstOrThrow({ where: { runId, seq }, select: { outputJson: true } }),
    );
    return JSON.parse(row.outputJson ?? 'null');
}

/** The checkpoint row as it is stored: ciphertext, not decrypted. */
async function rawCheckpoint(runId: string) {
    const rows = await prisma.$queryRaw<
        Array<{
            transcriptJson: string | null;
            transcriptHash: string | null;
            resultsJson: string | null;
            inFlightToolUseId: string | null;
            settledAt: Date | null;
        }>
    >`SELECT "transcriptJson", "transcriptHash", "resultsJson", "inFlightToolUseId", "settledAt" FROM "WorkflowRunCheckpoint" WHERE "runId" = ${runId}`;
    return rows[0] ?? null;
}

async function grant(t: Tenant, toolName: string): Promise<void> {
    await prisma.registeredAgentTool.upsert({
        where: { tenantId_agentId_toolName: { tenantId: TENANTS[t], agentId: AGENTS[t], toolName } },
        create: { tenantId: TENANTS[t], agentId: AGENTS[t], toolName, grantedByUserId: USERS[t].owner },
        update: {},
    });
}

async function cleanup(): Promise<void> {
    const tenants = Object.values(TENANTS);
    await prisma.workflowStep.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        for (const table of ['AgentKillSwitch', 'AgentProfileVersion', 'AgentProfile', 'TenantMembership']) {
            await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`, tenants);
        }
    });
    await prisma.registeredAgentTool.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: { in: tenants } } });
    await deleteAuditRowsForTenants(prisma, tenants);
    await prisma.user.deleteMany({ where: { id: { in: [...Object.values(USERS.A), ...Object.values(USERS.B)] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
}

describeFn('a retried Tool Runner run continues its conversation (real DB, fake model)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        for (const t of ['A', 'B'] as const) {
            const tenantId = TENANTS[t];
            await createTenantWithDek({ id: tenantId, name: tenantId, slug: tenantId });
            for (const [id, role] of [
                [USERS[t].owner, 'OWNER'],
                [USERS[t].admin, 'ADMIN'],
            ] as const) {
                const email = `${id}@example.test`;
                await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
                await prisma.tenantMembership.create({ data: { tenantId, userId: id, role: role as Role, status: 'ACTIVE' } });
            }
            const sys = await prisma.aiSystem.create({ data: { tenantId, name: `sys-${AGENTS[t]}` } });
            await prisma.registeredAgent.create({
                data: {
                    id: AGENTS[t],
                    tenantId,
                    aiSystemId: sys.id,
                    name: `agent ${AGENTS[t]}`,
                    autonomyLevel: 1,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: USERS[t].owner,
                    status: 'ACTIVE',
                    riskTier: 'LOW',
                    riskTierScoredAt: new Date(),
                },
            });
            for (const toolName of ['list_risks', 'list_controls']) await grant(t, toolName);
            await prisma.tenantSecuritySettings.create({ data: { tenantId, agentDriver: 'TOOL_RUNNER' } });
            // B's profile compacts once a request would pass 10,000 tokens.
            await createAgentProfile(ctx(t, 'owner'), AGENTS[t], t === 'B' ? { ...version(), compactionThresholdTokens: 10_000 } : version());
            await submitAgentProfileVersion(ctx(t, 'owner'), AGENTS[t], 1);
        }
        installFakeModel();
    });

    beforeEach(async () => {
        _resetInFlightRunsForTesting();
        toolHooks.listRisksCalls = 0;
        toolHooks.duringListRisks = null;
        for (const t of ['A', 'B'] as const) for (const toolName of ['list_risks', 'list_controls']) await grant(t, toolName);
    });

    afterAll(async () => {
        global.fetch = originalFetch;
        _resetInFlightRunsForTesting();
        await cleanup();
        await prisma.$disconnect();
        __resetAuditStreamForTests();
    });

    /**
     * A run whose first attempt completed `turns` turns (each a call to
     * `list_risks` or `list_controls`) and died while the next model call was
     * in flight. Returns what that attempt sent.
     */
    async function diedAfterTurns(t: Tenant, turns: number): Promise<{ runId: string; bodies: Array<Record<string, unknown>> }> {
        const started = await startAgentProfileTestRun(ctx(t, 'admin'), AGENTS[t], 1);
        const script: Reply[] = [];
        for (let i = 0; i < turns; i += 1) {
            script.push(
                toolUse(`toolu_${t}_${i}`, i % 2 === 0 ? 'list_risks' : 'list_controls', i === 0
                    ? [{ type: 'thinking', thinking: `Start with ${MARK[t]}.`, signature: `sig-${t}-Zm9vYmFy` }]
                    : []),
            );
        }
        // The death, while request `turns` (the turn after the last completed one) is in flight.
        const first = await attempt(t, started.runId, script, async (n) => {
            if (n === turns) await dieNow(started.runId);
        });
        expect(first.outcome).toEqual({ skipped: 'LEASE_LOST' });
        expect(first.bodies).toHaveLength(turns + 1);
        return { runId: started.runId, bodies: first.bodies };
    }

    it('continues from the turn after the last completed one: no completed call is made again, and the model is sent the same request', async () => {
        const dead = await diedAfterTurns('A', 2);
        // Turn one called list_risks once; turn two called list_controls.
        expect(toolHooks.listRisksCalls).toBe(1);
        const ledgerBefore = await stepsOf(dead.runId);
        expect(ledgerBefore.map((s) => [s.kind, s.toolCalled, s.status])).toEqual([
            ['MODEL_CALL', null, 'DONE'],
            ['TOOL_CALL', 'list_risks', 'DONE'],
            ['MODEL_CALL', null, 'DONE'],
            ['TOOL_CALL', 'list_controls', 'DONE'],
        ]);

        const second = await attempt('A', dead.runId, [finalAnswer]);
        expect(second.outcome).toEqual({ status: 'COMPLETED', stepFailures: 0 });

        // THE SAME REQUEST: the continued segment's first request is byte for
        // byte the one the dead attempt sent for turn three, thinking block and
        // signature included.
        const sentByTheDead = dead.bodies[2];
        const sentOnContinuing = second.bodies[0];
        expect(JSON.stringify(sentOnContinuing.messages)).toBe(JSON.stringify(sentByTheDead.messages));
        expect(JSON.stringify(sentOnContinuing.system)).toBe(JSON.stringify(sentByTheDead.system));
        expect(JSON.stringify(sentOnContinuing.tools)).toBe(JSON.stringify(sentByTheDead.tools));
        expect(sentOnContinuing.model).toBe(sentByTheDead.model);
        expect(JSON.stringify(sentOnContinuing.messages)).toContain(`sig-A-Zm9vYmFy`);
        expect((sentOnContinuing.messages as unknown[]).length).toBe(5);

        // NOT MADE AGAIN: one model call in the continuation, and no tool.
        expect(second.bodies).toHaveLength(1);
        expect(toolHooks.listRisksCalls).toBe(1);
        const ledger = await stepsOf(dead.runId);
        expect(ledger.filter((s) => s.kind === 'TOOL_CALL').map((s) => s.toolCalled)).toEqual(['list_risks', 'list_controls']);
        expect(ledger.map((s) => s.seq)).toEqual([0, 1, 2, 3, 4]);
    });

    it('a call in flight when the worker died is answered TOOL_CALL_OUTCOME_UNKNOWN, one never started TOOL_CALL_NOT_RUN, and neither is made again', async () => {
        const started = await startAgentProfileTestRun(ctx('A', 'admin'), AGENTS.A, 1);
        // One reply asking for two calls; the worker dies while the first runs.
        toolHooks.duringListRisks = () => dieNow(started.runId);
        const first = await attempt('A', started.runId, [
            {
                content: [
                    { type: 'tool_use', id: 'toolu_inflight', name: 'list_risks', input: {} },
                    { type: 'tool_use', id: 'toolu_never', name: 'list_controls', input: {} },
                ],
                stop_reason: 'tool_use',
            },
        ]);
        expect(first.outcome).toEqual({ skipped: 'LEASE_LOST' });
        expect(toolHooks.listRisksCalls).toBe(1);

        // CIPHERTEXT AT REST, naming the call in flight.
        const stored = await rawCheckpoint(started.runId);
        expect(stored?.transcriptJson).toMatch(/^v[12]:/);
        expect(stored?.resultsJson).toMatch(/^v[12]:/);
        expect(stored?.transcriptJson).not.toContain('toolu_inflight');
        expect(stored?.inFlightToolUseId).toBe('toolu_inflight');

        const second = await attempt('A', started.runId, [finalAnswer]);
        expect(second.outcome).toMatchObject({ status: 'COMPLETED' });
        expect(toolHooks.listRisksCalls).toBe(1);

        const messages = second.bodies[0].messages as Array<{ role: string; content: unknown }>;
        expect(messages[messages.length - 1]).toEqual({
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'toolu_inflight', content: TOOL_CALL_OUTCOME_UNKNOWN_MESSAGE, is_error: true },
                { type: 'tool_result', tool_use_id: 'toolu_never', content: TOOL_CALL_NOT_RUN_MESSAGE, is_error: true },
            ],
        });
        const ledger = await stepsOf(started.runId);
        const answered = ledger.filter((s) => s.kind === 'TOOL_CALL');
        expect(answered.map((s) => [s.toolCalled, s.status])).toEqual([
            ['list_risks', 'FAILED'],
            ['list_controls', 'FAILED'],
        ]);
        expect(await stepOutput('A', started.runId, answered[0].seq)).toMatchObject({ outcome: TOOL_CALL_OUTCOME_UNKNOWN });
        expect(await stepOutput('A', started.runId, answered[1].seq)).toMatchObject({ outcome: TOOL_CALL_NOT_RUN });
    });

    it('the checkpoint is cleared when the run settles, its hash kept, and it is never written again', async () => {
        const dead = await diedAfterTurns('A', 1);
        const before = await rawCheckpoint(dead.runId);
        expect(before?.transcriptJson).toMatch(/^v[12]:/);
        expect(before?.settledAt).toBeNull();

        const second = await attempt('A', dead.runId, [finalAnswer]);
        expect(second.outcome).toMatchObject({ status: 'COMPLETED' });

        const after = await rawCheckpoint(dead.runId);
        expect(after).toMatchObject({ transcriptJson: null, resultsJson: null, inFlightToolUseId: null });
        expect(after?.transcriptHash).toMatch(/^[0-9a-f]{64}$/);
        expect(after?.settledAt).not.toBeNull();
        // A settled checkpoint takes no write, whoever makes it.
        await expect(
            prisma.$executeRaw`UPDATE "WorkflowRunCheckpoint" SET "inFlightToolUseId" = 'x' WHERE "runId" = ${dead.runId}`,
        ).rejects.toThrow(/WORKFLOW_RUN_CHECKPOINT_SETTLED|WorkflowRunCheckpoint_shape/);
    });

    it('a tool withdrawn between the attempts is refused at the continuation, TOOL_WITHDRAWN_BEFORE_CONTINUATION', async () => {
        const dead = await diedAfterTurns('A', 1);
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANTS.A, agentId: AGENTS.A, toolName: 'list_controls' } });

        const second = await attempt('A', dead.runId, [toolUse('toolu_after', 'list_controls'), finalAnswer]);
        expect(second.outcome).toMatchObject({ status: 'COMPLETED' });
        // The stored definitions are sent, so the prefix is unchanged.
        expect((second.bodies[0].tools as Array<{ name: string }>).map((t) => t.name)).toEqual(
            (dead.bodies[1].tools as Array<{ name: string }>).map((t) => t.name),
        );
        const ledger = await stepsOf(dead.runId);
        const refused = ledger.filter((s) => s.kind === 'TOOL_CALL' && s.status === 'FAILED');
        expect(refused.map((s) => s.toolCalled)).toEqual(['list_controls']);
        expect(await stepOutput('A', dead.runId, refused[0].seq)).toEqual({ refused: TOOL_WITHDRAWN_BEFORE_CONTINUATION });
    });

    it("an operator's Abort stops a continued run, and settles its checkpoint", async () => {
        const dead = await diedAfterTurns('A', 1);
        const second = await attempt('A', dead.runId, [toolUse('toolu_more', 'list_risks'), finalAnswer], async (n) => {
            if (n === 0) await abortWorkflowRun(ctx('A', 'admin'), dead.runId);
        });
        expect(second.outcome).toMatchObject({ status: 'ABORTED' });
        expect(second.bodies).toHaveLength(1);
        expect(toolHooks.listRisksCalls).toBe(1);
        expect(await rawCheckpoint(dead.runId)).toMatchObject({ transcriptJson: null, resultsJson: null });
        expect((await rawCheckpoint(dead.runId))?.settledAt).not.toBeNull();
    });

    it('a kill stops a continued run', async () => {
        const dead = await diedAfterTurns('A', 1);
        const second = await attempt('A', dead.runId, [toolUse('toolu_more', 'list_risks'), finalAnswer], async (n) => {
            if (n === 0) {
                await prisma.agentKillSwitch.create({
                    data: { tenantId: TENANTS.A, agentId: AGENTS.A, engagedByUserId: USERS.A.owner, reason: 'stop the continued run' },
                });
            }
        });
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AgentKillSwitch" WHERE "tenantId" = $1`, TENANTS.A);
        });
        expect(second.outcome).toMatchObject({ status: 'ABORTED' });
        expect(second.bodies).toHaveLength(1);
        expect(toolHooks.listRisksCalls).toBe(1);
        const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: dead.runId }, select: { errorMessage: true } });
        expect(run.errorMessage).toMatch(/tool_runner_run_agent_killed/);
        expect((await rawCheckpoint(dead.runId))?.settledAt).not.toBeNull();
    });

    it('the wall clock continues: a continued run gets no time back, and its cap stops it before any call', async () => {
        const dead = await diedAfterTurns('A', 1);
        // The run started two hours ago; its checkpoint recorded seconds of
        // unattended time. Continuing must not measure from the checkpoint.
        await prisma.$executeRaw`UPDATE "WorkflowRun" SET "startedAt" = now() - interval '2 hours' WHERE "id" = ${dead.runId}`;

        const second = await attempt('A', dead.runId, [finalAnswer]);
        expect(second.outcome).toMatchObject({ status: 'FAILED' });
        expect(second.bodies).toHaveLength(0);
        const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: dead.runId }, select: { errorMessage: true } });
        expect(run.errorMessage).toMatch(/RUNTIME_MS|wall|clock|time/i);
        expect((await rawCheckpoint(dead.runId))?.settledAt).not.toBeNull();
    });

    it('after a compaction, the checkpoint keeps the COMPACTED list, and the continuation sends it', async () => {
        const SUMMARY = 'The run read the risk register; nothing was open.';
        const started = await startAgentProfileTestRun(ctx('B', 'admin'), AGENTS.B, 1);
        const dead = await attempt(
            'B',
            started.runId,
            [
                { ...toolUse('toolu_big', 'list_risks'), usage: { input_tokens: 12_000, output_tokens: 5 } },
                // The summary call (tool_choice none).
                { content: [{ type: 'text', text: SUMMARY }], stop_reason: 'end_turn', usage: { input_tokens: 12_100, output_tokens: 20 } },
            ],
            async (n) => {
                if (n === 2) await dieNow(started.runId);
            },
        );
        expect(dead.outcome).toEqual({ skipped: 'LEASE_LOST' });
        expect(dead.bodies[1].tool_choice).toEqual({ type: 'none' });
        // The request after the compaction: opening, run state, summary, last turn, results.
        const compacted = dead.bodies[2].messages as unknown[];
        expect(compacted).toHaveLength(5);
        expect(JSON.stringify(compacted)).toContain(SUMMARY);

        const second = await attempt('B', started.runId, [finalAnswer]);
        expect(second.outcome).toMatchObject({ status: 'COMPLETED' });
        expect(JSON.stringify(second.bodies[0].messages)).toBe(JSON.stringify(compacted));
        expect(toolHooks.listRisksCalls).toBe(1);
    });

    it("two tenants: each continues its own conversation, and neither reads nor writes the other's checkpoint", async () => {
        const a = await diedAfterTurns('A', 1);
        const b = await diedAfterTurns('B', 1);

        // B's context, holding a lease token as a worker does, reads none of
        // A's checkpoint and writes none: the fence finds no run of B's, and
        // RLS hides A's row.
        const asB: RequestContext = { ...ctx('B', 'admin'), runLeaseToken: 'b-worker' };
        expect(await readCheckpoint(asB, a.runId)).toBeNull();
        expect(
            await writeCheckpoint(asB, a.runId, {
                transcriptJson: '{}',
                transcriptHash: '0'.repeat(64),
                resultsJson: '[]',
                resultsHash: '0'.repeat(64),
                atSeq: 0,
                elapsedMs: 0,
                costTokens: 0,
            }),
        ).toBe(false);
        expect(await prisma.workflowRunCheckpoint.count({ where: { runId: a.runId } })).toBe(1);
        expect(await prisma.workflowRunCheckpoint.count({ where: { tenantId: TENANTS.B, runId: a.runId } })).toBe(0);
        // Under B's RLS, even the raw table shows none of A's rows.
        const seenByB = await runInTenantContext(ctx('B', 'admin'), (db) =>
            db.workflowRunCheckpoint.findMany({ where: { runId: { in: [a.runId, b.runId] } }, select: { runId: true } }),
        );
        expect(seenByB.map((r) => r.runId)).toEqual([b.runId]);

        const contA = await attempt('A', a.runId, [finalAnswer]);
        const contB = await attempt('B', b.runId, [finalAnswer]);
        expect(contA.outcome).toMatchObject({ status: 'COMPLETED' });
        expect(contB.outcome).toMatchObject({ status: 'COMPLETED' });
        expect(JSON.stringify(contA.bodies)).toContain(MARK.A);
        expect(JSON.stringify(contA.bodies)).not.toContain(MARK.B);
        expect(JSON.stringify(contB.bodies)).toContain(MARK.B);
        expect(JSON.stringify(contB.bodies)).not.toContain(MARK.A);
    });
});
