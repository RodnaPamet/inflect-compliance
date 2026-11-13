/**
 * AN INVOKE_AGENT RULE'S RUN NAMES THE EXECUTION THAT TOOK THE ACTION (#3537).
 *
 * `WorkflowRun.parentExecutionId` is what the process canvas's agent view
 * (`listCanvasAgentRuns`) walks: node -> ruleId -> AutomationExecution -> run.
 * The action read the parent from `data.__parentExecutionId`, which only the
 * chain and sub-flow dispatchers set — and set to THEIR OWN parent. So:
 *
 *   - a rule fired directly by an event started a run recording `''`, which
 *     no execution matches, and the canvas never showed it;
 *   - a chained rule's run named the UPSTREAM rule's execution, so the canvas
 *     credited it to that rule's node, or (an upstream rule that is not an
 *     INVOKE_AGENT, whose executions the reader does not load) to none.
 *
 * Real path end to end against Postgres: the event dispatcher claims the
 * execution and runs the action, the action's enqueue is captured, the
 * captured payload is handed to the real `agent-invoke-dispatch`, and the
 * canvas reader is asked what it sees. Only the queue is replaced.
 */
const enqueued: Array<{ name: string; payload: Record<string, unknown> }> = [];
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async (name: string, payload: Record<string, unknown>) => {
        enqueued.push({ name, payload });
        return undefined;
    }),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { toDispatchPayload } from '@/app-layer/automation';
