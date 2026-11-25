/**
 * A RETRIED MANAGED AGENTS SEGMENT RECONNECTS TO ITS SESSION (#5854, owner
 * decision 2026-11-25), over a real database and a faux Anthropic workspace
 * (`tests/helpers/managed-agents-faux.ts`).
 *
 * Everything is real but Anthropic: the workspace's connection row and its
 * encrypted key, the approval that provisions the version's agent, the
 * Test-run usecase and admission, the worker's own body
 * (`executeQueuedWorkflowRun`) with its run lease, the segment anchor and the
 * checkpoint, the funnel, and the data-lifecycle reconciliation.
 *
 * A WORKER DIES the way the run lease sees one die: its row is moved to a
 * holder that never renews, whose lease has lapsed. The death is placed
 * exactly, through two seams: the faux's `beforeEventsPost`, which kills the
 * worker as it sends a tool result and fails that POST at the network; and
 * `listRisks`, the tool's usecase, which kills it while the call runs. The
 * next execution of the same segment takes the run over.
 *
 *   • One of two calls ran and its result never reached the session: the
 *     takeover reconnects, sends the KEPT result, answers the other
 *     `TOOL_CALL_NOT_RUN`, runs neither again, and finishes. The dead worker
 *     left the session alone (no answer, no interrupt, no delete).
 *   • The worker died WHILE the first call ran: it is answered
 *     `TOOL_CALL_OUTCOME_UNKNOWN`, the other `TOOL_CALL_NOT_RUN`.
 *   • A session that is gone, or that Anthropic ended, settles the run FAILED
 *     by name; no second session is made.
 *   • A Console edit since the first attempt refuses the reconnect, and the
 *     session is deleted.
 *   • The abandoned-session reconciliation does not touch the session of a
 *     RUNNING run, even one past the abandon age and while its segment is
 *     reconnecting; once the run has ended, it does.
 *   • An operator's Abort and a kill still stop a reconnected run, and its
 *     session is deleted.
 */
const mockTool = {
    calls: 0,
    /** Run once, inside the next `listRisks`, before it answers. */
    during: null as null | (() => Promise<void>),
};
jest.mock('@/app-layer/usecases/risk', () => {
    const actual = jest.requireActual('@/app-layer/usecases/risk');
    return {
        ...actual,
        listRisks: jest.fn(async (...args: unknown[]) => {
            mockTool.calls += 1;
            const during = mockTool.during;
            mockTool.during = null;
            if (during) await during();
            return (actual.listRisks as (...a: unknown[]) => unknown)(...args);
        }),
    };
});
const envOverride: Record<string, string | undefined> = {
    AGENT_PROFILES: '1',
    AGENT_MANAGED_AGENTS: '1',
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

import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { ManagedAgentsFaux } from '../helpers/managed-agents-faux';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants, deleteAuditRowsForUsers } from '../helpers/audit-cleanup';
import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { DRIVER_IMPLEMENTED } from '@/lib/agentic/agent-driver';
import { environmentBodyFor } from '@/lib/agentic/managed-agents/definition';
import { _resetInFlightRunsForTesting } from '@/lib/agentic/in-flight-runs';
import type { RunLeaseTiming } from '@/lib/agentic/run-lease';
import { TOOL_CALL_NOT_RUN, TOOL_CALL_OUTCOME_UNKNOWN } from '@/lib/agentic/tool-runner/transcript';
import { abortWorkflowRun, executeQueuedWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { ABANDONED_SESSION_MIN_AGE_MS, reconcileLostSessionDeletes } from '@/app-layer/usecases/managed-agents-cleanup';
import {
    approveAgentProfileVersion,
    createAgentProfile,
    startAgentProfileTestRun,
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import type { RequestContext } from '@/app-layer/types';
import { prisma as appPrisma } from '@/lib/prisma';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE && DRIVER_IMPLEMENTED['managed-agents'] ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `mar-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USERS = { author: `u-author-${SUITE}`, reviewer: `u-reviewer-${SUITE}` };
const AGENT = `ag-${SUITE}`;
const KEY = 'sk-ant-faux-workspace-key-for-reconnect'; // pragma: allowlist secret -- a placeholder for the faux
const TIMING: RunLeaseTiming = { ttlMs: 2_000, renewMs: 150 };

const ctxFor = (role: Role, userId: string): RequestContext =>
    makeRequestContext(role, { tenantId: TENANT, tenantSlug: TENANT, userId });
const author = () => ctxFor('OWNER', USERS.author);
const reviewer = () => ctxFor('ADMIN', USERS.reviewer);

const version = (): AgentProfileVersionInput => ({
    instructions: 'Summarise the open risks for the weekly review. Call list_risks twice, then answer in one sentence.',
    toolNames: ['list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN'],
});

let faux: ManagedAgentsFaux;
let connectionId = '';
let environmentId = '';

/** The model asks for TWO calls in one turn, then answers. */
const TWO_CALLS_THEN_ANSWER = [
    { toolCalls: [{ name: 'list_risks', args: {} }, { name: 'list_risks', args: { status: 'OPEN' } }] },
    { text: 'There are no open risks to report this week.' },
];

/** The worker holding the run dies: a holder that never renews, whose lease has lapsed. */
async function dieNow(runId: string): Promise<void> {
    await prisma.$executeRaw`UPDATE "WorkflowRun" SET "leaseHolder" = 'a-worker-that-died', "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = ${runId}`;
}

const execute = (runId: string, segment: number) => executeQueuedWorkflowRun(TENANT, runId, { leaseTiming: TIMING, segment });

async function newRun(): Promise<{ runId: string; segment: number }> {
    const started = await startAgentProfileTestRun(reviewer(), AGENT, 1);
    const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { startedAt: true } });
    return { runId: started.runId, segment: row.startedAt.getTime() };
}

