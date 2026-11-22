/**
 * AN INVOKE_SUBFLOW RULE STARTS THE GROUP'S ENTRY RULE (#5477).
 *
 * The sub-flow dispatcher starts the highest-priority ENABLED rule whose
 * `subFlowGroupId` is the invoked group's key, and nothing ever wrote that
 * column, so every invocation started nothing. Owner decision (2026-11-14):
 * membership is canvas nesting, written by the canvas save.
 *
 * Real path against Postgres: the canvas save through `saveProcessMap`, the
 * invoking rule fired by the real event dispatcher, its captured
 * `subflow-dispatch` payload handed to the real dispatcher. Only the queue is
 * replaced.
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
import { toDispatchPayload } from '@/app-layer/automation';
import { runAutomationEventDispatch } from '@/app-layer/jobs/automation-event-dispatch';
import { runSubflowDispatch } from '@/app-layer/jobs/subflow-dispatcher';
import type { AutomationEventDispatchPayload, SubflowDispatchPayload } from '@/app-layer/jobs/types';
import { createProcessMap, listSubflowGroups, saveProcessMap } from '@/app-layer/usecases/process-map';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `sfg-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const OWNER = `u-${SUITE}`;
const GROUP = `group-${SUITE}`;
const INNER = `inner-${SUITE}`;

const ownerCtx = () => makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: OWNER });

type SavedNode = { nodeKey: string; dataJson: unknown };

function node(nodeKey: string, nodeType: string, parentNodeKey: string | null, dataJson: unknown = null) {
    return { nodeKey, nodeType, label: nodeKey, subtitle: null, posX: 0, posY: 0, parentNodeKey, dataJson };
}
const ruleIdOf = (nodes: SavedNode[], key: string) =>
    (nodes.find((n) => n.nodeKey === key)?.dataJson as { ruleId?: string } | null)?.ruleId as string;
const groupOf = async (ruleId: string) =>
    (await prisma.automationRule.findUniqueOrThrow({ where: { id: ruleId }, select: { subFlowGroupId: true } }))
        .subFlowGroupId;

function taskCreated(taskId: string): AutomationEventDispatchPayload {
    return toDispatchPayload({
        event: 'TASK_CREATED',
        tenantId: TENANT,
        entityType: 'Task',
        entityId: taskId,
        actorUserId: OWNER,
        emittedAt: new Date(),
        stableKey: taskId,
        data: { title: 'Kick off the sub-flow' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
}

async function cleanup(): Promise<void> {
    await prisma.notification.deleteMany({ where: { tenantId: TENANT } });
    await prisma.automationExecution.updateMany({ where: { tenantId: TENANT }, data: { parentExecutionId: null } });
    await prisma.automationExecution.deleteMany({ where: { tenantId: TENANT } });
    await prisma.automationRule.updateMany({
        where: { tenantId: TENANT },
        data: { nextRuleId: null, elseRuleId: null },
    });
    await prisma.automationRule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.processEdge.deleteMany({ where: { tenantId: TENANT } });
    await prisma.processNode.deleteMany({ where: { tenantId: TENANT } });
    await prisma.processMapSnapshot.deleteMany({ where: { tenantId: TENANT } });
    await prisma.processMap.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
    });
    await deleteAuditRowsForTenants(prisma, TENANT);
    await prisma.user.deleteMany({ where: { id: OWNER } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

describeFn('sub-flow group membership is canvas nesting (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        await createTenantWithDek({ id: TENANT, name: TENANT, slug: TENANT });
        const email = `${OWNER}@example.test`;
        await prisma.user.create({ data: { id: OWNER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: TENANT, userId: OWNER, role: 'OWNER', status: 'ACTIVE' },
        });
    });

    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    it('a save writes membership, an invocation starts the highest-priority member, and leaving the group clears it', async () => {
        const ctx = ownerCtx();
        const map = await createProcessMap(ctx, { name: `${SUITE} flow`, canvasMode: 'AUTOMATION' } as never);

        // A group holding two steps, a group nested inside it holding a third,
        // and a step at root.
        const first = await saveProcessMap(ctx, map.id, {
            nodes: [
                node(GROUP, 'group', null),
                node('low', 'action', GROUP),
                node('high', 'action', GROUP),
                node(INNER, 'group', GROUP),
                node('nested', 'action', INNER),
                node('root', 'action', null),
            ],
            edges: [],
        } as never);
        const low = ruleIdOf(first.nodes, 'low');
        const high = ruleIdOf(first.nodes, 'high');
        const nested = ruleIdOf(first.nodes, 'nested');
        const root = ruleIdOf(first.nodes, 'root');

        expect(await groupOf(low)).toBe(GROUP);
        expect(await groupOf(high)).toBe(GROUP);
        // Nearest enclosing group only.
        expect(await groupOf(nested)).toBe(INNER);
        expect(await groupOf(root)).toBeNull();

        // The picker's read lists both groups, labelled by map and group.
        const groups = await listSubflowGroups(ctx);
        expect(groups.map((g) => g.nodeKey).sort()).toEqual([GROUP, INNER].sort());
        expect(groups.find((g) => g.nodeKey === GROUP)).toMatchObject({ mapId: map.id, mapName: `${SUITE} flow` });

        // Configure the two members; the HIGHER priority one is the entry.
        // The nested step carries the highest priority of all, and must not
        // start, because it is a member of the inner group only.
        const notify = {
            triggerEvent: 'RISK_CREATED',
            actionType: 'NOTIFY_USER' as const,
            actionConfigJson: { userIds: [OWNER], message: 'sub-flow ran' },
            status: 'ENABLED' as const,
        };
        await prisma.automationRule.update({ where: { id: low }, data: { ...notify, priority: 1 } });
        await prisma.automationRule.update({ where: { id: high }, data: { ...notify, priority: 5 } });
        await prisma.automationRule.update({ where: { id: nested }, data: { ...notify, priority: 99 } });

        const invoker = await prisma.automationRule.create({
            data: {
                tenantId: TENANT,
                name: `invoker-${SUITE}`,
                triggerEvent: 'TASK_CREATED',
                actionType: 'INVOKE_SUBFLOW',
                actionConfigJson: { targetGroupId: GROUP },
                status: 'ENABLED',
                createdByUserId: OWNER,
            },
        });

        enqueued.length = 0;
        const dispatched = await runAutomationEventDispatch(taskCreated(`task-${SUITE}`));
        expect(dispatched.executionsCreated).toBe(1);
        const invokerExec = await prisma.automationExecution.findFirstOrThrow({
            where: { tenantId: TENANT, ruleId: invoker.id },
            select: { id: true, status: true },
        });
        expect(invokerExec.status).toBe('SUCCEEDED');

        const i = enqueued.findIndex((e) => e.name === 'subflow-dispatch');
        expect(i).toBeGreaterThanOrEqual(0);
        const payload = enqueued[i].payload as unknown as SubflowDispatchPayload;
        expect(payload).toMatchObject({ targetGroupId: GROUP, parentExecutionId: invokerExec.id });

        const { result, executionId } = await runSubflowDispatch(payload);
        expect(result.details).toMatchObject({ dispatched: true });
        const child = await prisma.automationExecution.findUniqueOrThrow({
            where: { id: executionId! },
            select: { ruleId: true, parentExecutionId: true, triggeredBy: true, status: true },
        });
        expect(child).toEqual({
            ruleId: high,
            parentExecutionId: invokerExec.id,
            triggeredBy: 'subflow',
            status: 'SUCCEEDED',
        });

        // Move `high` out of the group and remove `low`'s step: both leave it.
        const second = await saveProcessMap(ctx, map.id, {
            nodes: [
                node(GROUP, 'group', null),
                node('high', 'action', null, { ruleId: high }),
                node(INNER, 'group', GROUP),
                node('nested', 'action', INNER, { ruleId: nested }),
                node('root', 'action', null, { ruleId: root }),
            ],
            edges: [],
        } as never);
        expect(ruleIdOf(second.nodes, 'high')).toBe(high);
        expect(await groupOf(high)).toBeNull();
        expect(await groupOf(low)).toBeNull();
        expect(await groupOf(nested)).toBe(INNER);

        // Removing the inner group (its step moved to root) clears it too.
        await saveProcessMap(ctx, map.id, {
            nodes: [
                node(GROUP, 'group', null),
                node('high', 'action', null, { ruleId: high }),
                node('nested', 'action', null, { ruleId: nested }),
                node('root', 'action', null, { ruleId: root }),
            ],
            edges: [],
        } as never);
        expect(await groupOf(nested)).toBeNull();

        // With no member left, an invocation of the group starts nothing.
        const empty = await runSubflowDispatch({ ...payload, parentExecutionId: '' });
        expect(empty.executionId).toBeNull();
        expect(empty.result.details).toMatchObject({ dispatched: false });
    });
});
