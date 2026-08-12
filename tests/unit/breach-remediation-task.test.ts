/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * RQ2-6 — createBreachRemediationTask suite.
 *
 * Locks the contract: one task per breach (conditional-update
 * claim), task content derives server-side from the breach row,
 * risk-attributed breaches get a RISK TaskLink, and resolved /
 * missing breaches refuse cleanly.
 */

const mockDb = {
    riskAppetiteBreach: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
    },
    // RQ3-OB-A — the task title speaks the tenant's currency.
    tenant: {
        findUnique: jest.fn().mockResolvedValue({ currencySymbol: '€' }),
    },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/app-layer/usecases/task', () => ({
    createTask: jest.fn(),
    addTaskLink: jest.fn(),
}));

import { createBreachRemediationTask } from '@/app-layer/usecases/risk-appetite';
import { createTask, addTaskLink } from '@/app-layer/usecases/task';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../helpers/make-context';

const editorCtx = makeRequestContext('EDITOR');

const breach = (over: any = {}) => ({
    id: 'br-1',
    tenantId: editorCtx.tenantId,
    breachType: 'SINGLE_RISK_ALE',
    riskId: 'r-1',
    category: null,
    thresholdValue: 500_000,
    actualValue: 1_200_000,
    detectedAt: new Date('2026-06-01T00:00:00Z'),
    resolvedAt: null,
    remediationTaskId: null,
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    (createTask as jest.Mock).mockResolvedValue({ id: 'task-1' });
    (mockDb.riskAppetiteBreach.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
});

describe('createBreachRemediationTask', () => {
    it('creates a P1 task with breach-derived content and links the risk', async () => {
        (mockDb.riskAppetiteBreach.findFirst as jest.Mock).mockResolvedValue(breach());

        const result = await createBreachRemediationTask(editorCtx, 'br-1');

        expect(result).toEqual({ taskId: 'task-1', created: true });
        const input = (createTask as jest.Mock).mock.calls[0][1];
        // P1 (a valid TaskPriority) — was 'HIGH', which is a severity,
        // not a priority; the invalid-source 500 used to mask that bug.
        expect(input.priority).toBe('P1');
        // RISK_MONITOR — was the invalid free string 'risk_appetite_breach'.
        expect(input.source).toBe('RISK_MONITOR');
        expect(input.title).toMatch(/€1\.2M/);
        expect(input.title).toMatch(/€500K per-risk cap/);
        expect(addTaskLink).toHaveBeenCalledWith(editorCtx, 'task-1', 'RISK', 'r-1');
        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(),
            editorCtx,
            expect.objectContaining({ action: 'BREACH_REMEDIATION_TASK_CREATED' }),
        );
    });

    it('portfolio breaches produce an unlinked task', async () => {
        (mockDb.riskAppetiteBreach.findFirst as jest.Mock).mockResolvedValue(
            breach({ breachType: 'PORTFOLIO_ALE', riskId: null, thresholdValue: 2_000_000, actualValue: 3_000_000 }),
        );

        await createBreachRemediationTask(editorCtx, 'br-1');

        expect(addTaskLink).not.toHaveBeenCalled();
        const input = (createTask as jest.Mock).mock.calls[0][1];
        expect(input.title).toMatch(/portfolio ALE/i);
    });

    it('is idempotent — an already-claimed breach returns the existing task without creating', async () => {
        (mockDb.riskAppetiteBreach.findFirst as jest.Mock).mockResolvedValue(
            breach({ remediationTaskId: 'task-existing' }),
        );

        const result = await createBreachRemediationTask(editorCtx, 'br-1');

        expect(result).toEqual({ taskId: 'task-existing', created: false });
        expect(createTask).not.toHaveBeenCalled();
    });

    it('a lost claim race returns the winner task id, not the duplicate', async () => {
        (mockDb.riskAppetiteBreach.findFirst as jest.Mock)
            .mockResolvedValueOnce(breach()) // initial load — unclaimed
            .mockResolvedValueOnce({ remediationTaskId: 'task-winner' }); // post-race re-read
        (mockDb.riskAppetiteBreach.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

        const result = await createBreachRemediationTask(editorCtx, 'br-1');

        expect(result).toEqual({ taskId: 'task-winner', created: false });
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('rejects a resolved breach', async () => {
        (mockDb.riskAppetiteBreach.findFirst as jest.Mock).mockResolvedValue(
            breach({ resolvedAt: new Date() }),
        );
        await expect(createBreachRemediationTask(editorCtx, 'br-1')).rejects.toThrow(/already resolved/i);
        expect(createTask).not.toHaveBeenCalled();
    });

    it('throws notFound for a missing breach', async () => {
        (mockDb.riskAppetiteBreach.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(createBreachRemediationTask(editorCtx, 'ghost')).rejects.toThrow(/Breach not found/i);
    });

    it('the claim is tenant-scoped and conditional on an unclaimed row', async () => {
        (mockDb.riskAppetiteBreach.findFirst as jest.Mock).mockResolvedValue(breach());
        await createBreachRemediationTask(editorCtx, 'br-1');
        const claim = (mockDb.riskAppetiteBreach.updateMany as jest.Mock).mock.calls[0][0];
        expect(claim.where).toMatchObject({
            id: 'br-1',
            tenantId: editorCtx.tenantId,
            remediationTaskId: null,
        });
    });
});
