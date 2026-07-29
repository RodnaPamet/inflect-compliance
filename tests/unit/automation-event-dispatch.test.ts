/**
 * Unit Test: automation-event-dispatch job executor.
 *
 * Pins the per-event dispatch contract against a mocked Prisma:
 *   - loads only ENABLED, non-deleted rules scoped to event.tenantId
 *     and event.event
 *   - skips rules whose triggerFilterJson doesn't match event.data
 *   - inserts a PENDING AutomationExecution per matching rule and
 *     advances it to SUCCEEDED
 *   - bumps the rule's executionCount + lastTriggeredAt
 *   - treats Prisma P2002 (idempotency collision) as a silent skip
 *   - fails the dispatch on tenantId mismatch (producer-bug guard)
 */

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(
        async (_name: string, fn: () => Promise<unknown>) => fn()
    ),
}));

// The chain hop is a dynamic `await import('./queue')` inside the executor.
const enqueue = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));

// Build the mock BEFORE importing the executor so the import binds
// to the mocked prisma client.
const automationRule = {
    findMany: jest.fn(),
};
const automationExecution = {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
};
const automationRuleUpdate = {
    updateMany: jest.fn(),
};

jest.mock('@/lib/prisma', () => ({
    prisma: {
        automationRule: {
            findMany: (...args: unknown[]) => automationRule.findMany(...args),
            updateMany: (...args: unknown[]) =>
                automationRuleUpdate.updateMany(...args),
        },
        automationExecution: {
            create: (...args: unknown[]) => automationExecution.create(...args),
            update: (...args: unknown[]) => automationExecution.update(...args),
            updateMany: (...args: unknown[]) =>
                automationExecution.updateMany(...args),
        },
    },
}));

import { Prisma } from '@prisma/client';
import { runAutomationEventDispatch } from '@/app-layer/jobs/automation-event-dispatch';
import type { AutomationEventDispatchPayload } from '@/app-layer/jobs/types';

function makePayload(
    overrides?: Partial<AutomationEventDispatchPayload['event']>
): AutomationEventDispatchPayload {
    const event = {
        event: 'RISK_CREATED',
        tenantId: 'tenant-A',
        entityType: 'Risk',
        entityId: 'risk-1',
        actorUserId: 'user-1',
        emittedAt: new Date().toISOString(),
        stableKey: 'risk-1',
        data: { title: 'SQLi', score: 20, category: 'SECURITY' },
        ...overrides,
    };
    return { tenantId: event.tenantId, event };
}

function rule(overrides: Partial<{
    id: string;
    triggerFilterJson: Record<string, string | number | boolean> | null;
    actionType: string;
    nextRuleId: string | null;
    nextRuleDelay: number | null;
}> = {}) {
    return {
        id: 'rule-1',
        tenantId: 'tenant-A',
        name: 'N',
        description: null,
        triggerEvent: 'RISK_CREATED',
        triggerFilterJson: null,
        actionType: 'NOTIFY_USER',
        actionConfigJson: {},
        status: 'ENABLED',
        priority: 0,
        executionCount: 0,
        lastTriggeredAt: null,
        createdByUserId: null,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        ...overrides,
    };
}

