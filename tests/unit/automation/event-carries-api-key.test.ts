/**
 * The API key a request was made with reaches the automation executor (#4386).
 *
 * An author-less rule is bounded by the key only if the key's id survives
 * every hop between the request and `executeAction`: the bus stamps it from
 * the RequestContext, the BullMQ payload carries it, and the dispatcher
 * rehydrates it and hands it on. (A manual replay stamps it too; that is held
 * in `automation-executions-usecase.test.ts`.) Each hop is asserted
 * on the value that crosses it, because a dropped field is invisible to the
 * executor's own tests — they build the event by hand.
 *
 * And the other half: an event emitted without a key — a session, or a build
 * before this field — crosses every hop exactly as it always did, with no
 * `actorApiKeyId` member at all.
 */
const enqueue = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

const executeActionMock = jest.fn();
jest.mock('@/app-layer/automation/action-executor', () => ({
    executeAction: (...a: unknown[]) => executeActionMock(...a),
}));

jest.mock('@/app-layer/automation/tenant-dek-read', () => ({
    readRulesWithTenantDek: (_tenantId: string, read: () => unknown) => read(),
}));

const prismaMock = {
    automationRule: { findMany: jest.fn(), updateMany: jest.fn() },
    automationExecution: { create: jest.fn(), updateMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

import {
    emitAutomationEvent,
    installAutomationBusDispatcher,
    resetAutomationBus,
} from '@/app-layer/automation';
import { runAutomationEventDispatch } from '@/app-layer/jobs/automation-event-dispatch';
import type { AutomationEventDispatchPayload } from '@/app-layer/jobs/types';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';

const SESSION_CTX: RequestContext = {
    requestId: 'req-1',
    userId: 'actor-1',
    tenantId: 'tenant-A',
    role: 'EDITOR',
    permissions: computePermissions('EDITOR'),
    appPermissions: getPermissionsForRole('EDITOR'),
};
const KEY_CTX: RequestContext = { ...SESSION_CTX, apiKeyId: 'key-1', apiKeyScopes: ['risks:write'] };

const emitRiskCreated = (ctx: RequestContext) =>
    emitAutomationEvent(ctx, {
        event: 'RISK_CREATED',
        entityType: 'Risk',
        entityId: 'risk-1',
        actorUserId: ctx.userId,
        data: { title: 't', score: 1, category: null },
    });

/** The `automation-event-dispatch` payload the bus enqueued. */
function enqueuedPayload(): AutomationEventDispatchPayload {
    const call = enqueue.mock.calls.find(([name]) => name === 'automation-event-dispatch');
    if (!call) throw new Error('automation-event-dispatch was never enqueued');
    // Through JSON, as Redis returns it to the worker.
    return JSON.parse(JSON.stringify(call[1])) as AutomationEventDispatchPayload;
}

beforeEach(() => {
    jest.clearAllMocks();
    resetAutomationBus();
    installAutomationBusDispatcher();
    enqueue.mockResolvedValue({ id: 'job-1' });
    prismaMock.automationRule.findMany.mockResolvedValue([
        {
            id: 'rule-1',
            tenantId: 'tenant-A',
            triggerFilterJson: null,
            actionType: 'CREATE_TASK',
            actionConfigJson: {},
            createdByUserId: null,
            nextRuleId: null,
        },
    ]);
    prismaMock.automationRule.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.automationExecution.create.mockResolvedValue({ id: 'exec-1' });
    prismaMock.automationExecution.updateMany.mockResolvedValue({ count: 1 });
    executeActionMock.mockResolvedValue({ ok: true, summary: 'done' });
});

describe('an event a key request emitted carries the key to the executor', () => {
    it('bus → queued payload → dispatcher → executeAction', async () => {
        await emitRiskCreated(KEY_CTX);
        const payload = enqueuedPayload();
        expect(payload.event).toMatchObject({ actorUserId: 'actor-1', actorApiKeyId: 'key-1' });

        await runAutomationEventDispatch(payload);

        expect(executeActionMock).toHaveBeenCalledTimes(1);
        expect(executeActionMock.mock.calls[0][2]).toMatchObject({
            tenantId: 'tenant-A',
            actorUserId: 'actor-1',
            actorApiKeyId: 'key-1',
        });
    });

    it('a producer cannot name a key the request was not made with: the bus stamps it from the context', async () => {
        await emitAutomationEvent(SESSION_CTX, {
            event: 'RISK_CREATED',
            entityType: 'Risk',
            entityId: 'risk-1',
            actorUserId: 'actor-1',
            // Not in `EmitAutomationEvent`, so only an untyped producer could
            // try it.
            ...({ actorApiKeyId: 'forged' } as object),
            data: { title: 't', score: 1, category: null },
        } as Parameters<typeof emitAutomationEvent>[1]);
        expect(enqueuedPayload().event).not.toHaveProperty('actorApiKeyId');

        enqueue.mockClear();
        await emitAutomationEvent(KEY_CTX, {
            event: 'RISK_CREATED',
            entityType: 'Risk',
            entityId: 'risk-1',
            actorUserId: 'actor-1',
            ...({ actorApiKeyId: 'forged' } as object),
            data: { title: 't', score: 1, category: null },
        } as Parameters<typeof emitAutomationEvent>[1]);
        expect(enqueuedPayload().event.actorApiKeyId).toBe('key-1');
    });
});

describe('an event with no key crosses every hop as it always did', () => {
    it('a session\'s event has no actorApiKeyId member, on the payload or at the executor', async () => {
        await emitRiskCreated(SESSION_CTX);
        const payload = enqueuedPayload();
        expect(payload.event).not.toHaveProperty('actorApiKeyId');

        await runAutomationEventDispatch(payload);

        expect(executeActionMock.mock.calls[0][2]).not.toHaveProperty('actorApiKeyId');
        expect(executeActionMock.mock.calls[0][2]).toMatchObject({ actorUserId: 'actor-1' });
    });

    it('a payload queued before the field existed reaches the executor unchanged', async () => {
        const queuedBefore: AutomationEventDispatchPayload = {
            tenantId: 'tenant-A',
            event: {
                event: 'RISK_CREATED',
                tenantId: 'tenant-A',
                entityType: 'Risk',
                entityId: 'risk-1',
                actorUserId: 'actor-1',
                emittedAt: '2026-10-25T10:00:00.000Z',
                stableKey: 'risk-1',
                data: {},
            },
        };

        await runAutomationEventDispatch(queuedBefore);

        expect(executeActionMock.mock.calls[0][2]).toEqual({
            tenantId: 'tenant-A',
            event: 'RISK_CREATED',
            entityType: 'Risk',
            entityId: 'risk-1',
            actorUserId: 'actor-1',
            data: {},
        });
    });
});
