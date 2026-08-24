/**
 * Integration Test — End-to-end automation event flow.
 *
 * Walks the full backbone against a real Postgres:
 *   1. Create a tenant + an ENABLED AutomationRule subscribed to
 *      RISK_CREATED (+ optional filter).
 *   2. Hand `runAutomationEventDispatch` a realistic payload (the
 *      same shape the BullMQ worker receives).
 *   3. Assert an AutomationExecution row was persisted with the
 *      expected tenantId / ruleId / status / outcome.
 *   4. Re-run with the same stableKey and assert the second call is
 *      deduped (no second execution row; result counts it as
 *      skippedDuplicate).
 *
 * Skipping BullMQ itself here is intentional: the bus-bootstrap unit
 * test already pins `emit → enqueue`, and the dispatch-executor
 * unit test pins the mocked-Prisma flow. This test closes the loop
 * by proving the executor writes the row the UI will later read.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { PrismaClient } from '@prisma/client';
import { runAutomationEventDispatch } from '@/app-layer/jobs/automation-event-dispatch';
import type { AutomationEventDispatchPayload } from '@/app-layer/jobs/types';
import { toDispatchPayload } from '@/app-layer/automation';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TEST_PREFIX = `AUTO_FLOW_${Date.now()}`;

describeFn('Automation event flow — emit → dispatch → execution row', () => {
    let prisma: PrismaClient;
    let tenantId: string;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const tenant = await prisma.tenant.upsert({
            where: { slug: `auto-flow-${Date.now()}` },
            update: {},
            create: {
                name: 'Automation Flow Test',
                slug: `auto-flow-${Date.now()}`,
            },
        });
        tenantId = tenant.id;
    });

    afterAll(async () => {
        try {
            // Guarded: on a failed `beforeAll` this bare `let` is still
            // undefined, and Prisma DROPS an undefined filter value rather
            // than rejecting it, so the unguarded form is an unpredicated
            // DELETE — see the teardown note in ./db-helper.ts.
            if (tenantId) {
                await prisma.automationExecution.deleteMany({ where: { tenantId } });
                await prisma.automationRule.deleteMany({ where: { tenantId } });
            }
        } catch {
            /* best effort */
        }
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await prisma.automationExecution.deleteMany({ where: { tenantId } });
        await prisma.automationRule.deleteMany({ where: { tenantId } });
    });

    function buildEventPayload(
        overrides: Partial<AutomationEventDispatchPayload['event']> = {}
    ): AutomationEventDispatchPayload {
        return toDispatchPayload({
            event: 'RISK_CREATED',
            tenantId,
            entityType: 'Risk',
            entityId: `risk-${TEST_PREFIX}`,
            actorUserId: 'user-integration',
            emittedAt: new Date(),
            stableKey: `risk-${TEST_PREFIX}`,
            data: { title: 'Exposed S3 bucket', score: 20, category: 'SECURITY' },
            ...overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    }

    test('matching rule persists a SUCCEEDED AutomationExecution row', async () => {
        const rule = await prisma.automationRule.create({
            data: {
                tenantId,
                name: `${TEST_PREFIX}-rule-basic`,
                triggerEvent: 'RISK_CREATED',
                actionType: 'NOTIFY_USER',
                actionConfigJson: { userIds: ['u-1'], message: 'alert' },
                status: 'ENABLED',
                priority: 0,
            },
        });

        const result = await runAutomationEventDispatch(buildEventPayload());

        expect(result.rulesConsidered).toBe(1);
        expect(result.rulesMatched).toBe(1);
        expect(result.executionsCreated).toBe(1);
        expect(result.executionsFailed).toBe(0);

        const executions = await prisma.automationExecution.findMany({
            where: { tenantId, ruleId: rule.id },
            orderBy: { createdAt: 'asc' },
        });
        expect(executions).toHaveLength(1);
        const exec = executions[0];
        expect(exec.status).toBe('SUCCEEDED');
        expect(exec.triggerEvent).toBe('RISK_CREATED');
        expect(exec.triggeredBy).toBe('event');
        expect(exec.idempotencyKey).toBe(
            `${rule.id}:RISK_CREATED:risk-${TEST_PREFIX}`
        );
        expect(exec.completedAt).toBeInstanceOf(Date);
        expect(exec.outcomeJson).toMatchObject({ actionType: 'NOTIFY_USER' });

        // Rule counter bumped.
        const after = await prisma.automationRule.findUnique({
            where: { id: rule.id },
        });
        expect(after?.executionCount).toBe(1);
        expect(after?.lastTriggeredAt).toBeInstanceOf(Date);
    });

    test('NOTIFY_USER actually creates a Notification row for a real member', async () => {
        // Real recipient — a user who is a member of the firing tenant.
        const user = await prisma.user.create({
            data: { email: `notify-${TEST_PREFIX}@example.com`, name: 'Notify Target' },
        });
        await prisma.tenantMembership.create({
            data: { tenantId, userId: user.id, role: 'EDITOR', status: 'ACTIVE' },
        });
        const rule = await prisma.automationRule.create({
            data: {
                tenantId,
                name: `${TEST_PREFIX}-rule-notify`,
                triggerEvent: 'RISK_CREATED',
                actionType: 'NOTIFY_USER',
                actionConfigJson: { userIds: [user.id], message: 'a risk needs you' },
                status: 'ENABLED',
                priority: 0,
            },
        });

        const result = await runAutomationEventDispatch(buildEventPayload());
        expect(result.executionsFailed).toBe(0);

        // The action executed for real — a Notification row exists.
        const notes = await prisma.notification.findMany({
            where: { tenantId, userId: user.id },
        });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({ message: 'a risk needs you', title: rule.name });

        const exec = await prisma.automationExecution.findFirst({
            where: { tenantId, ruleId: rule.id },
        });
        expect(exec?.status).toBe('SUCCEEDED');
        expect(exec?.outcomeJson).toMatchObject({ notified: 1 });

        // Cleanup the extra rows this test created.
        await prisma.notification.deleteMany({ where: { tenantId, userId: user.id } });
        await prisma.tenantMembership.deleteMany({ where: { userId: user.id } });
        await prisma.user.delete({ where: { id: user.id } });
    });

    test('non-matching filter does not create an execution row', async () => {
        await prisma.automationRule.create({
            data: {
                tenantId,
                name: `${TEST_PREFIX}-rule-filter`,
                triggerEvent: 'RISK_CREATED',
                triggerFilterJson: { category: 'PRIVACY' }, // event is SECURITY
                actionType: 'NOTIFY_USER',
                actionConfigJson: { userIds: ['u-1'], message: 'x' },
                status: 'ENABLED',
            },
        });

        const result = await runAutomationEventDispatch(buildEventPayload());

        expect(result.rulesMatched).toBe(0);
        expect(result.executionsCreated).toBe(0);
        expect(result.executionsSkippedFilter).toBe(1);

        const count = await prisma.automationExecution.count({
            where: { tenantId },
        });
        expect(count).toBe(0);
    });

    test('same stableKey twice creates exactly one execution row (idempotency)', async () => {
        await prisma.automationRule.create({
            data: {
                tenantId,
                name: `${TEST_PREFIX}-rule-idem`,
                triggerEvent: 'RISK_CREATED',
                actionType: 'NOTIFY_USER',
                actionConfigJson: { userIds: ['u-1'], message: 'x' },
                status: 'ENABLED',
            },
        });

        const first = await runAutomationEventDispatch(buildEventPayload());
        const second = await runAutomationEventDispatch(buildEventPayload());

        expect(first.executionsCreated).toBe(1);
        expect(second.executionsCreated).toBe(0);
        expect(second.executionsSkippedDuplicate).toBe(1);

        const count = await prisma.automationExecution.count({
            where: { tenantId },
        });
        expect(count).toBe(1);
    });

    test('DISABLED rules are never considered', async () => {
        await prisma.automationRule.create({
            data: {
                tenantId,
                name: `${TEST_PREFIX}-rule-disabled`,
                triggerEvent: 'RISK_CREATED',
                actionType: 'NOTIFY_USER',
                actionConfigJson: { userIds: ['u-1'], message: 'x' },
                status: 'DISABLED',
            },
        });

        const result = await runAutomationEventDispatch(buildEventPayload());

        expect(result.rulesConsidered).toBe(0);
        expect(result.executionsCreated).toBe(0);
    });

    test('soft-deleted rules are never considered', async () => {
        await prisma.automationRule.create({
            data: {
                tenantId,
                name: `${TEST_PREFIX}-rule-archived`,
                triggerEvent: 'RISK_CREATED',
                actionType: 'NOTIFY_USER',
                actionConfigJson: { userIds: ['u-1'], message: 'x' },
                status: 'ARCHIVED',
                deletedAt: new Date(),
            },
        });

        const result = await runAutomationEventDispatch(buildEventPayload());

        expect(result.rulesConsidered).toBe(0);
        expect(result.executionsCreated).toBe(0);
    });

    test('rules for a different tenant are never considered (tenant isolation)', async () => {
        const otherTenant = await prisma.tenant.upsert({
            where: { slug: `auto-flow-other-${Date.now()}` },
            update: {},
            create: {
                name: 'Other Tenant',
                slug: `auto-flow-other-${Date.now()}`,
            },
        });

        try {
            await prisma.automationRule.create({
                data: {
                    tenantId: otherTenant.id,
                    name: `${TEST_PREFIX}-other-tenant-rule`,
                    triggerEvent: 'RISK_CREATED',
                    actionType: 'NOTIFY_USER',
                    actionConfigJson: { userIds: ['u-1'], message: 'x' },
                    status: 'ENABLED',
                },
            });

            const result = await runAutomationEventDispatch(buildEventPayload());

            expect(result.rulesConsidered).toBe(0);
            expect(result.executionsCreated).toBe(0);

            const leaked = await prisma.automationExecution.count({
                where: { tenantId: otherTenant.id },
            });
            expect(leaked).toBe(0);
        } finally {
            await prisma.automationExecution.deleteMany({
                where: { tenantId: otherTenant.id },
            });
            await prisma.automationRule.deleteMany({
                where: { tenantId: otherTenant.id },
            });
            await prisma.tenant.delete({ where: { id: otherTenant.id } });
        }
    });
});
