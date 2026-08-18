/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Action Execution Engine — proves each action type produces a REAL side
 * effect (the gap this PR closes: the engine used to record intent and do
 * nothing).
 */
const enqueueMock = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: (...a: unknown[]) => enqueueMock(...a) }));
// webhook-safety's safeFetch resolves via `node:dns` promises with { all: true },
// so the mock returns the address-LIST form.
const lookupMock = jest.fn((..._a: unknown[]) =>
    Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
);
jest.mock('node:dns', () => ({ promises: { lookup: (...a: unknown[]) => lookupMock(...a) } }));

// `safeFetch` calls undici's own fetch, not the global one — pairing an
// npm-undici dispatcher with Node's bundled undici breaks on undici 8 (see
// tests/unit/webhook-safety-dispatcher-egress.test.ts). Stubbing `global.fetch`
// here would silently stop intercepting and let the webhook action attempt a
// real outbound request. `Agent` stays real so the pinned dispatcher is still
// constructed exactly as in production.
const undiciFetchMock = jest.fn();
jest.mock('undici', () => ({
    ...jest.requireActual('undici'),
    fetch: (...a: unknown[]) => undiciFetchMock(...a),
}));
// CREATE_TASK now delegates to the canonical createTask usecase (TP-1) so
// the spawned task carries a TSK-N key + audit + automation event + bell.
// Mock it to assert the executor calls it with the right shape.
const createTaskMock = jest.fn().mockResolvedValue({ id: 'task-1', key: 'TSK-1' });
// UPDATE_STATUS likewise delegates (B2-1b) — each target goes through the
// usecase that owns its gates instead of a raw `updateMany`, which skipped
// the transition gate, the four-eyes reviewer gate, the audit row and the
// source reconciler. The gates are proven for real in
// tests/integration/automation-update-status-gates.test.ts.
const setTaskStatusMock = jest.fn().mockResolvedValue({ id: 'task-1' });
jest.mock('@/app-layer/usecases/task', () => ({
    createTask: (...a: unknown[]) => createTaskMock(...a),
    setTaskStatus: (...a: unknown[]) => setTaskStatusMock(...a),
}));
const setControlStatusMock = jest.fn().mockResolvedValue({ id: 'control-1' });
jest.mock('@/app-layer/usecases/control/mutations', () => ({
    setControlStatus: (...a: unknown[]) => setControlStatusMock(...a),
}));
const bulkSetRiskStatusMock = jest.fn().mockResolvedValue({ updated: 1 });
jest.mock('@/app-layer/usecases/risk', () => ({
    bulkSetRiskStatus: (...a: unknown[]) => bulkSetRiskStatusMock(...a),
}));

import { executeAction } from '@/app-layer/automation/action-executor';

const baseEvent = {
    tenantId: 't1',
    event: 'RISK_CREATED',
    entityType: 'Risk',
    entityId: 'risk-1',
    actorUserId: 'u1',
    data: { riskId: 'risk-1' },
};

function makeDb() {
    return {
        // membership filter: echo back whatever userIds were requested as members
        tenantMembership: {
            findMany: jest.fn(async (args: any) =>
                (args.where.userId.in as string[]).map((userId: string) => ({ userId })),
            ),
            // CREATE_TASK resolves the principal's REAL role from the
            // membership row before it will run the action.
            findUnique: jest.fn().mockResolvedValue({
                role: 'ADMIN',
                status: 'ACTIVE',
                customRole: null,
                tenant: { slug: 't1-slug' },
            }),
        },
        tenantNotificationSettings: { findUnique: jest.fn().mockResolvedValue({ enabled: true }) },
        notification: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
        task: {
            create: jest.fn().mockResolvedValue({ id: 'task-1' }),
            findFirst: jest.fn().mockResolvedValue(null),
        },
        risk: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    } as any;
}

beforeEach(() => {
    jest.clearAllMocks();
    undiciFetchMock.mockResolvedValue({ ok: true, status: 200 });
});