/** The run's one session in the workspace: the one its metadata names. */
function sessionsOf(runId: string): string[] {
    return [...faux.sessions.values()]
        .filter((s) => (s.metadata as Record<string, string> | null)?.inflect_run === runId)
        .map((s) => s.id);
}

function callIdsOf(sessionId: string): string[] {
    return (faux.sessions.get(sessionId)?.history ?? []).filter((e) => e.type === 'agent.custom_tool_use').map((e) => e.id);
}

/** Every result the session received, in order. */
function resultsTo(sessionId: string): Array<{ id: string; isError: boolean; text: string }> {
    const ids = new Set(callIdsOf(sessionId));
    return faux.toolResults.filter((r) => ids.has(r.id));
}

async function stepsOf(runId: string): Promise<Array<{ kind: string; status: string; toolCalled: string | null; input: Record<string, unknown>; output: Record<string, unknown> }>> {
    const steps = await runInTenantContext(author(), (db) =>
        db.workflowStep.findMany({
            where: { tenantId: TENANT, runId },
            orderBy: { seq: 'asc' },
            select: { kind: true, status: true, toolCalled: true, inputJson: true, outputJson: true },
        }),
    );
    return steps.map((s) => ({
        kind: s.kind,
        status: s.status,
        toolCalled: s.toolCalled,
        input: JSON.parse(s.inputJson ?? '{}') as Record<string, unknown>,
        output: JSON.parse(s.outputJson ?? '{}') as Record<string, unknown>,
    }));
}

async function lifecycles(runId: string): Promise<string[]> {
    return (await stepsOf(runId)).filter((s) => s.kind === 'SYNTHESIS').map((s) => String(s.input.lifecycle));
}

const runRow = (runId: string) =>
    prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true, errorMessage: true } });

/**
 * THE FIRST ATTEMPT: the model asks for two calls, the first runs, and the
 * worker dies as it sends that call's result (the session never receives it).
 * Returns what the dead attempt tried to send, which the takeover must send.
 */
async function firstAttemptDiesAfterOneCall(runId: string, segment: number): Promise<{ sessionId: string; dropped: Array<Record<string, unknown>> }> {
    faux.script(TWO_CALLS_THEN_ANSWER);
    const dropped: Array<Record<string, unknown>> = [];
    faux.beforeEventsPost = async (_sid, events) => {
        if (!events.some((e) => e.type === 'user.custom_tool_result')) return undefined;
        faux.beforeEventsPost = null;
        dropped.push(...events);
        await dieNow(runId);
        return 'DROP';
    };
    expect(await execute(runId, segment)).toEqual({ skipped: 'LEASE_LOST' });
    faux.beforeEventsPost = null;
    const [sessionId] = sessionsOf(runId);
    return { sessionId, dropped };
}

