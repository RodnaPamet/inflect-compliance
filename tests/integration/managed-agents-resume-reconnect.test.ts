/**
 * A PERSON'S RESUME OF A PAUSED MANAGED AGENTS RUN RECONNECTS TO ITS SESSION
 * (#5854, the owner's second decision of 2026-11-25), over a real database and
 * a faux Anthropic workspace (`tests/helpers/managed-agents-faux.ts`).
 *
 * Everything is real but Anthropic: the connection and its encrypted key, the
 * approval that provisions the version's agent, the Test-run usecase, the
 * worker's own body (`executeQueuedWorkflowRun`) with its run lease and the
 * segment anchor, the SIGTERM drain (`pauseInFlightRuns`, the shutdown
 * handler's own stage), the person's resume (`resumeWorkflowRun`, whose job is
 * captured from the queue and run with the worker's body), the operator's
 * Abort and the data-lifecycle reconciliation.
 *
 * THE DRAIN is placed exactly, through two seams: the faux's
 * `beforeEventsPost`, which drains as the worker sends a call's result and
 * fails that POST at the network (the process going down); and `listRisks`,
 * the tool's usecase, which drains while the call runs.
 *
 *   • The drain pauses a run after one call: the session is left open, its
 *     calls unanswered and uninterrupted. A person's resume reconnects, sends
 *     the kept result, answers the other call TOOL_CALL_NOT_RUN, runs neither
 *     again, and finishes; the session is deleted at settle.
 *   • The drain lands while the call runs: TOOL_CALL_OUTCOME_UNKNOWN.
 *   • A session that is gone, or that Anthropic ended, settles the resumed run
 *     FAILED by name, and no second session is made.
 *   • The reconciliation leaves a PAUSED run's session alone within the hold,
 *     and settles it after, however old the session is; a resume then fails
 *     by name. A resume claimed past the resume window settles the session
 *     itself and fails by name.
 *   • An operator's Abort of a PAUSED run deletes its session, and a
 *     retirement of its agent has the next reconciliation pass delete it.
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
import { enqueue } from '@/app-layer/jobs/queue';
import type { AgentRunExecutePayload } from '@/app-layer/jobs/types';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { DRIVER_IMPLEMENTED } from '@/lib/agentic/agent-driver';
import { _resetInFlightRunsForTesting, pauseInFlightRuns } from '@/lib/agentic/in-flight-runs';
import { PAUSED_SESSION_HOLD_MS, PAUSED_SESSION_RESUME_WINDOW_MS } from '@/lib/agentic/managed-agents/session-ledger';
import type { RunLeaseTiming } from '@/lib/agentic/run-lease';
import { TOOL_CALL_NOT_RUN, TOOL_CALL_OUTCOME_UNKNOWN } from '@/lib/agentic/tool-runner/transcript';
import { abortWorkflowRun, executeQueuedWorkflowRun, resumeWorkflowRun } from '@/app-layer/usecases/workflow-runs';
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

const SUITE = `marr-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USERS = { author: `u-author-${SUITE}`, reviewer: `u-reviewer-${SUITE}` };
const AGENT = `ag-${SUITE}`;
const KEY = 'sk-ant-faux-workspace-key-for-resume'; // pragma: allowlist secret -- a placeholder for the faux
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

/** The model asks for TWO calls in one turn, then answers. */
const TWO_CALLS_THEN_ANSWER = [
    { toolCalls: [{ name: 'list_risks', args: {} }, { name: 'list_risks', args: { status: 'OPEN' } }] },
    { text: 'There are no open risks to report this week.' },
];

const execute = (runId: string, payload: { segment: number; pausedAt?: number; clockBase?: number }) =>
    executeQueuedWorkflowRun(TENANT, runId, { leaseTiming: TIMING, ...payload });

async function newRun(): Promise<{ runId: string; segment: number }> {
    const started = await startAgentProfileTestRun(reviewer(), AGENT, 1);
    const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { startedAt: true } });
    return { runId: started.runId, segment: row.startedAt.getTime() };
}

/** THE SIGTERM DRAIN, as the shutdown handler runs it: this process's runs, PAUSED, their leases released. */
async function drain(): Promise<void> {
    const outcome = await pauseInFlightRuns(5_000);
    expect(outcome).toMatchObject({ attempted: 1, paused: 1, timedOut: false });
}