describe('executeAction', () => {
    it('NOTIFY_USER creates a notification row per recipient', async () => {
        const db = makeDb();
        const res = await executeAction(db, {
            id: 'r1', name: 'Alert', actionType: 'NOTIFY_USER', createdByUserId: 'u1',
            actionConfigJson: { userIds: ['a', 'b'], message: 'heads up' },
        }, baseEvent);
        expect(res.ok).toBe(true);
        const arg = db.notification.createMany.mock.calls[0][0];
        expect(arg.data).toHaveLength(2);
        expect(arg.data[0]).toMatchObject({ tenantId: 't1', userId: 'a', message: 'heads up' });
    });

    it('CREATE_TASK delegates to the canonical createTask, owned by the rule author', async () => {
        const db = makeDb();
        const res = await executeAction(db, {
            id: 'r1', name: 'Remediate', actionType: 'CREATE_TASK', createdByUserId: 'u9',
            actionConfigJson: { title: 'Fix it', severity: 'HIGH' },
        }, baseEvent);
        expect(res.ok).toBe(true);
        // The canonical createTask returns a TSK-N key that now surfaces.
        expect(res.detail).toEqual({ taskId: 'task-1', key: 'TSK-1' });
        // Routed through the usecase (NOT a raw db.task.create) with a
        // valid source + the RULE AUTHOR (u9), not the firing member (u1),
        // owning the task and supplying the authority.
        expect(db.task.create).not.toHaveBeenCalled();
        const [ctxArg, inputArg] = createTaskMock.mock.calls[0];
        expect(ctxArg).toMatchObject({ tenantId: 't1', userId: 'u9' });
        expect(inputArg).toMatchObject({ title: 'Fix it', severity: 'HIGH', source: 'INTEGRATION' });
        expect(inputArg.metadataJson).toMatchObject({ automationDedupeKey: 'auto:r1:risk-1', ruleId: 'r1' });
    });

    it('UPDATE_STATUS moves the event entity through its canonical usecase', async () => {
        const db = makeDb();
        const res = await executeAction(db, {
            id: 'r1', name: 'Close', actionType: 'UPDATE_STATUS', createdByUserId: 'u1',
            actionConfigJson: { entityType: 'Risk', field: 'status', toStatus: 'MITIGATED' },
        }, baseEvent);
        expect(res.ok).toBe(true);
        expect(bulkSetRiskStatusMock).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 't1', userId: 'u1' }),
            ['risk-1'],
            'MITIGATED',
        );
        // The raw-table write is the bug, not an implementation detail.
        expect(db.risk.updateMany).not.toHaveBeenCalled();
    });

    it('WEBHOOK fires a real signed HTTP POST', async () => {
        const db = makeDb();
        const res = await executeAction(db, {
            id: 'r1', name: 'Push', actionType: 'WEBHOOK', createdByUserId: 'u1',
            actionConfigJson: { url: 'https://example.com/hook', secretRef: 'shh' },
        }, baseEvent);
        expect(res.ok).toBe(true);
        expect(undiciFetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = undiciFetchMock.mock.calls[0];
        expect(url).toBe('https://example.com/hook');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Inflect-Signature']).toMatch(/^sha256=/);
    });

    it('INVOKE_SUBFLOW enqueues the sub-flow dispatch', async () => {
        const db = makeDb();
        const res = await executeAction(db, {
            id: 'r1', name: 'Branch', actionType: 'INVOKE_SUBFLOW', createdByUserId: 'u1',
            actionConfigJson: { targetGroupId: 'g1' },
        }, baseEvent);
        expect(res.ok).toBe(true);
        expect(enqueueMock).toHaveBeenCalledWith('subflow-dispatch', expect.objectContaining({ targetGroupId: 'g1' }));
    });

    it('returns ok:false (never throws) when a handler errors', async () => {
        const db = makeDb();
        db.notification.createMany.mockRejectedValue(new Error('db down'));
        const res = await executeAction(db, {
            id: 'r1', name: 'Alert', actionType: 'NOTIFY_USER', createdByUserId: 'u1',
            actionConfigJson: { userIds: ['a'], message: 'x' },
        }, baseEvent);
        expect(res.ok).toBe(false);
        expect(res.summary).toMatch(/failed/i);
    });
});

describe('PR-D hardening guards', () => {
    const ruleOf = (actionType: string, actionConfigJson: unknown) => ({
        id: 'r1', name: 'R', actionType, createdByUserId: 'u1', actionConfigJson,
    });

    it('UPDATE_STATUS rejects a non-status field', async () => {
        const db = makeDb();
        const res = await executeAction(db, ruleOf('UPDATE_STATUS', {
            entityType: 'Risk', field: 'treatmentNotes', toStatus: 'pwned',
        }), baseEvent);
        expect(res.ok).toBe(false);
        expect(db.risk.updateMany).not.toHaveBeenCalled();
    });

    it('UPDATE_STATUS rejects an illegal target status', async () => {
        const db = makeDb();
        const res = await executeAction(db, ruleOf('UPDATE_STATUS', {
            entityType: 'Risk', field: 'status', toStatus: 'banana',
        }), baseEvent);
        expect(res.ok).toBe(false);
        expect(res.summary).toMatch(/illegal/i);
        expect(db.risk.updateMany).not.toHaveBeenCalled();
    });

    it('WEBHOOK blocks a non-https URL (no fetch)', async () => {
        const db = makeDb();
        const res = await executeAction(db, ruleOf('WEBHOOK', { url: 'http://example.com/h' }), baseEvent);
        expect(res.ok).toBe(false);
        expect(undiciFetchMock).not.toHaveBeenCalled();
    });

    it('WEBHOOK blocks a host that resolves to a private IP (no fetch)', async () => {
        const db = makeDb();
        lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
        const res = await executeAction(db, ruleOf('WEBHOOK', { url: 'https://evil.example.com/h' }), baseEvent);
        expect(res.ok).toBe(false);
        expect(res.summary).toMatch(/private/i);
        expect(undiciFetchMock).not.toHaveBeenCalled();
    });

    it('CREATE_TASK dedupes against an existing open task', async () => {
        const db = makeDb();
        db.task.findFirst.mockResolvedValue({ id: 'existing-task' });
        const res = await executeAction(db, ruleOf('CREATE_TASK', { title: 'X' }), baseEvent);
        expect(res.ok).toBe(true);
        expect(res.detail).toMatchObject({ deduped: true });
        expect(db.task.create).not.toHaveBeenCalled();
    });

    it('NOTIFY_USER is suppressed when the tenant disables notifications', async () => {
        const db = makeDb();
        db.tenantNotificationSettings.findUnique.mockResolvedValue({ enabled: false });
        const res = await executeAction(db, ruleOf('NOTIFY_USER', { userIds: ['a'], message: 'x' }), baseEvent);
        expect(res.ok).toBe(true);
        expect(db.notification.createMany).not.toHaveBeenCalled();
    });
});