describe('runAutomationEventDispatch', () => {
    beforeEach(() => {
        automationRule.findMany.mockReset();
        automationExecution.create.mockReset();
        automationExecution.update.mockReset();
        automationExecution.updateMany.mockReset();
        automationRuleUpdate.updateMany.mockReset();
        enqueue.mockReset();

        automationExecution.create.mockResolvedValue({ id: 'exec-1' });
        automationExecution.update.mockResolvedValue({ id: 'exec-1' });
        automationExecution.updateMany.mockResolvedValue({ count: 1 });
        automationRuleUpdate.updateMany.mockResolvedValue({ count: 1 });
    });

    it('scopes rule lookup to tenantId + triggerEvent + ENABLED + not-deleted', async () => {
        automationRule.findMany.mockResolvedValue([]);

        await runAutomationEventDispatch(makePayload());

        const call = automationRule.findMany.mock.calls[0][0];
        expect(call.where).toEqual({
            tenantId: 'tenant-A',
            triggerEvent: 'RISK_CREATED',
            status: 'ENABLED',
            deletedAt: null,
        });
        expect(call.orderBy).toEqual([
            { priority: 'desc' },
            { createdAt: 'asc' },
        ]);
    });

    it('creates an execution row per matching rule and advances to SUCCEEDED', async () => {
        automationRule.findMany.mockResolvedValue([rule()]);

        const result = await runAutomationEventDispatch(makePayload());

        expect(result.rulesConsidered).toBe(1);
        expect(result.rulesMatched).toBe(1);
        expect(result.executionsCreated).toBe(1);
        expect(result.executionsFailed).toBe(0);

        // Pending insert
        const createArgs = automationExecution.create.mock.calls[0][0];
        expect(createArgs.data.tenantId).toBe('tenant-A');
        expect(createArgs.data.ruleId).toBe('rule-1');
        expect(createArgs.data.status).toBe('PENDING');
        expect(createArgs.data.triggerEvent).toBe('RISK_CREATED');
        expect(createArgs.data.idempotencyKey).toBe(
            'rule-1:RISK_CREATED:risk-1'
        );
        expect(createArgs.data.triggeredBy).toBe('event');

        // PENDING → RUNNING
        const runningArgs = automationExecution.updateMany.mock.calls[0][0];
        expect(runningArgs.where).toEqual({
            id: 'exec-1',
            tenantId: 'tenant-A',
            status: 'PENDING',
        });
        expect(runningArgs.data.status).toBe('RUNNING');

        // RUNNING → SUCCEEDED, scoped to status RUNNING so it cannot
        // overwrite an operator's cancellation.
        const completeArgs = automationExecution.updateMany.mock.calls[1][0];
        expect(completeArgs.where).toEqual({
            id: 'exec-1',
            tenantId: 'tenant-A',
            status: 'RUNNING',
        });
        expect(completeArgs.data.status).toBe('SUCCEEDED');
        expect(completeArgs.data.outcomeJson).toMatchObject({
            actionType: 'NOTIFY_USER',
        });
        expect(completeArgs.data.completedAt).toBeInstanceOf(Date);

        // Rule counter bumped
        const bumpArgs = automationRuleUpdate.updateMany.mock.calls[0][0];
        expect(bumpArgs.where).toEqual({
            id: 'rule-1',
            tenantId: 'tenant-A',
        });
        expect(bumpArgs.data.executionCount).toEqual({ increment: 1 });
        expect(bumpArgs.data.lastTriggeredAt).toBeInstanceOf(Date);
    });

    it('skips rules whose filter does not match', async () => {
        automationRule.findMany.mockResolvedValue([
            rule({ triggerFilterJson: { category: 'PRIVACY' } }),
        ]);

        const result = await runAutomationEventDispatch(makePayload());

        expect(result.rulesConsidered).toBe(1);
        expect(result.rulesMatched).toBe(0);
        expect(result.executionsCreated).toBe(0);
        expect(result.executionsSkippedFilter).toBe(1);
        expect(automationExecution.create).not.toHaveBeenCalled();
    });

    it('treats Prisma P2002 on execution claim as silent duplicate-skip', async () => {
        automationRule.findMany.mockResolvedValue([rule()]);
        automationExecution.create.mockRejectedValueOnce(
            new Prisma.PrismaClientKnownRequestError(
                'Unique constraint failed',
                { code: 'P2002', clientVersion: 'test', meta: {} }
            )
        );

        const result = await runAutomationEventDispatch(makePayload());

        expect(result.executionsCreated).toBe(0);
        expect(result.executionsSkippedDuplicate).toBe(1);
        expect(result.executionsFailed).toBe(0);
        expect(automationExecution.updateMany).not.toHaveBeenCalled();
    });

    it('counts non-P2002 claim failures as failed, not skipped', async () => {
        automationRule.findMany.mockResolvedValue([rule()]);
        automationExecution.create.mockRejectedValueOnce(
            new Error('connection lost')
        );

        const result = await runAutomationEventDispatch(makePayload());

        expect(result.executionsFailed).toBe(1);
        expect(result.executionsSkippedDuplicate).toBe(0);
    });

    it('marks the execution FAILED when the settle write throws', async () => {
        automationRule.findMany.mockResolvedValue([rule()]);
        // updateMany call order: [0] PENDING→RUNNING claim, [1] settle.
        automationExecution.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockImplementationOnce(async () => {
                throw new Error('boom');
            })
            .mockResolvedValue({ count: 1 });

        const result = await runAutomationEventDispatch(makePayload());

        expect(result.executionsFailed).toBe(1);
        const failedArgs = automationExecution.updateMany.mock.calls[2][0];
        expect(failedArgs.data.status).toBe('FAILED');
        expect(failedArgs.data.errorMessage).toBe('boom');
        expect(failedArgs.data.completedAt).toBeInstanceOf(Date);
        // The catch path is RUNNING-scoped too: a throw must not overwrite a
        // cancellation any more than a success may.
        expect(failedArgs.where).toEqual({
            id: 'exec-1',
            tenantId: 'tenant-A',
            status: 'RUNNING',
        });
    });

    describe('an operator cancellation survives the dispatcher', () => {
        it('does not run the action at all when the cancel landed pre-start', async () => {
            // Cancel writes SKIPPED, so the PENDING→RUNNING claim matches no
            // row. The claim result used to be discarded and the action fired
            // regardless — an operator who cancelled a queued execution still
            // got the webhook.
            automationRule.findMany.mockResolvedValue([rule()]);
            automationExecution.updateMany.mockResolvedValueOnce({ count: 0 });

            const result = await runAutomationEventDispatch(makePayload());

            // The claim is the ONLY execution write; no settle, no counter bump.
            expect(automationExecution.updateMany).toHaveBeenCalledTimes(1);
            expect(automationRuleUpdate.updateMany).not.toHaveBeenCalled();
            expect(result.executionsFailed).toBe(0);
        });

        it('leaves the row cancelled when the cancel landed mid-flight', async () => {
            // The action cannot be recalled, but the RECORD must not lie: the
            // settle write matches no RUNNING row, so SKIPPED stands.
            automationRule.findMany.mockResolvedValue([rule()]);
            automationExecution.updateMany
                .mockResolvedValueOnce({ count: 1 }) // claim
                .mockResolvedValueOnce({ count: 0 }); // settle — row is SKIPPED

            const result = await runAutomationEventDispatch(makePayload());

            const settle = automationExecution.updateMany.mock.calls[1][0];
            expect(settle.where.status).toBe('RUNNING');
            expect(result.executionsFailed).toBe(0);
        });

        it('does not fire the chained rule after a mid-flight cancel', async () => {
            // The part of "cancel" that CAN still be honoured: stop everything
            // downstream.
            automationRule.findMany.mockResolvedValue([
                rule({ nextRuleId: 'rule-2' }),
            ]);
            automationExecution.updateMany
                .mockResolvedValueOnce({ count: 1 })
                .mockResolvedValueOnce({ count: 0 });

            await runAutomationEventDispatch(makePayload());

            expect(enqueue).not.toHaveBeenCalled();
        });

        it('DOES fire the chained rule on an uncancelled run', async () => {
            // Guards the assertion above from passing for the wrong reason.
            automationRule.findMany.mockResolvedValue([
                rule({ nextRuleId: 'rule-2' }),
            ]);

            await runAutomationEventDispatch(makePayload());

            expect(enqueue).toHaveBeenCalledWith(
                'rule-chain-dispatch',
                expect.objectContaining({ ruleId: 'rule-2' }),
                undefined,
            );
        });
    });

    it('throws on tenantId mismatch between payload and event', async () => {
        const bad: AutomationEventDispatchPayload = {
            tenantId: 'tenant-A',
            event: {
                event: 'RISK_CREATED',
                tenantId: 'tenant-B', // MISMATCH
                entityType: 'Risk',
                entityId: 'r-1',
                actorUserId: null,
                emittedAt: new Date().toISOString(),
                data: {},
            },
        };

        await expect(runAutomationEventDispatch(bad)).rejects.toThrow(
            /tenantId mismatch/
        );
        expect(automationRule.findMany).not.toHaveBeenCalled();
    });

    it('omits idempotencyKey when producer did not supply stableKey', async () => {
        automationRule.findMany.mockResolvedValue([rule()]);

        await runAutomationEventDispatch(
            makePayload({ stableKey: undefined })
        );

        const createArgs = automationExecution.create.mock.calls[0][0];
        expect(createArgs.data.idempotencyKey).toBeNull();
    });

    it('processes rules in priority order (highest first)', async () => {
        // Produce rules ordered by the findMany call (prisma orderBy
        // already sorts priority desc, so the mock returns them
        // pre-sorted).
        automationRule.findMany.mockResolvedValue([
            rule({ id: 'rule-high' }),
            rule({ id: 'rule-low' }),
        ]);

        await runAutomationEventDispatch(makePayload());

        // Two pending inserts in the order returned.
        const createCalls = automationExecution.create.mock.calls;
        expect(createCalls.length).toBe(2);
        expect(createCalls[0][0].data.ruleId).toBe('rule-high');
        expect(createCalls[1][0].data.ruleId).toBe('rule-low');
    });
});