import { runAutomationEventDispatch } from '@/app-layer/jobs/automation-event-dispatch';
import { runRuleChainDispatch } from '@/app-layer/jobs/rule-chain-dispatch';
import { runAgentInvokeDispatch } from '@/app-layer/jobs/agent-invoke-dispatch';
import type {
    AgentInvokeDispatchPayload,
    AutomationEventDispatchPayload,
    RuleChainDispatchPayload,
} from '@/app-layer/jobs/types';
import { listCanvasAgentRuns } from '@/app-layer/usecases/automation-executions';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `lineage-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const OWNER = `u-${SUITE}`;
const AGENT = `ag-${SUITE}`;
const WF = `lineage-wf-${SUITE}`;

const ownerCtx = () => makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: OWNER });

function taskCreated(taskId: string): AutomationEventDispatchPayload {
    return toDispatchPayload({
        event: 'TASK_CREATED',
        tenantId: TENANT,
        entityType: 'Task',
        entityId: taskId,
        actorUserId: OWNER,
        emittedAt: new Date(),
        stableKey: taskId,
        data: { title: 'Review the vendor contract' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
}

function takeEnqueued<T>(name: string): T {
    const i = enqueued.findIndex((e) => e.name === name);
    if (i < 0) throw new Error(`nothing enqueued on ${name}; saw ${enqueued.map((e) => e.name).join(', ') || 'nothing'}`);
    return enqueued.splice(i, 1)[0].payload as T;
}

async function invokeAgentRule(name: string, triggerEvent: string) {
    return prisma.automationRule.create({
        data: {
            tenantId: TENANT,
            name,
            triggerEvent,
            actionType: 'INVOKE_AGENT',
            actionConfigJson: { agentId: AGENT, workflowKey: WF },
            status: 'ENABLED',
            createdByUserId: OWNER,
        },
    });
}

async function cleanup(): Promise<void> {
    await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: TENANT } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
    await prisma.notification.deleteMany({ where: { tenantId: TENANT } });
    await prisma.automationExecution.deleteMany({ where: { tenantId: TENANT } });
    await prisma.automationRule.updateMany({ where: { tenantId: TENANT }, data: { nextRuleId: null } });
    await prisma.automationRule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
    });
    await deleteAuditRowsForTenants(prisma, TENANT);
    await prisma.user.deleteMany({ where: { id: OWNER } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

describeFn('an automation-started run names the execution that started it (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        await createTenantWithDek({ id: TENANT, name: TENANT, slug: TENANT });
        const email = `${OWNER}@example.test`;
        await prisma.user.create({ data: { id: OWNER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({ data: { tenantId: TENANT, userId: OWNER, role: 'OWNER', status: 'ACTIVE' } });
        const sys = await prisma.aiSystem.create({ data: { tenantId: TENANT, name: `sys-${SUITE}` } });
        await prisma.registeredAgent.create({
            data: {
                id: AGENT,
                tenantId: TENANT,
                aiSystemId: sys.id,
                name: `agent ${SUITE}`,
                autonomyLevel: 1,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: OWNER,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
            },
        });
        registerWorkflow({
            key: WF,
            name: 'Lineage probe',
            description: 'one synthesis, so a run completes without a checkpoint',
            steps: [{ kind: 'SYNTHESIS', label: 'summary', synthesize: () => ({ text: 'done' }) }],
        });
    });

    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    beforeEach(() => {
        enqueued.length = 0;
    });

    it('a rule fired directly by TASK_CREATED starts a run that names its execution, and the canvas lists it', async () => {
        const rule = await invokeAgentRule(`direct-${SUITE}`, 'TASK_CREATED');

        const dispatched = await runAutomationEventDispatch(taskCreated(`task-direct-${SUITE}`));
        expect(dispatched.executionsCreated).toBe(1);
        const execution = await prisma.automationExecution.findFirstOrThrow({
            where: { tenantId: TENANT, ruleId: rule.id },
            select: { id: true, status: true, triggeredBy: true },
        });
        expect(execution).toMatchObject({ status: 'SUCCEEDED', triggeredBy: 'event' });

        const payload = takeEnqueued<AgentInvokeDispatchPayload>('agent-invoke-dispatch');
        expect(payload.parentExecutionId).toBe(execution.id);

        const { runId, refusal } = await runAgentInvokeDispatch(payload);
        expect(refusal).toBeNull();
        expect(runId).toBeTruthy();
        const run = await prisma.workflowRun.findUniqueOrThrow({
            where: { id: runId! },
            select: { parentExecutionId: true, agentId: true },
        });
        expect(run).toEqual({ parentExecutionId: execution.id, agentId: AGENT });

        // THE READER THE COLUMN EXISTS FOR: the canvas's agent view puts the
        // run on the rule's node.
        const { nodes } = await listCanvasAgentRuns(ownerCtx());
        expect(nodes.find((n) => n.ruleId === rule.id)?.runId).toBe(runId);
    });

    it("a CHAINED rule's run names the chain step's own execution, not the upstream rule's", async () => {
        // The invoker listens on an event this test never emits, so only the
        // chain reaches it.
        const invoker = await invokeAgentRule(`chained-${SUITE}`, 'RISK_CREATED');
        // The upstream rule notifies the owner and hands on.
        const upstream = await prisma.automationRule.create({
            data: {
                tenantId: TENANT,
                name: `upstream-${SUITE}`,
                triggerEvent: 'TASK_STATUS_CHANGED',
                actionType: 'NOTIFY_USER',
                actionConfigJson: { userIds: [OWNER], message: 'status changed' },
                status: 'ENABLED',
                createdByUserId: OWNER,
                nextRuleId: invoker.id,
            },
        });

        const event = taskCreated(`task-chain-${SUITE}`);
        await runAutomationEventDispatch({ ...event, event: { ...event.event, event: 'TASK_STATUS_CHANGED' } });
        const upstreamExec = await prisma.automationExecution.findFirstOrThrow({
            where: { tenantId: TENANT, ruleId: upstream.id },
            select: { id: true },
        });

        await runRuleChainDispatch(takeEnqueued<RuleChainDispatchPayload>('rule-chain-dispatch'));
        const stepExec = await prisma.automationExecution.findFirstOrThrow({
            where: { tenantId: TENANT, ruleId: invoker.id, triggeredBy: 'chain' },
            select: { id: true, parentExecutionId: true },
        });
        // The chain step's own row still links to the upstream (unchanged).
        expect(stepExec.parentExecutionId).toBe(upstreamExec.id);

        const payload = takeEnqueued<AgentInvokeDispatchPayload>('agent-invoke-dispatch');
        expect(payload.parentExecutionId).toBe(stepExec.id);

        const { runId } = await runAgentInvokeDispatch(payload);
        const { nodes } = await listCanvasAgentRuns(ownerCtx());
        expect(nodes.find((n) => n.ruleId === invoker.id)?.runId).toBe(runId);
    });
});
