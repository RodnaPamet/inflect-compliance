/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * VR-7 — sub-flow dispatch job: resolve a group's entry rule and run it as a
 * child execution linked to the invoking execution.
 */
jest.mock('@/lib/prisma', () => ({
    prisma: {
        automationRule: { findFirst: jest.fn(), updateMany: jest.fn() },
        automationExecution: { create: jest.fn(), updateMany: jest.fn() },
    },
}));
jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_n: string, fn: () => any) => fn()),
}));

import { runSubflowDispatch } from '@/app-layer/jobs/subflow-dispatcher';
import { prisma } from '@/lib/prisma';

const mockPrisma = prisma as any;

const payload = {
    tenantId: 't1',
    targetGroupId: 'group-1',
    parentExecutionId: 'exec-parent',
    triggerEvent: 'RISK_CREATED',
    data: {},
};

beforeEach(() => jest.clearAllMocks());

describe('runSubflowDispatch', () => {
    it('dispatches the group entry rule as a linked child execution', async () => {
        mockPrisma.automationRule.findFirst.mockResolvedValue({ id: 'entry-rule', actionType: 'NOTIFY_USER' });
        mockPrisma.automationExecution.create.mockResolvedValue({ id: 'child-exec' });

        const { result, executionId } = await runSubflowDispatch(payload);

        expect(executionId).toBe('child-exec');
        expect(result.success).toBe(true);
        // entry-rule lookup is scoped to the target group + tenant + ENABLED
        const where = mockPrisma.automationRule.findFirst.mock.calls[0][0].where;
        expect(where).toMatchObject({ tenantId: 't1', subFlowGroupId: 'group-1', status: 'ENABLED' });
        // child execution carries the parent lineage + subflow trigger source
        const created = mockPrisma.automationExecution.create.mock.calls[0][0].data;
        expect(created.parentExecutionId).toBe('exec-parent');
        expect(created.triggeredBy).toBe('subflow');
        expect(created.ruleId).toBe('entry-rule');
        // Claimed before the action, under the invocation's key (#5103)…
        expect(created.status).toBe('RUNNING');
        expect(created.idempotencyKey).toBe('subflow:exec-parent:group-1');
        // …and settled from RUNNING.
        const settle = mockPrisma.automationExecution.updateMany.mock.calls[0][0];
        expect(settle.where).toMatchObject({ id: 'child-exec', status: 'RUNNING' });
        expect(['SUCCEEDED', 'FAILED']).toContain(settle.data.status);
    });

    it('a retried invocation that finds its claim taken does NOT run the action again (#5103)', async () => {
        mockPrisma.automationRule.findFirst.mockResolvedValue({ id: 'entry-rule', actionType: 'NOTIFY_USER' });
        const { Prisma } = jest.requireActual('@prisma/client');
        mockPrisma.automationExecution.create.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
                code: 'P2002',
                clientVersion: 'test',
            }),
        );

        const { result, executionId } = await runSubflowDispatch(payload);

        expect(executionId).toBeNull();
        expect(result.details).toMatchObject({ dispatched: false, skipped: 'already-claimed' });
        expect(mockPrisma.automationExecution.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.automationRule.updateMany).not.toHaveBeenCalled();
    });

    it('keys no claim on an invocation with no parent, so top-level invocations never collide', async () => {
        mockPrisma.automationRule.findFirst.mockResolvedValue({ id: 'entry-rule', actionType: 'NOTIFY_USER' });
        mockPrisma.automationExecution.create.mockResolvedValue({ id: 'child-exec' });

        await runSubflowDispatch({ ...payload, parentExecutionId: '' });

        expect(mockPrisma.automationExecution.create.mock.calls[0][0].data.idempotencyKey).toBeNull();
    });

    it('skips cleanly when the group has no enabled entry rule', async () => {
        mockPrisma.automationRule.findFirst.mockResolvedValue(null);
        const { result, executionId } = await runSubflowDispatch(payload);
        expect(executionId).toBeNull();
        expect(result.success).toBe(true);
        expect(mockPrisma.automationExecution.create).not.toHaveBeenCalled();
    });
});
