/**
 * ONE RUN EXECUTES IN AT MOST ONE PLACE AT A TIME (#5854 finding 2).
 *
 * `agent-run-execute` was enqueued with no `jobId` and `attempts: 3`, and the
 * run row carried no claim: `executeQueuedWorkflowRun` checked only that the
 * run was RUNNING, which a run a worker is executing also is. So a stalled-job
 * redelivery, or a retry while the first attempt still ran, drove ONE run
 * twice at once: two model loops, the tools run twice.
 *
 * Real database, real usecases, the worker's own body; the model is a fake
 * `fetch` answering Anthropic's Messages API (the harness of
 * `operator-abort-stops-the-run.test.ts`). Each case below fails without the
 * lease:
 *
 *   1. two executions of one run started together: exactly one drives the
 *      engine, the other returns without a model call or a tool call;
 *   2. an expired lease is claimable, and a dead holder's live lease is taken
 *      over once it lapses, so BullMQ's redelivery still recovers a crash;
 *   3. a holder whose run was taken over stops at its next check, settles
 *      nothing and writes no step;
 *   4. the SIGTERM drain releases the lease with the pause, and the resume's
 *      job claims it;
 *   5. an operator's Abort still wins over a held lease (#5366 unchanged);
 *   6. the reaper treats an expired lease as abandoned and a live one as a
 *      live executor;
 *   7. every enqueue names its segment's job, so a duplicate is BullMQ's to
 *      drop.
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

import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import {
    abortWorkflowRun,
    executeQueuedWorkflowRun,
    resumeWorkflowRun,
} from '@/app-layer/usecases/workflow-runs';
import { createAgentProfile, startAgentProfileTestRun, submitAgentProfileVersion } from '@/app-layer/usecases/agent-profiles';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import { OPERATOR_ABORT_MESSAGE } from '@/lib/agentic/drivers/run-settlement';
import { pauseInFlightRuns, _resetInFlightRunsForTesting } from '@/lib/agentic/in-flight-runs';
import { runAgentRunReaperJob } from '@/app-layer/jobs/agent-run-reaper';
import { agentRunExecuteJobId } from '@/app-layer/jobs/agent-run-job-id';
import { enqueue } from '@/app-layer/jobs/queue';
import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import type { RunLeaseTiming } from '@/lib/agentic/run-lease';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `rlse-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USERS = { owner: `u-owner-${SUITE}`, admin: `u-admin-${SUITE}` };
const AGENT = `ag-${SUITE}`;

/** Short, so a watcher decides in well under a second; the shape is the production one. */
const TIMING: RunLeaseTiming = { ttlMs: 2_000, renewMs: 150 };

const ctx = (role: Role, userId: string): RequestContext =>
    makeRequestContext(role, { tenantId: TENANT, tenantSlug: TENANT, userId });
const owner = () => ctx('OWNER', USERS.owner);
const admin = () => ctx('ADMIN', USERS.admin);

const version = (): AgentProfileVersionInput => ({
    instructions: 'List the open risks and summarise them.',
    toolNames: ['list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN'],
});

// ─── The fake model ──────────────────────────────────────────────────

const wire = {
    bodies: [] as Array<Record<string, unknown>>,
    /** Called while request `n` is in flight, before its answer returns. */
    during: null as null | ((n: number) => Promise<void>),
};
const originalFetch = global.fetch;
const listRisks = { content: [{ type: 'tool_use', id: 'toolu_0', name: 'list_risks', input: {} }], stop_reason: 'tool_use' };
const answer = { content: [{ type: 'text', text: 'There are no open risks.' }], stop_reason: 'end_turn' };

