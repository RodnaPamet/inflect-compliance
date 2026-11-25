/**
 * A RETRIED SEGMENT ON AN ENGINE THAT CANNOT CONTINUE ITS CONVERSATION PAUSES
 * FOR A PERSON (#5854 item 3; owner decision 2026-11-24).
 *
 * Flue continues a conversation only from its own durable store, which Inflect
 * does not configure, so it cannot continue a retried segment the way the Tool
 * Runner does. Before this, a retry started it again from the opening message
 * and a call the dead attempt made was made again. Now a retry of a segment
 * that already made a call PAUSES the run at a `retry-paused` checkpoint
 * instead, before any engine runs.
 *
 * MANAGED AGENTS NO LONGER PAUSES (owner decision 2026-11-25): a retried or
 * taken-over segment RECONNECTS to the session it created and continues there.
 * So the worker anchors its segment as it does Flue's, never pauses it, and
 * hands the engine where the segment began (`runSegmentFromSeq`). The
 * reconnect itself is held in `managed-agents-reconnect.test.ts`.
 *
 * Real database and the worker's own body (`executeQueuedWorkflowRun`) with
 * its run lease. The ENGINE is a stand-in: the deployment permits Flue (or
 * Managed Agents) and the driver it maps to is a counted fake that records a
 * TOOL_CALL step through the real step recorder, because the property is
 * decided BEFORE the engine is reached, and running a real Flue or Managed
 * Agents loop would test that engine rather than this seam.
 */
const engine = {
    under: 'flue' as 'flue' | 'managed-agents',
    /** While a run is admitted, the deployment permits the Tool Runner, which a profile run asks for. */
    admitting: false,
    invocations: 0,
    /** Where each invocation was told its segment began (`runSegmentFromSeq`). */
    segmentFromSeqs: [] as Array<number | undefined>,
    /** What the fake engine does once it is reached. */
    behaviour: 'CALL_THEN_THROW' as 'CALL_THEN_THROW' | 'THROW' | 'CALL_THEN_DIE' | 'COMPLETE',
};
const envOverride: Record<string, string | undefined> = {
    AGENT_PROFILES: '1',
    AGENT_DRIVER_TOOL_RUNNER: '1',
    ANTHROPIC_API_KEY: 'sk-ant-integration-faux-key', // pragma: allowlist secret -- a placeholder; no request is sent
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
// The deployment permits the engine under test.
jest.mock('@/lib/agentic/agent-driver-policy', () => {
    const actual = jest.requireActual('@/lib/agentic/agent-driver-policy');
    return { ...actual, resolveDriverForRun: jest.fn(async () => ({ driver: engine.admitting ? 'tool-runner' : engine.under, reason: null })) };
});
// …and the engine is the counted stand-in.
jest.mock('@/lib/agentic/drivers', () => {
    const actual = jest.requireActual('@/lib/agentic/drivers');
    const { recordStep } = jest.requireActual('@/lib/agentic/drivers/step-recorder');
    const { updateRun } = jest.requireActual('@/lib/agentic/drivers/run-settlement');
    const fake = async (ctx: unknown, runId: string, _def: unknown, fromSeq: number) => {
        engine.invocations += 1;
        engine.segmentFromSeqs.push((ctx as { runSegmentFromSeq?: number }).runSegmentFromSeq);
        if (engine.behaviour === 'THROW') throw new Error('the database connection was reset');
        if (engine.behaviour !== 'COMPLETE') {
            await recordStep(ctx, runId, fromSeq, 'TOOL_CALL', { toolCalled: 'list_risks', status: 'DONE', label: 'list_risks' });
        }
        if (engine.behaviour === 'CALL_THEN_THROW') throw new Error('the database connection was reset');
        if (engine.behaviour === 'CALL_THEN_DIE') {
            // The worker dies: its run is held by a holder that never renews, whose lease has lapsed.
            await dieNow(runId);
            return { status: 'COMPLETED', stepFailures: 0 };
        }
        await updateRun(ctx, runId, { status: 'COMPLETED', completedAt: new Date(), stepCount: fromSeq + 1 });
        return { status: 'COMPLETED', stepFailures: 0 };
    };
    return {
        ...actual,
        selectRunDriver: jest.fn((def: unknown, permitted: string) =>
            permitted === engine.under ? { driver: permitted, run: fake } : actual.selectRunDriver(def, permitted),
        ),
    };
});

import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { executeQueuedWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { createAgentProfile, startAgentProfileTestRun, submitAgentProfileVersion } from '@/app-layer/usecases/agent-profiles';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import type { RequestContext } from '@/app-layer/types';
import { RETRY_PAUSED_LABEL } from '@/lib/agentic/drivers/checkpoint-store';
import { _resetInFlightRunsForTesting } from '@/lib/agentic/in-flight-runs';
import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import type { RunLeaseTiming } from '@/lib/agentic/run-lease';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `rspause-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USERS = { owner: `u-owner-${SUITE}`, admin: `u-admin-${SUITE}` };
const AGENT = `ag-${SUITE}`;
const TIMING: RunLeaseTiming = { ttlMs: 2_000, renewMs: 150 };

const ctx = (role: Role, userId: string): RequestContext =>
    makeRequestContext(role, { tenantId: TENANT, tenantSlug: TENANT, userId });
const owner = () => ctx('OWNER', USERS.owner);
const admin = () => ctx('ADMIN', USERS.admin);

const version = (): AgentProfileVersionInput => ({
    instructions: 'List the open risks.',
    toolNames: ['list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN'],
});

async function dieNow(runId: string): Promise<void> {
    await prisma.$executeRaw`UPDATE "WorkflowRun" SET "leaseHolder" = 'a-worker-that-died', "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = ${runId}`;
}

const execute = (runId: string, segment?: number) =>
    executeQueuedWorkflowRun(TENANT, runId, { leaseTiming: TIMING, ...(segment !== undefined ? { segment } : {}) });

const runRow = (id: string) =>
    prisma.workflowRun.findUniqueOrThrow({ where: { id }, select: { status: true, stepCount: true, leaseHolder: true } });

const stepsOf = (runId: string) =>
    prisma.workflowStep.findMany({
        where: { runId },
        select: { seq: true, kind: true, toolCalled: true, status: true },
        orderBy: { seq: 'asc' },
    });

async function newRun(): Promise<{ runId: string; segment: number }> {
    engine.admitting = true;
    const started = await startAgentProfileTestRun(admin(), AGENT, 1).finally(() => {
        engine.admitting = false;
    });
    const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { startedAt: true } });
    return { runId: started.runId, segment: row.startedAt.getTime() };
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

