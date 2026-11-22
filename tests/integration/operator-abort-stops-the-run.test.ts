/**
 * AN OPERATOR'S ABORT STOPS THE RUN, AND STAYS THE RUN'S STATUS (#5366).
 *
 * `abortWorkflowRun` writes ABORTED on the run row while the engine may still
 * be running. Before #5366 only the static driver read the row between steps:
 * the Tool Runner and Flue read the kill switch alone, so an aborted run went
 * on calling the model and running tools, and then settled COMPLETED over the
 * abort through an unconditional write. The decision rows it wrote after the
 * abort were then stamped "no human review" — of a run a person had stopped.
 *
 * Real database, real usecases, the worker's own body; the model is a fake
 * `fetch` answering Anthropic's Messages API, and it is the fake that presses
 * Abort, while the first model call is in flight:
 *
 *   1. the Tool Runner makes no model call after the abort and runs none of the
 *      turn's tools; the run stays ABORTED with the operator's reason, and
 *      every decision row it wrote is REJECTED;
 *   2. a settling write never lands on an ABORTED row, a write that carries no
 *      status still does, and a missing run still throws;
 *   3. EMPTY_CATALOGUE is terminal: an Abort refuses it, and its decision rows
 *      are settled like a FAILED run's.
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
    settleRunDecisionLog,
} from '@/app-layer/usecases/workflow-runs';
import { createAgentProfile, startAgentProfileTestRun, submitAgentProfileVersion } from '@/app-layer/usecases/agent-profiles';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import { failRun, OPERATOR_ABORT_MESSAGE, updateRun } from '@/lib/agentic/drivers/run-settlement';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `opab-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USERS = { owner: `u-owner-${SUITE}`, admin: `u-admin-${SUITE}` };
const AGENT = `ag-${SUITE}`;

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

// ─── The fake model, which presses Abort mid-call ───────────────────

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

async function bareRun(status: 'RUNNING' | 'ABORTED' | 'EMPTY_CATALOGUE'): Promise<string> {
    const id = `run-${randomUUID()}`;
    await prisma.workflowRun.create({ data: { id, tenantId: TENANT, workflowKey: 'audit-prep', status } });
    return id;
}

async function decisionRow(runId: string): Promise<string> {
    const row = await prisma.aiDecisionLog.create({
        data: {
            tenantId: TENANT,
            feature: 'agentic-run:audit-prep',
            provider: 'anthropic',
            inputDigest: `sha256:${randomUUID()}`,
            sessionRef: runId,
            humanOutcome: 'PENDING',
        },
        select: { id: true },
    });
    return row.id;
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

describeFn("an operator's abort stops the run and stays its status (#5366)", () => {
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

    afterEach(() => {
        wire.during = null;
    });

    afterAll(async () => {
        global.fetch = originalFetch;
        await cleanup();
        await prisma.$disconnect();
    });

    it('the Tool Runner stops at the abort: no further model call, no tool, ABORTED kept, decisions REJECTED', async () => {
        installFakeModel();
        const started = await startAgentProfileTestRun(admin(), AGENT, 1);
        // The operator presses Abort while the first model call is in flight.
        wire.during = async (n) => {
            if (n === 0) await abortWorkflowRun(owner(), started.runId);
        };

        const outcome = await executeQueuedWorkflowRun(TENANT, started.runId);

        expect(outcome).toMatchObject({ status: 'ABORTED' });
        // The call in flight was the last: the model asked for a tool, and
        // neither the tool nor a second call followed the abort.
        expect(wire.bodies).toHaveLength(1);
        const steps = await prisma.workflowStep.findMany({
            where: { runId: started.runId },
            select: { kind: true, toolCalled: true },
            orderBy: { seq: 'asc' },
        });
        expect(steps.length).toBeGreaterThan(0);
        expect(steps.filter((s) => s.kind === 'TOOL_CALL')).toEqual([]);

        // The operator's settlement stands, reason and all.
        const run = await prisma.workflowRun.findUniqueOrThrow({
            where: { id: started.runId },
            select: { status: true, errorMessage: true, completedAt: true },
        });
        expect(run).toMatchObject({ status: 'ABORTED', errorMessage: OPERATOR_ABORT_MESSAGE });
        expect(run.completedAt).not.toBeNull();

        // The model call made around the abort was refused by the person who
        // stopped the run, not stamped "no human review".
        const decisions = await prisma.aiDecisionLog.findMany({
            where: { tenantId: TENANT, sessionRef: started.runId },
            select: { humanOutcome: true },
        });
        expect(decisions.length).toBeGreaterThan(0);
        expect(decisions.map((d) => d.humanOutcome)).toEqual(decisions.map(() => 'REJECTED'));

        // No failure or completion was written into the trail for it.
        const actions = await prisma.auditLog.findMany({
            where: { tenantId: TENANT, entity: 'WorkflowRun', entityId: started.runId },
            select: { action: true },
        });
        expect(actions.map((a) => a.action)).toContain('WORKFLOW_RUN_ABORTED');
        expect(actions.map((a) => a.action)).not.toContain('WORKFLOW_RUN_FAILED');
    });

    it('the same run, not aborted, completes: the fake and the profile are a working run', async () => {
        installFakeModel();
        const started = await startAgentProfileTestRun(admin(), AGENT, 1);

        expect(await executeQueuedWorkflowRun(TENANT, started.runId)).toMatchObject({ status: 'COMPLETED' });
        expect(wire.bodies).toHaveLength(2);
        const steps = await prisma.workflowStep.findMany({ where: { runId: started.runId, kind: 'TOOL_CALL' }, select: { toolCalled: true } });
        expect(steps).toEqual([{ toolCalled: 'list_risks' }]);
    });

    it('a settling write never lands on an ABORTED row; accounting does, and a missing run still throws', async () => {
        const runId = await bareRun('ABORTED');
        await prisma.workflowRun.update({ where: { id: runId }, data: { errorMessage: OPERATOR_ABORT_MESSAGE } });

        expect(await updateRun(owner(), runId, { status: 'COMPLETED', completedAt: new Date() })).toBe(false);
        expect(await failRun(owner(), runId, 'flue_run_failed: something after the abort')).toBe('ABORTED');
        expect(await updateRun(owner(), runId, { costTokens: 42, stepCount: 3 })).toBe(true);

        const row = await prisma.workflowRun.findUniqueOrThrow({
            where: { id: runId },
            select: { status: true, errorMessage: true, costTokens: true, stepCount: true },
        });
        expect(row).toEqual({ status: 'ABORTED', errorMessage: OPERATOR_ABORT_MESSAGE, costTokens: 42, stepCount: 3 });
        const failed = await prisma.auditLog.count({
            where: { tenantId: TENANT, entityId: runId, action: 'WORKFLOW_RUN_FAILED' },
        });
        expect(failed).toBe(0);

        // A live row still settles, and a run that is not there is still an error.
        const live = await bareRun('RUNNING');
        expect(await updateRun(owner(), live, { status: 'COMPLETED', completedAt: new Date() })).toBe(true);
        expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: live }, select: { status: true } })).status).toBe('COMPLETED');
        await expect(updateRun(owner(), `run-${randomUUID()}`, { status: 'FAILED' })).rejects.toThrow();
    });

    it('EMPTY_CATALOGUE is terminal: an abort refuses it, and its decisions are settled', async () => {
        const runId = await bareRun('EMPTY_CATALOGUE');
        const decision = await decisionRow(runId);

        await expect(abortWorkflowRun(owner(), runId)).rejects.toThrow(/already EMPTY_CATALOGUE/);
        const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true } });
        expect(row.status).toBe('EMPTY_CATALOGUE');
        // The abort's REJECTED did not reach it either.
        expect((await prisma.aiDecisionLog.findUniqueOrThrow({ where: { id: decision } })).humanOutcome).toBe('PENDING');

        await settleRunDecisionLog(owner(), runId, 'EMPTY_CATALOGUE');
        expect((await prisma.aiDecisionLog.findUniqueOrThrow({ where: { id: decision } })).humanOutcome).toBe('AUTONOMOUS');
    });
});