async function cleanup(): Promise<void> {
    await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } });
    await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        for (const table of [
            'WorkflowRunCheckpoint',
            'AiDecisionLog',
            'AgentKillSwitch',
            'AgentProfileVersion',
            'AgentProfile',
            'TenantMembership',
            'ManagedAgentsCleanup',
        ]) {
            await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = $1`, TENANT);
        }
    });
    await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
    await prisma.agentProfileProvision.deleteMany({ where: { tenantId: TENANT } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
    await deleteAuditRowsForTenants(prisma, [TENANT]).catch(() => undefined);
    await deleteAuditRowsForUsers(prisma, Object.values(USERS)).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: Object.values(USERS) } } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

describeFn('a retried Managed Agents segment reconnects to its session (real DB, faux workspace, #5854)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        faux = new ManagedAgentsFaux();
        faux.install();
        await createTenantWithDek({ id: TENANT, name: TENANT, slug: TENANT });
        for (const [id, role] of [[USERS.author, 'OWNER'], [USERS.reviewer, 'ADMIN']] as const) {
            const email = `${id}@example.test`;
            await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
            await prisma.tenantMembership.create({ data: { tenantId: TENANT, userId: id, role, status: 'ACTIVE' } });
        }
        const sys = await prisma.aiSystem.create({ data: { tenantId: TENANT, name: `sys-${AGENT}` } });
        await prisma.registeredAgent.create({
            data: {
                id: AGENT,
                tenantId: TENANT,
                aiSystemId: sys.id,
                name: `agent ${AGENT}`,
                autonomyLevel: 1,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: USERS.author,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
            },
        });
        await prisma.registeredAgentTool.create({
            data: { tenantId: TENANT, agentId: AGENT, toolName: 'list_risks', grantedByUserId: USERS.author },
        });
        connectionId = (
            await prisma.integrationConnection.create({
                data: {
                    tenantId: TENANT,
                    provider: 'anthropic-workspace',
                    name: 'Anthropic workspace',
                    configJson: { workspaceId: 'wrkspc_reconnect' },
                    secretEncrypted: encryptField(JSON.stringify({ apiKey: KEY })),
                },
                select: { id: true },
            })
        ).id;
        await prisma.tenantSecuritySettings.create({ data: { tenantId: TENANT, agentDriver: 'MANAGED_AGENTS' } });
        const v1 = await createAgentProfile(author(), AGENT, version());
        await submitAgentProfileVersion(author(), AGENT, 1);
        await approveAgentProfileVersion(reviewer(), AGENT, 1, { instructionsHash: v1.instructionsHash });
        environmentId = (await prisma.agentProfileProvision.findFirstOrThrow({ where: { tenantId: TENANT, connectionId }, select: { environmentId: true } })).environmentId;
    });

    beforeEach(() => {
        _resetInFlightRunsForTesting();
        mockTool.calls = 0;
        mockTool.during = null;
        faux.beforeEventsPost = null;
    });

    afterAll(async () => {
        _resetInFlightRunsForTesting();
        await cleanup();
        faux.uninstall();
        await appPrisma.$disconnect();
        await prisma.$disconnect();
        __resetAuditStreamForTests();
    });

    it('one of two calls ran: the takeover reconnects, sends the kept result, answers the other TOOL_CALL_NOT_RUN, runs neither again, and finishes', async () => {
        const { runId, segment } = await newRun();
        const { sessionId, dropped } = await firstAttemptDiesAfterOneCall(runId, segment);
        expect(mockTool.calls).toBe(1);
        // THE DEAD WORKER LEFT THE SESSION TO ITS SUCCESSOR: nothing answered,
        // nothing interrupted, nothing deleted.
        expect(faux.holdsSession(sessionId)).toBe(true);
        expect(faux.interrupts).not.toContain(sessionId);
        expect(resultsTo(sessionId)).toEqual([]);
        const [first, second] = callIdsOf(sessionId);
        const keptText = String(((dropped[0].content as Array<{ text: string }>) ?? [])[0]?.text);

        expect(await execute(runId, segment)).toMatchObject({ status: 'COMPLETED' });
        // NEITHER CALL IS RUN AGAIN.
        expect(mockTool.calls).toBe(1);
        // ONE session for the segment, reconnected to, then deleted at settle.
        expect(sessionsOf(runId)).toEqual([sessionId]);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        expect(faux.holdsSession(sessionId)).toBe(false);
        // The kept result as the dead attempt would have sent it, then the other NOT RUN.
        expect(resultsTo(sessionId)).toEqual([
            { id: first, isError: false, text: keptText },
            { id: second, isError: true, text: expect.stringMatching(new RegExp(`^${TOOL_CALL_NOT_RUN}: `)) },
        ]);
        expect(faux.unexpectedResults).toEqual([]);

        const steps = await stepsOf(runId);
        expect(steps.filter((s) => s.kind === 'TOOL_CALL').map((s) => ({ status: s.status, tool: s.toolCalled, outcome: s.output.outcome ?? null }))).toEqual([
            { status: 'DONE', tool: 'list_risks', outcome: null },
            { status: 'FAILED', tool: 'list_risks', outcome: TOOL_CALL_NOT_RUN },
        ]);
        // The first model call of the reconnected segment says so, and from which event.
        const calls = steps.filter((s) => s.kind === 'MODEL_CALL');
        expect(calls).toHaveLength(2);
        expect(calls[0].input.reconnectedToSession).toBeUndefined();
        expect(calls[1].input).toMatchObject({ reconnectedToSession: sessionId, reconnectedAfterEventId: expect.stringMatching(/^sevt_/) });
        expect(await runRow(runId)).toMatchObject({ status: 'COMPLETED' });
    });

    it('the worker died while the first call ran: it is answered TOOL_CALL_OUTCOME_UNKNOWN and the other TOOL_CALL_NOT_RUN, and neither is run again', async () => {
        const { runId, segment } = await newRun();
        faux.script(TWO_CALLS_THEN_ANSWER);
        mockTool.during = () => dieNow(runId);
        expect(await execute(runId, segment)).toEqual({ skipped: 'LEASE_LOST' });
        expect(mockTool.calls).toBe(1);
        const [sessionId] = sessionsOf(runId);
        expect(faux.holdsSession(sessionId)).toBe(true);
        const [first, second] = callIdsOf(sessionId);

        expect(await execute(runId, segment)).toMatchObject({ status: 'COMPLETED' });
        expect(mockTool.calls).toBe(1);
        expect(sessionsOf(runId)).toEqual([sessionId]);
        expect(resultsTo(sessionId)).toEqual([
            { id: first, isError: true, text: expect.stringMatching(new RegExp(`^${TOOL_CALL_OUTCOME_UNKNOWN}: `)) },
            { id: second, isError: true, text: expect.stringMatching(new RegExp(`^${TOOL_CALL_NOT_RUN}: `)) },
        ]);
        const toolSteps = (await stepsOf(runId)).filter((s) => s.kind === 'TOOL_CALL');
        // The dead worker's own step never landed: it was fenced.
        expect(toolSteps.map((s) => ({ status: s.status, outcome: s.output.outcome }))).toEqual([
            { status: 'FAILED', outcome: TOOL_CALL_OUTCOME_UNKNOWN },
            { status: 'FAILED', outcome: TOOL_CALL_NOT_RUN },
        ]);
        expect(faux.holdsSession(sessionId)).toBe(false);
    });

    it('a session that is gone settles the run FAILED by name, and no second session is made', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await firstAttemptDiesAfterOneCall(runId, segment);
        const gone = faux.sessions.get(sessionId);
        if (gone) gone.deleted = true;

        expect(await execute(runId, segment)).toMatchObject({ status: 'FAILED' });
        expect((await runRow(runId)).errorMessage).toMatch(/^managed_agents_reconnect_session_gone: /);
        expect(sessionsOf(runId)).toEqual([sessionId]);
        expect(mockTool.calls).toBe(1);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
    });

    it('a session Anthropic ended settles the run FAILED by name, and is deleted', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await firstAttemptDiesAfterOneCall(runId, segment);
        const ended = faux.sessions.get(sessionId);
        if (ended) ended.status = 'terminated';

        expect(await execute(runId, segment)).toMatchObject({ status: 'FAILED' });
        expect((await runRow(runId)).errorMessage).toMatch(/^managed_agents_reconnect_session_terminated: /);
        expect(sessionsOf(runId)).toEqual([sessionId]);
        expect(faux.holdsSession(sessionId)).toBe(false);
        expect(mockTool.calls).toBe(1);
    });

    it('a Console edit since the first attempt refuses the reconnect, and the session is deleted', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await firstAttemptDiesAfterOneCall(runId, segment);
        faux.consoleEditEnvironment(environmentId, (c) => ({ ...c, networking: { type: 'limited', allowed_hosts: ['evil.example'] } }));
        try {
            expect(await execute(runId, segment)).toMatchObject({ status: 'FAILED' });
        } finally {
            faux.consoleEditEnvironment(environmentId, () => ({ ...environmentBodyFor(connectionId).config }));
        }
        const row = await runRow(runId);
        expect(row.errorMessage).toMatch(/^managed_agents_environment_drifted: .*\(CONFIG_CHANGED\)\. The run had begun in a session/);
        expect(sessionsOf(runId)).toEqual([sessionId]);
        expect(faux.holdsSession(sessionId)).toBe(false);
        expect(resultsTo(sessionId)).toEqual([]);
        expect(mockTool.calls).toBe(1);
    });

    it('the abandoned-session reconciliation leaves the session of a RUNNING run alone, dead worker or reconnecting segment, and settles it once the run has ended', async () => {
        const past = () => new Date(Date.now() + ABANDONED_SESSION_MIN_AGE_MS + 60_000);
        const { runId, segment } = await newRun();
        const { sessionId } = await firstAttemptDiesAfterOneCall(runId, segment);

        // The worker is dead and nobody holds a live lease: the session is past
        // the abandon age, but its run is RUNNING and a retry is on its way.
        await reconcileLostSessionDeletes({ now: past() });
        expect(faux.holdsSession(sessionId)).toBe(true);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED']);

        // THE RACE: the pass runs while the takeover is reconnecting, between
        // its read of the history and its answers reaching the session.
        const during: { held: boolean | null; lifecycles: string[] } = { held: null, lifecycles: [] };
        faux.beforeEventsPost = async (sid, events) => {
            if (sid !== sessionId || !events.some((e) => e.type === 'user.custom_tool_result')) return undefined;
            faux.beforeEventsPost = null;
            await reconcileLostSessionDeletes({ now: past() });
            during.held = faux.holdsSession(sessionId);
            during.lifecycles = await lifecycles(runId);
            return undefined;
        };
        expect(await execute(runId, segment)).toMatchObject({ status: 'COMPLETED' });
        expect(during).toEqual({ held: true, lifecycles: ['SESSION_CREATED'] });
        // Settled ONCE, by the run itself.
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        expect(faux.holdsSession(sessionId)).toBe(false);

        // The positive control: a run that ended without settling its session
        // (the reaper failed it) has it settled by the pass.
        const other = await newRun();
        const left = await firstAttemptDiesAfterOneCall(other.runId, other.segment);
        await prisma.workflowRun.update({
            where: { id: other.runId },
            data: { status: 'FAILED', leaseHolder: null, leaseExpiresAt: null, completedAt: new Date() },
        });
        await reconcileLostSessionDeletes({ now: past() });
        expect(faux.holdsSession(left.sessionId)).toBe(false);
        expect(await lifecycles(other.runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
    });

    it('an operator\'s Abort stops a reconnected run, and its session is deleted', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await firstAttemptDiesAfterOneCall(runId, segment);
        faux.beforeEventsPost = async (sid, events) => {
            if (sid !== sessionId || !events.some((e) => e.type === 'user.custom_tool_result')) return undefined;
            faux.beforeEventsPost = null;
            await abortWorkflowRun(reviewer(), runId);
            return undefined;
        };
        expect(await execute(runId, segment)).toMatchObject({ status: 'ABORTED' });
        const row = await runRow(runId);
        expect(row.status).toBe('ABORTED');
        expect(row.errorMessage).toMatch(/^run_aborted_by_operator: /);
        expect(faux.holdsSession(sessionId)).toBe(false);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        expect(mockTool.calls).toBe(1);
    });

    it('a kill stops a reconnected run, and its session is deleted', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await firstAttemptDiesAfterOneCall(runId, segment);
        faux.beforeEventsPost = async (sid, events) => {
            if (sid !== sessionId || !events.some((e) => e.type === 'user.custom_tool_result')) return undefined;
            faux.beforeEventsPost = null;
            await prisma.agentKillSwitch.create({
                data: { tenantId: TENANT, agentId: AGENT, engagedByUserId: USERS.author, reason: 'reconnect kill drill' },
            });
            return undefined;
        };
        expect(await execute(runId, segment)).toMatchObject({ status: 'ABORTED' });
        const row = await runRow(runId);
        expect(row.status).toBe('ABORTED');
        expect(row.errorMessage).toMatch(/^managed_agents_run_agent_killed: /);
        expect(faux.interrupts).toContain(sessionId);
        expect(faux.holdsSession(sessionId)).toBe(false);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        expect(mockTool.calls).toBe(1);
    });
});
