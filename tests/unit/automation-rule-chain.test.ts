/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Unit tests for the chained-rule workflow (Automation Epic 7):
 * the pure cycle-detection helper + the rule-chain-dispatch job.
 */

// ─── Pure cycle guard ───
import { followChainHasCycle } from '@/app-layer/usecases/automation-rules';

describe('followChainHasCycle', () => {
    const chain: Record<string, string | null> = { b: 'c', c: null };
    const nextOf = (id: string) => chain[id] ?? null;

    it('returns false for an acyclic chain', () => {
        expect(followChainHasCycle('a', 'b', nextOf)).toBe(false);
    });

    it('detects a chain that loops back to the edited rule', () => {
        const loop: Record<string, string | null> = { b: 'c', c: 'a' };
        expect(followChainHasCycle('a', 'b', (id) => loop[id] ?? null)).toBe(true);
    });

    it('detects a pre-existing cycle among other rules', () => {
        const loop: Record<string, string | null> = { b: 'c', c: 'b' };
        expect(followChainHasCycle('a', 'b', (id) => loop[id] ?? null)).toBe(true);
    });
});

// ─── Chain dispatch job ───
jest.mock('@/lib/prisma', () => ({
    prisma: {
        automationRule: { findFirst: jest.fn(), updateMany: jest.fn() },
        automationExecution: { create: jest.fn(), updateMany: jest.fn() },
    },
}));
jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_n: string, fn: () => any) => fn()),
}));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));

import { runRuleChainDispatch } from '@/app-layer/jobs/rule-chain-dispatch';
import { prisma } from '@/lib/prisma';
import { enqueue } from '@/app-layer/jobs/queue';

const mockPrisma = prisma as any;
const enqueueMock = enqueue as jest.Mock;

beforeEach(() => jest.clearAllMocks());

const basePayload = {
    tenantId: 't1',
    ruleId: 'r2',
    parentExecutionId: 'exec-1',
    triggerEvent: 'RISK_CREATED',
    data: { severity: 'HIGH' },
    depth: 1,
};