function installFakeModel(): void {
    wire.bodies = [];
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const n = wire.bodies.length;
        wire.bodies.push(body);
        await wire.during?.(n);
        return new Response(
            JSON.stringify({
                id: `msg_${n}`,
                type: 'message',
                role: 'assistant',
                model: String(body.model),
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 5 },
                ...(n === 0 ? listRisks : answer),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;
}

/** Unref'd, so a bound that is never reached keeps no worker alive. */
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

const execute = (runId: string) => executeQueuedWorkflowRun(TENANT, runId, { leaseTiming: TIMING });

const runRow = (id: string) =>
    prisma.workflowRun.findUniqueOrThrow({
        where: { id },
        select: {
            status: true, errorMessage: true, completedAt: true, costTokens: true, stepCount: true,
            leaseHolder: true, leaseExpiresAt: true,
        },
    });

const stepsOf = (runId: string) =>
    prisma.workflowStep.findMany({ where: { runId }, select: { seq: true, kind: true, toolCalled: true }, orderBy: { seq: 'asc' } });

async function bareRun(minutesAgo: number): Promise<string> {
    const id = `run-${randomUUID()}`;
    await prisma.workflowRun.create({ data: { id, tenantId: TENANT, workflowKey: 'audit-prep', status: 'RUNNING' } });
    await prisma.$executeRaw`UPDATE "WorkflowRun" SET "updatedAt" = now() - (${minutesAgo}::int * interval '1 minute') WHERE "id" = ${id}`;
    return id;
}

async function cleanup(): Promise<void> {
    const tenants = [TENANT];
    await prisma.workflowStep.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        for (const table of ['AgentProfileVersion', 'AgentProfile', 'TenantMembership']) {
            await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`, tenants);
        }
    });
    await prisma.registeredAgentTool.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: { in: tenants } } });
    await deleteAuditRowsForTenants(prisma, tenants);
    await prisma.user.deleteMany({ where: { id: { in: Object.values(USERS) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
}

describeFn('one run executes in at most one place at a time (#5854)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        await createTenantWithDek({ id: TENANT, name: TENANT, slug: TENANT });
        for (const [id, role] of [
            [USERS.owner, 'OWNER'],
            [USERS.admin, 'ADMIN'],
        ] as const) {
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
                ownerUserId: USERS.owner,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
            },
        });
        await prisma.registeredAgentTool.create({
            data: { tenantId: TENANT, agentId: AGENT, toolName: 'list_risks', grantedByUserId: USERS.owner },
        });
        await prisma.tenantSecuritySettings.create({ data: { tenantId: TENANT, agentDriver: 'TOOL_RUNNER' } });
        await createAgentProfile(owner(), AGENT, version());
        await submitAgentProfileVersion(owner(), AGENT, 1);
    });

    beforeEach(() => {
        _resetInFlightRunsForTesting();
        jest.mocked(enqueue).mockClear();
        installFakeModel();
    });

    afterEach(() => {
        wire.during = null;
    });

    afterAll(async () => {
        global.fetch = originalFetch;
        _resetInFlightRunsForTesting();
        await cleanup();
        await prisma.$disconnect();
        __resetAuditStreamForTests();
    });

    it('two executions of one run at once: exactly one drives the engine, the other makes no call', async () => {
        const started = await startAgentProfileTestRun(admin(), AGENT, 1);

        // The first model call is held until one execution has returned, so
        // both are in flight together. Bounded: without the lease neither
        // returns while both are held, and the fake lets go after 3s so the
        // failure is a count, not a hang.
        let settledOne: () => void = () => undefined;
        const oneSettled = new Promise<void>((resolve) => { settledOne = resolve; });
        wire.during = async (n) => {
            if (n === 0) await Promise.race([oneSettled, sleep(3_000)]);
        };

        const a = execute(started.runId);
        const b = execute(started.runId);
        void a.finally(settledOne);
        void b.finally(settledOne);
        const outcomes = await Promise.all([a, b]);

        // One completed; the other declined, holding nothing and calling nothing.
        expect(outcomes.filter((o) => 'status' in o)).toEqual([{ status: 'COMPLETED', stepFailures: 0 }]);
        expect(outcomes.filter((o) => 'skipped' in o)).toEqual([{ skipped: 'LEASE_HELD' }]);
        // One run's worth of model calls (a tool call, then the answer) and
        // one tool call: not two of each.
        expect(wire.bodies).toHaveLength(2);
        expect((await stepsOf(started.runId)).filter((s) => s.kind === 'TOOL_CALL')).toEqual([
            { seq: expect.any(Number), kind: 'TOOL_CALL', toolCalled: 'list_risks' },
        ]);
        // Released at the end: a settled run holds nothing.
        expect(await runRow(started.runId)).toMatchObject({ status: 'COMPLETED', leaseHolder: null, leaseExpiresAt: null });
    });

    it('an expired lease is claimable by a new worker', async () => {
        const started = await startAgentProfileTestRun(admin(), AGENT, 1);
        await prisma.$executeRaw`UPDATE "WorkflowRun" SET "leaseHolder" = 'a-worker-that-died', "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = ${started.runId}`;

        expect(await execute(started.runId)).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        expect(wire.bodies).toHaveLength(2);
        expect(await runRow(started.runId)).toMatchObject({ status: 'COMPLETED', leaseHolder: null });
    });

    it("a dead holder's lease that is still live is taken over once it lapses, so a redelivery recovers a crash", async () => {
        // BullMQ redelivers a crashed worker's job within a minute, which can
        // be before the dead holder's lease runs out. The redelivery watches
        // the lease, sees it is not renewed, and takes the run over rather
        // than leaving it for the reaper.
        const started = await startAgentProfileTestRun(admin(), AGENT, 1);
        await prisma.$executeRaw`UPDATE "WorkflowRun" SET "leaseHolder" = 'a-worker-that-died', "leaseExpiresAt" = now() + interval '700 milliseconds' WHERE "id" = ${started.runId}`;

        expect(await execute(started.runId)).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        expect(wire.bodies).toHaveLength(2);
    });

    it('a holder whose run was taken over stops at its next check, settles nothing and writes no step', async () => {
        const started = await startAgentProfileTestRun(admin(), AGENT, 1);
        let stepsAtTakeover = -1;
        // While the first model call is in flight, another worker claims the
        // run (this holder's lease lapsed, say, during a long pause).
        wire.during = async (n) => {
            if (n !== 0) return;
            await prisma.$executeRaw`UPDATE "WorkflowRun" SET "leaseHolder" = 'the-successor', "leaseExpiresAt" = now() + interval '1 minute' WHERE "id" = ${started.runId}`;
            stepsAtTakeover = (await stepsOf(started.runId)).length;
        };

        const outcome = await execute(started.runId);

        expect(outcome).toEqual({ skipped: 'LEASE_LOST' });
        // No second model call and no tool: it stopped at the check after the
        // call in flight, as it stops at an Abort.
        expect(wire.bodies).toHaveLength(1);
        // Not one step written after the takeover, the in-flight call's own
        // MODEL_CALL row included.
        expect(stepsAtTakeover).toBeGreaterThanOrEqual(0);
        expect((await stepsOf(started.runId)).length).toBe(stepsAtTakeover);
        // Nothing settled, nothing accounted, and the successor's lease is
        // untouched: the old holder released nothing that was not its own.
        expect(await runRow(started.runId)).toMatchObject({
            status: 'RUNNING',
            errorMessage: null,
            completedAt: null,
            costTokens: 0,
            leaseHolder: 'the-successor',
        });
        const actions = await prisma.auditLog.findMany({
            where: { tenantId: TENANT, entity: 'WorkflowRun', entityId: started.runId },
            select: { action: true },
        });
        expect(actions.map((a) => a.action)).not.toEqual(
            expect.arrayContaining(['WORKFLOW_RUN_FAILED']),
        );
        // The successor's run is not lost: it is RUNNING with a live holder.
    });

    it('the SIGTERM drain releases the lease with the pause, and the resume claims it', async () => {
        const started = await startAgentProfileTestRun(admin(), AGENT, 1);
        let atPause: { status: string; leaseHolder: string | null } | null = null;
        wire.during = async (n) => {
            if (n !== 0) return;
            const held = await runRow(started.runId);
            expect(held.leaseHolder).not.toBeNull();
            expect((await pauseInFlightRuns(2_000)).paused).toBe(1);
            atPause = await runRow(started.runId);
        };

        // The drained worker stops at its next check and writes over nothing.
        expect(await execute(started.runId)).toEqual({ skipped: 'LEASE_LOST' });
        expect(atPause).toMatchObject({ status: 'PAUSED', leaseHolder: null });
        expect(await runRow(started.runId)).toMatchObject({ status: 'PAUSED', leaseHolder: null, completedAt: null });
        expect((await stepsOf(started.runId)).filter((s) => s.kind === 'TOOL_CALL')).toEqual([]);

        // A person resumes it; the job the resume enqueues claims the run.
        expect(await resumeWorkflowRun(owner(), started.runId)).toEqual({ status: 'RUNNING', stepFailures: 0 });
        wire.during = null;
        expect(await execute(started.runId)).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        expect(await runRow(started.runId)).toMatchObject({ status: 'COMPLETED', leaseHolder: null });
    });

    it("an operator's Abort still wins over a held lease (#5366)", async () => {
        const started = await startAgentProfileTestRun(admin(), AGENT, 1);
        wire.during = async (n) => {
            if (n !== 0) return;
            expect((await runRow(started.runId)).leaseHolder).not.toBeNull();
            await abortWorkflowRun(owner(), started.runId);
        };

        expect(await execute(started.runId)).toMatchObject({ status: 'ABORTED' });
        expect(wire.bodies).toHaveLength(1);
        expect(await runRow(started.runId)).toMatchObject({
            status: 'ABORTED',
            errorMessage: OPERATOR_ABORT_MESSAGE,
            leaseHolder: null,
        });
    });

    it('the reaper treats an expired lease as abandoned and a live one as a live executor', async () => {
        const old = 120; // minutes since the run last made progress: past the cutoff
        const unleased = await bareRun(old);
        const expired = await bareRun(old);
        const live = await bareRun(old);
        await prisma.$executeRaw`UPDATE "WorkflowRun" SET "leaseHolder" = 'gone', "leaseExpiresAt" = now() - interval '5 minutes' WHERE "id" = ${expired}`;
        await prisma.$executeRaw`UPDATE "WorkflowRun" SET "leaseHolder" = 'alive', "leaseExpiresAt" = now() + interval '5 minutes' WHERE "id" = ${live}`;

        const { outcome } = await runAgentRunReaperJob({ tenantId: TENANT });

        // The live one is not even counted as wedged, and not reaped.
        expect({ found: outcome.runsFound, reaped: outcome.runsReaped }).toEqual({ found: 2, reaped: 2 });
        expect(await runRow(unleased)).toMatchObject({ status: 'FAILED', leaseHolder: null });
        // Reaped, and the lease cleared so a holder that wakes is fenced.
        expect(await runRow(expired)).toMatchObject({ status: 'FAILED', leaseHolder: null, leaseExpiresAt: null });
        expect(await runRow(live)).toMatchObject({ status: 'RUNNING', leaseHolder: 'alive' });
    });

    it("every enqueue names its segment's job: the start by the run's start, a resume by its own claim", async () => {
        const started = await startAgentProfileTestRun(admin(), AGENT, 1);
        const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { startedAt: true } });
        const startCall = jest.mocked(enqueue).mock.calls.find(([name]) => name === 'agent-run-execute');
        expect(startCall?.[2]).toEqual({ jobId: agentRunExecuteJobId(started.runId, row.startedAt) });

        // Two resumes of one run are two segments with two ids, never one: a
        // reused id would be a job BullMQ drops and a run nobody executes.
        const resumeIds: string[] = [];
        for (let i = 0; i < 2; i += 1) {
            await prisma.workflowRun.update({ where: { id: started.runId }, data: { status: 'PAUSED' } });
            jest.mocked(enqueue).mockClear();
            await sleep(5);
            await resumeWorkflowRun(owner(), started.runId);
            const call = jest.mocked(enqueue).mock.calls.find(([name]) => name === 'agent-run-execute');
            const jobId = (call?.[2] as { jobId?: string } | undefined)?.jobId ?? '';
            expect(jobId).toMatch(new RegExp(`^agent-run-${started.runId}-\\d+$`));
            resumeIds.push(jobId);
        }
        expect(new Set([agentRunExecuteJobId(started.runId, row.startedAt), ...resumeIds]).size).toBe(3);
    });
});