/** A person resumes the run; the job the resume enqueued, as the worker receives it. */
async function resumeAsAPerson(runId: string): Promise<AgentRunExecutePayload> {
    const queue = enqueue as unknown as jest.Mock;
    queue.mockClear();
    expect(await resumeWorkflowRun(reviewer(), runId)).toEqual({ status: 'RUNNING', stepFailures: 0 });
    const call = queue.mock.calls.find((c) => c[0] === 'agent-run-execute');
    expect(call).toBeDefined();
    return call?.[1] as AgentRunExecutePayload;
}

/** The run's sessions in the workspace: the ones its metadata names. */
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
    prisma.workflowRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, errorMessage: true, leaseHolder: true, updatedAt: true },
    });

/**
 * THE FIRST SEGMENT: the model asks for two calls, the first runs and its
 * result is kept, and the drain pauses the run as the worker sends that
 * result (the process going down: the session never receives it). Returns
 * what the worker tried to send, which the resume must send.
 */
async function drainedAfterOneCall(runId: string, segment: number): Promise<{ sessionId: string; dropped: Array<Record<string, unknown>> }> {
    faux.script(TWO_CALLS_THEN_ANSWER);
    const dropped: Array<Record<string, unknown>> = [];
    faux.beforeEventsPost = async (_sid, events) => {
        if (!events.some((e) => e.type === 'user.custom_tool_result')) return undefined;
        faux.beforeEventsPost = null;
        dropped.push(...events);
        await drain();
        return 'DROP';
    };
    expect(await execute(runId, { segment })).toEqual({ skipped: 'LEASE_LOST' });
    faux.beforeEventsPost = null;
    const [sessionId] = sessionsOf(runId);
    return { sessionId, dropped };
}