describe('runRuleChainDispatch', () => {
    it('creates a chained execution with parent lineage', async () => {
        mockPrisma.automationRule.findFirst.mockResolvedValue({
            id: 'r2',
            actionType: 'NOTIFY_USER',
            nextRuleId: null,
        });
        mockPrisma.automationExecution.create.mockResolvedValue({ id: 'exec-2' });

        const { executionId } = await runRuleChainDispatch(basePayload);

        expect(executionId).toBe('exec-2');
        // Claimed RUNNING first, under the step's key (#5103)…
        const createArg = mockPrisma.automationExecution.create.mock.calls[0][0];
        expect(createArg.data).toMatchObject({
            ruleId: 'r2',
            parentExecutionId: 'exec-1',
            triggeredBy: 'chain',
            status: 'RUNNING',
            idempotencyKey: 'chain:exec-1:r2',
        });
        // …then settled from RUNNING.
        const settle = mockPrisma.automationExecution.updateMany.mock.calls[0][0];
        expect(settle.where).toMatchObject({ id: 'exec-2', status: 'RUNNING' });
        expect(settle.data.status).toBe('SUCCEEDED');
        expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('chains onward when the rule has a nextRuleId', async () => {
        mockPrisma.automationRule.findFirst.mockResolvedValue({
            id: 'r2',
            actionType: 'NOTIFY_USER',
            nextRuleId: 'r3',
            nextRuleDelay: 5,
        });
        mockPrisma.automationExecution.create.mockResolvedValue({ id: 'exec-2' });

        await runRuleChainDispatch(basePayload);

        expect(enqueueMock).toHaveBeenCalledWith(
            'rule-chain-dispatch',
            expect.objectContaining({ ruleId: 'r3', parentExecutionId: 'exec-2', depth: 2 }),
            { delay: 5 * 60_000 },
        );
    });

    it('caps runaway depth (cycle backstop) — no execution created', async () => {
        const { executionId } = await runRuleChainDispatch({ ...basePayload, depth: 99 });
        expect(executionId).toBeNull();
        expect(mockPrisma.automationExecution.create).not.toHaveBeenCalled();
    });

    it('a retried step that finds its claim taken does NOT run the action again (#5103)', async () => {
        // The step used to act and THEN write its row, so a BullMQ retry after
        // the action ran it twice: a second task, a second webhook.
        mockPrisma.automationRule.findFirst.mockResolvedValue({
            id: 'r2',
            actionType: 'NOTIFY_USER',
            nextRuleId: 'r3',
        });
        const { Prisma } = jest.requireActual('@prisma/client');
        mockPrisma.automationExecution.create.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
                code: 'P2002',
                clientVersion: 'test',
            }),
        );

        const { executionId, result } = await runRuleChainDispatch(basePayload);

        expect(executionId).toBeNull();
        expect(result.details).toMatchObject({ skipped: 'already-claimed' });
        expect(mockPrisma.automationExecution.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.automationRule.updateMany).not.toHaveBeenCalled();
        // And it does not chain onward a second time either.
        expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('carries the entity the chain started from to the next link (#5248)', async () => {
        mockPrisma.automationRule.findFirst.mockResolvedValue({
            id: 'r2',
            actionType: 'NOTIFY_USER',
            nextRuleId: 'r3',
        });
        mockPrisma.automationExecution.create.mockResolvedValue({ id: 'exec-2' });

        await runRuleChainDispatch({ ...basePayload, entityType: 'Risk', entityId: 'risk-7' });

        expect(enqueueMock).toHaveBeenCalledWith(
            'rule-chain-dispatch',
            expect.objectContaining({ entityType: 'Risk', entityId: 'risk-7' }),
            undefined,
        );
    });

    // ─── PR-F conditional branching ───
    it('PASS branch: matching filter runs the action + follows nextRuleId', async () => {
        mockPrisma.automationRule.findFirst.mockResolvedValue({
            id: 'r2', actionType: 'NOTIFY_USER',
            triggerFilterJson: { severity: 'HIGH' }, // matches basePayload.data
            nextRuleId: 'r-pass', elseRuleId: 'r-else',
        });
        mockPrisma.automationExecution.create.mockResolvedValue({ id: 'exec-2' });

        await runRuleChainDispatch(basePayload);

        const settle = mockPrisma.automationExecution.updateMany.mock.calls[0][0];
        expect(settle.data.status).toBe('SUCCEEDED');
        expect(settle.data.outcomeJson.branch).toBe('pass');
        expect(enqueueMock).toHaveBeenCalledWith(
            'rule-chain-dispatch',
            expect.objectContaining({ ruleId: 'r-pass' }),
            undefined,
        );
    });

    it('ELSE branch: non-matching filter skips the action + follows elseRuleId', async () => {
        mockPrisma.automationRule.findFirst.mockResolvedValue({
            id: 'r2', actionType: 'NOTIFY_USER',
            triggerFilterJson: { severity: 'CRITICAL' }, // does NOT match HIGH
            nextRuleId: 'r-pass', elseRuleId: 'r-else',
        });
        mockPrisma.automationExecution.create.mockResolvedValue({ id: 'exec-2' });

        await runRuleChainDispatch(basePayload);

        const settle = mockPrisma.automationExecution.updateMany.mock.calls[0][0];
        expect(settle.data.status).toBe('SKIPPED');
        expect(settle.data.outcomeJson.branch).toBe('else');
        // action skipped → rule counter not bumped
        expect(mockPrisma.automationRule.updateMany).not.toHaveBeenCalled();
        expect(enqueueMock).toHaveBeenCalledWith(
            'rule-chain-dispatch',
            expect.objectContaining({ ruleId: 'r-else' }),
            undefined,
        );
    });
});