describeFn('a retried segment on an engine that cannot continue its conversation pauses for a person (#5854)', () => {
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
        await prisma.registeredAgentTool.create({ data: { tenantId: TENANT, agentId: AGENT, toolName: 'list_risks', grantedByUserId: USERS.owner } });
        await prisma.tenantSecuritySettings.create({ data: { tenantId: TENANT, agentDriver: 'TOOL_RUNNER' } });
        await createAgentProfile(owner(), AGENT, version());
        await submitAgentProfileVersion(owner(), AGENT, 1);
    });

    beforeEach(() => {
        _resetInFlightRunsForTesting();
        engine.invocations = 0;
        engine.segmentFromSeqs = [];
    });

    afterAll(async () => {
        _resetInFlightRunsForTesting();
        await cleanup();
        await prisma.$disconnect();
        __resetAuditStreamForTests();
    });

    for (const under of ['flue'] as const) {
        it(`${under}: a retry of a segment that already made a call pauses at a retry-paused checkpoint, and the engine is not run again`, async () => {
            engine.under = under;
            const { runId, segment } = await newRun();

            engine.behaviour = 'CALL_THEN_THROW';
            await expect(execute(runId, segment)).rejects.toThrow(/connection was reset/);
            expect(engine.invocations).toBe(1);
            // Left RUNNING for BullMQ's retry, as an infrastructure failure is.
            expect((await runRow(runId)).status).toBe('RUNNING');

            engine.behaviour = 'COMPLETE';
            expect(await execute(runId, segment)).toEqual({ status: 'PAUSED', stepFailures: 0 });
            // NOT RUN AGAIN: the call the dead attempt made is not made again.
            expect(engine.invocations).toBe(1);
            expect(await runRow(runId)).toMatchObject({ status: 'PAUSED', stepCount: 2, leaseHolder: null });
            expect(await stepsOf(runId)).toEqual([
                { seq: 0, kind: 'TOOL_CALL', toolCalled: 'list_risks', status: 'DONE' },
                { seq: 1, kind: 'HUMAN_CHECKPOINT', toolCalled: null, status: 'PENDING' },
            ]);
            const audit = await prisma.auditLog.findFirst({
                where: { tenantId: TENANT, entityId: runId, action: 'WORKFLOW_RUN_RETRY_PAUSED' },
                select: { detailsJson: true },
            });
            expect(audit?.detailsJson).toMatchObject({ reason: 'RETRY_AFTER_CALLS', segmentFromSeq: 0, stepSeq: 1 });
            const wf = await prisma.auditLog.findFirst({
                where: { tenantId: TENANT, entityId: `${runId}:1`, action: 'WORKFLOW_STEP' },
                select: { detailsJson: true },
            });
            expect(wf?.detailsJson).toMatchObject({ kind: 'HUMAN_CHECKPOINT', label: RETRY_PAUSED_LABEL, status: 'PENDING' });
        });
    }

    it('a lease takeover of a segment that already made a call pauses too', async () => {
        engine.under = 'flue';
        const { runId, segment } = await newRun();

        engine.behaviour = 'CALL_THEN_DIE';
        expect(await execute(runId, segment)).toEqual({ skipped: 'LEASE_LOST' });
        expect(engine.invocations).toBe(1);

        engine.behaviour = 'COMPLETE';
        expect(await execute(runId, segment)).toEqual({ status: 'PAUSED', stepFailures: 0 });
        expect(engine.invocations).toBe(1);
    });

    it('managed-agents: a retry of a segment that already made a call is NOT paused; the engine runs again, told where its segment began, and reconnects itself', async () => {
        engine.under = 'managed-agents';
        const { runId, segment } = await newRun();

        engine.behaviour = 'CALL_THEN_THROW';
        await expect(execute(runId, segment)).rejects.toThrow(/connection was reset/);
        expect((await runRow(runId)).status).toBe('RUNNING');

        engine.behaviour = 'COMPLETE';
        expect(await execute(runId, segment)).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        expect(engine.invocations).toBe(2);
        // The first attempt is told its own start; the retry the FIRST
        // attempt's, behind the call it made (seq 0), which is how the engine
        // finds the session that call ran in.
        expect(engine.segmentFromSeqs).toEqual([0, 0]);
        expect((await stepsOf(runId)).map((s) => s.kind)).toEqual(['TOOL_CALL']);
        expect(await prisma.auditLog.count({ where: { tenantId: TENANT, entityId: runId, action: 'WORKFLOW_RUN_RETRY_PAUSED' } })).toBe(0);
    });

    it('managed-agents: a lease takeover is not paused either', async () => {
        engine.under = 'managed-agents';
        const { runId, segment } = await newRun();

        engine.behaviour = 'CALL_THEN_DIE';
        expect(await execute(runId, segment)).toEqual({ skipped: 'LEASE_LOST' });

        engine.behaviour = 'COMPLETE';
        expect(await execute(runId, segment)).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        expect(engine.invocations).toBe(2);
        expect(engine.segmentFromSeqs).toEqual([0, 0]);
    });

    it('managed-agents: a NEW segment is told its own start, behind every earlier step', async () => {
        engine.under = 'managed-agents';
        const { runId, segment } = await newRun();
        engine.behaviour = 'CALL_THEN_THROW';
        await expect(execute(runId, segment)).rejects.toThrow();
        // A person's resume authorises a new segment, past the call.
        engine.behaviour = 'COMPLETE';
        expect(await execute(runId, segment + 60_000)).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        expect(engine.segmentFromSeqs).toEqual([0, 1]);
    });

    it('managed-agents: a job from a build that named no segment carries none, and the engine does not reconnect', async () => {
        engine.under = 'managed-agents';
        const { runId } = await newRun();
        engine.behaviour = 'COMPLETE';
        expect(await execute(runId)).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        expect(engine.segmentFromSeqs).toEqual([undefined]);
    });

    it('a retry of a segment that made no call starts it again: nothing would be done twice', async () => {
        engine.under = 'flue';
        const { runId, segment } = await newRun();

        engine.behaviour = 'THROW';
        await expect(execute(runId, segment)).rejects.toThrow(/connection was reset/);

        engine.behaviour = 'COMPLETE';
        expect(await execute(runId, segment)).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        expect(engine.invocations).toBe(2);
    });

    it('a NEW segment is not a retry: once a person moves the run on, the engine runs again', async () => {
        engine.under = 'flue';
        const { runId, segment } = await newRun();
        engine.behaviour = 'CALL_THEN_THROW';
        await expect(execute(runId, segment)).rejects.toThrow();
        engine.behaviour = 'COMPLETE';
        expect(await execute(runId, segment)).toMatchObject({ status: 'PAUSED' });

        // A person's resume closes the checkpoint and authorises a new segment,
        // as `resumeWorkflowRun` does: a new key, past the checkpoint.
        await prisma.workflowStep.updateMany({ where: { runId, seq: 1 }, data: { status: 'DONE' } });
        await prisma.workflowRun.update({ where: { id: runId }, data: { status: 'RUNNING', stepCount: 2 } });
        expect(await execute(runId, segment + 60_000)).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        expect(engine.invocations).toBe(2);
    });

    it('a job from a build that named no segment is not paused: it cannot be told from a first attempt', async () => {
        engine.under = 'flue';
        const { runId } = await newRun();
        engine.behaviour = 'CALL_THEN_THROW';
        await expect(execute(runId)).rejects.toThrow();
        engine.behaviour = 'COMPLETE';
        expect(await execute(runId)).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        expect(engine.invocations).toBe(2);
    });

    it('the Tool Runner and Managed Agents are never paused on a retry: they continue from a checkpoint and a session instead', async () => {
        // The classification decides, not the engine's name.
        const { segmentRecoveryOf } = jest.requireActual('@/lib/agentic/agent-driver') as typeof import('@/lib/agentic/agent-driver');
        expect(segmentRecoveryOf('tool-runner')).toBe('CHECKPOINT');
        expect(segmentRecoveryOf('static')).toBe('LEDGER');
        expect(segmentRecoveryOf('flue')).toBe('PAUSE_ON_RETRY');
        expect(segmentRecoveryOf('managed-agents')).toBe('SESSION');
    });
});