/** Move the pause back in time, as a run that has waited that long. */
async function pausedAgo(runId: string, ms: number): Promise<void> {
    await prisma.$executeRaw`UPDATE "WorkflowRun" SET "updatedAt" = now() - (${ms}::bigint * interval '1 millisecond') WHERE "id" = ${runId}`;
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

describeFn('a person\'s resume of a paused Managed Agents run reconnects to its session (real DB, faux workspace, #5854)', () => {
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
        await prisma.integrationConnection.create({
            data: {
                tenantId: TENANT,
                provider: 'anthropic-workspace',
                name: 'Anthropic workspace',
                configJson: { workspaceId: 'wrkspc_resume' },
                secretEncrypted: encryptField(JSON.stringify({ apiKey: KEY })),
            },
        });
        await prisma.tenantSecuritySettings.create({ data: { tenantId: TENANT, agentDriver: 'MANAGED_AGENTS' } });
        const v1 = await createAgentProfile(author(), AGENT, version());
        await submitAgentProfileVersion(author(), AGENT, 1);
        await approveAgentProfileVersion(reviewer(), AGENT, 1, { instructionsHash: v1.instructionsHash });
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

    it('the drain pauses a run after one call and leaves its session open; a person\'s resume reconnects, answers the calls, runs nothing again, and finishes', async () => {
        const { runId, segment } = await newRun();
        const { sessionId, dropped } = await drainedAfterOneCall(runId, segment);
        expect(mockTool.calls).toBe(1);
        // PAUSED, its lease released, and the session LEFT FOR THE RESUME:
        // nothing answered, nothing interrupted, nothing deleted.
        expect(await runRow(runId)).toMatchObject({ status: 'PAUSED', leaseHolder: null });
        expect(faux.holdsSession(sessionId)).toBe(true);
        expect(faux.interrupts).not.toContain(sessionId);
        expect(resultsTo(sessionId)).toEqual([]);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED']);
        const [first, second] = callIdsOf(sessionId);
        const keptText = String(((dropped[0].content as Array<{ text: string }>) ?? [])[0]?.text);

        const job = await resumeAsAPerson(runId);
        expect(job.pausedAt).toEqual(expect.any(Number));
        expect(await execute(runId, { segment: job.segment as number, pausedAt: job.pausedAt, clockBase: job.clockBase })).toMatchObject({ status: 'COMPLETED' });
        // NEITHER CALL IS RUN AGAIN, and ONE session served both segments.
        expect(mockTool.calls).toBe(1);
        expect(sessionsOf(runId)).toEqual([sessionId]);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        expect(faux.holdsSession(sessionId)).toBe(false);
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
        // The resumed segment's first model call records the reconnect.
        const calls = steps.filter((s) => s.kind === 'MODEL_CALL');
        expect(calls).toHaveLength(2);
        expect(calls[0].input.reconnectedToSession).toBeUndefined();
        expect(calls[1].input).toMatchObject({ reconnectedToSession: sessionId, reconnectedAfterEventId: expect.stringMatching(/^sevt_/) });
        expect(await runRow(runId)).toMatchObject({ status: 'COMPLETED' });
    });

    it('the drain lands while the first call runs: the resume answers it TOOL_CALL_OUTCOME_UNKNOWN and the other TOOL_CALL_NOT_RUN, and runs neither again', async () => {
        const { runId, segment } = await newRun();
        faux.script(TWO_CALLS_THEN_ANSWER);
        mockTool.during = () => drain();
        expect(await execute(runId, { segment })).toEqual({ skipped: 'LEASE_LOST' });
        expect(mockTool.calls).toBe(1);
        const [sessionId] = sessionsOf(runId);
        expect(faux.holdsSession(sessionId)).toBe(true);
        expect(resultsTo(sessionId)).toEqual([]);
        const [first, second] = callIdsOf(sessionId);

        const job = await resumeAsAPerson(runId);
        expect(await execute(runId, { segment: job.segment as number, pausedAt: job.pausedAt })).toMatchObject({ status: 'COMPLETED' });
        expect(mockTool.calls).toBe(1);
        expect(sessionsOf(runId)).toEqual([sessionId]);
        expect(resultsTo(sessionId)).toEqual([
            { id: first, isError: true, text: expect.stringMatching(new RegExp(`^${TOOL_CALL_OUTCOME_UNKNOWN}: `)) },
            { id: second, isError: true, text: expect.stringMatching(new RegExp(`^${TOOL_CALL_NOT_RUN}: `)) },
        ]);
        expect(faux.holdsSession(sessionId)).toBe(false);
    });

    it('a resume after the session was deleted in the workspace settles the run FAILED by name, and no second session is made', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await drainedAfterOneCall(runId, segment);
        const gone = faux.sessions.get(sessionId);
        if (gone) gone.deleted = true;

        const job = await resumeAsAPerson(runId);
        expect(await execute(runId, { segment: job.segment as number, pausedAt: job.pausedAt })).toMatchObject({ status: 'FAILED' });
        expect((await runRow(runId)).errorMessage).toMatch(/^managed_agents_reconnect_session_gone: /);
        expect(sessionsOf(runId)).toEqual([sessionId]);
        expect(mockTool.calls).toBe(1);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
    });

    it('a resume after Anthropic ended the session settles the run FAILED by name, and deletes it', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await drainedAfterOneCall(runId, segment);
        const ended = faux.sessions.get(sessionId);
        if (ended) ended.status = 'terminated';

        const job = await resumeAsAPerson(runId);
        expect(await execute(runId, { segment: job.segment as number, pausedAt: job.pausedAt })).toMatchObject({ status: 'FAILED' });
        expect((await runRow(runId)).errorMessage).toMatch(/^managed_agents_reconnect_session_terminated: /);
        expect(sessionsOf(runId)).toEqual([sessionId]);
        expect(faux.holdsSession(sessionId)).toBe(false);
        expect(mockTool.calls).toBe(1);
    });

    it('the reconciliation leaves a PAUSED run\'s session alone within the hold, also while the resume reconnects, and the resume finishes in it', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await drainedAfterOneCall(runId, segment);
        // The pass runs when the session is past the abandon age and the run
        // has been PAUSED for all but an hour of the hold.
        const passAt = Date.now() + ABANDONED_SESSION_MIN_AGE_MS + 60_000;
        await pausedAgo(runId, PAUSED_SESSION_HOLD_MS - 60 * 60_000 - (passAt - Date.now()));
        await reconcileLostSessionDeletes({ now: new Date(passAt) });
        expect(faux.holdsSession(sessionId)).toBe(true);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED']);

        // A pass run WHILE the resumed segment reconnects (its run RUNNING) leaves it too.
        await pausedAgo(runId, 60_000);
        const job = await resumeAsAPerson(runId);
        const during: { held: boolean | null; lifecycles: string[] } = { held: null, lifecycles: [] };
        faux.beforeEventsPost = async (sid, events) => {
            if (sid !== sessionId || !events.some((e) => e.type === 'user.custom_tool_result')) return undefined;
            faux.beforeEventsPost = null;
            await reconcileLostSessionDeletes({ now: new Date(Date.now() + PAUSED_SESSION_HOLD_MS + 60 * 60_000) });
            during.held = faux.holdsSession(sessionId);
            during.lifecycles = await lifecycles(runId);
            return undefined;
        };
        expect(await execute(runId, { segment: job.segment as number, pausedAt: job.pausedAt })).toMatchObject({ status: 'COMPLETED' });
        expect(during).toEqual({ held: true, lifecycles: ['SESSION_CREATED'] });
        // Settled ONCE, by the run itself.
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        expect(mockTool.calls).toBe(1);
    });

    it('past the hold, the reconciliation settles a PAUSED run\'s session, and a later resume fails by name without a second session', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await drainedAfterOneCall(runId, segment);
        // The pass runs a minute after the hold has passed (and long after the
        // abandon age); the run is still PAUSED.
        await reconcileLostSessionDeletes({ now: new Date((await runRow(runId)).updatedAt.getTime() + PAUSED_SESSION_HOLD_MS + 60_000) });
        expect(faux.holdsSession(sessionId)).toBe(false);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        // The run is still PAUSED: the pass settles the session, never the run.
        expect((await runRow(runId)).status).toBe('PAUSED');

        const job = await resumeAsAPerson(runId);
        expect(await execute(runId, { segment: job.segment as number, pausedAt: job.pausedAt })).toMatchObject({ status: 'FAILED' });
        expect((await runRow(runId)).errorMessage).toMatch(/^managed_agents_reconnect_session_settled_while_paused: /);
        expect(sessionsOf(runId)).toEqual([sessionId]);
        expect(mockTool.calls).toBe(1);
    });

    it('past the hold, a PAUSED run\'s session is settled even when it was created before the reconciliation\'s lookback', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await drainedAfterOneCall(runId, segment);
        // A session carried across resumes for longer than the lookback: its
        // CREATED step is older than any step the lookback reads.
        await prisma.$executeRaw`UPDATE "WorkflowStep" SET "at" = now() - interval '30 days' WHERE "runId" = ${runId}`;
        await reconcileLostSessionDeletes({ now: new Date((await runRow(runId)).updatedAt.getTime() + PAUSED_SESSION_HOLD_MS + 60_000) });
        expect(faux.holdsSession(sessionId)).toBe(false);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        expect((await runRow(runId)).status).toBe('PAUSED');
    });

    it('a resume claimed past the resume window settles the session itself and fails by name, even before the reconciliation has run', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await drainedAfterOneCall(runId, segment);
        await pausedAgo(runId, PAUSED_SESSION_RESUME_WINDOW_MS + 60_000);

        const job = await resumeAsAPerson(runId);
        expect(await execute(runId, { segment: job.segment as number, pausedAt: job.pausedAt })).toMatchObject({ status: 'FAILED' });
        expect((await runRow(runId)).errorMessage).toMatch(/^managed_agents_reconnect_resumed_too_late: /);
        expect(faux.holdsSession(sessionId)).toBe(false);
        expect(resultsTo(sessionId)).toEqual([]);
        expect(sessionsOf(runId)).toEqual([sessionId]);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        expect(mockTool.calls).toBe(1);
    });

    it('an operator\'s Abort of a PAUSED run deletes its session by its recorded id', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await drainedAfterOneCall(runId, segment);
        expect(faux.holdsSession(sessionId)).toBe(true);

        await abortWorkflowRun(reviewer(), runId);
        expect(await runRow(runId)).toMatchObject({ status: 'ABORTED', errorMessage: expect.stringMatching(/^run_aborted_by_operator: /) });
        expect(faux.holdsSession(sessionId)).toBe(false);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
        expect(mockTool.calls).toBe(1);
    });

    // LAST: a retirement is terminal, and every test above runs this agent.
    it('a retirement settles a PAUSED run\'s session at the next pass, inside the hold: the run can never be resumed', async () => {
        const { runId, segment } = await newRun();
        const { sessionId } = await drainedAfterOneCall(runId, segment);
        const passAt = new Date(Date.now() + ABANDONED_SESSION_MIN_AGE_MS + 60_000);
        await reconcileLostSessionDeletes({ now: passAt });
        expect(faux.holdsSession(sessionId)).toBe(true);

        await prisma.registeredAgent.update({ where: { id: AGENT }, data: { status: 'RETIRED' } });
        await reconcileLostSessionDeletes({ now: passAt });
        expect(faux.holdsSession(sessionId)).toBe(false);
        expect(await lifecycles(runId)).toEqual(['SESSION_CREATED', 'SESSION_DELETED']);
    });
});
