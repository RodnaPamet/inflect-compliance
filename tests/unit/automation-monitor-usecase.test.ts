/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Unit tests for the live-monitor usecases (Automation Epic 10):
 * listLiveExecutions, cancelExecution, dryRunRule.
 */

const mockDb = {
    automationExecution: { findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/automation', () => ({
    AutomationRuleRepository: { getById: jest.fn() },
    AutomationExecutionRepository: {
        getById: jest.fn(),
        recordCompletion: jest.fn(),
        listForRule: jest.fn(),
        listForRulePaginated: jest.fn(),
    },
    assertCanReadAutomationHistory: (ctx: any) => {
        if (!ctx.permissions.canRead && !ctx.permissions.canAudit) throw new Error('forbidden:history');
    },
    assertCanExecuteAutomation: (ctx: any) => {
        if (!ctx.permissions.canWrite) throw new Error('forbidden:execute');
    },
    matchesFilter: jest.fn(),
}));

jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));

import {
    listLiveExecutions,
    cancelExecution,
    dryRunRule,
    DEFAULT_STUCK_AFTER_MINUTES,
} from '@/app-layer/usecases/automation-executions';
import {
    AutomationRuleRepository,
    AutomationExecutionRepository,
    matchesFilter,
} from '@/app-layer/automation';
import { makeRequestContext } from '../helpers/make-context';

const ruleRepo = AutomationRuleRepository as jest.Mocked<typeof AutomationRuleRepository>;
const execRepo = AutomationExecutionRepository as jest.Mocked<typeof AutomationExecutionRepository>;
const matches = matchesFilter as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('listLiveExecutions — the stuck feed', () => {
    const NOW = new Date('2026-07-29T12:00:00Z');
    const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

    function exec(over: Record<string, unknown>) {
        return {
            id: 'e1',
            ruleId: 'r1',
            triggerEvent: 'RISK_CREATED',
            status: 'RUNNING',
            triggeredBy: 'event',
            startedAt: null,
            createdAt: NOW,
            rule: { name: 'R1', slaWindowMinutes: null },
            ...over,
        };
    }
    /** first findMany = the RUNNING page, second = the recent tail */
    function primeDb(running: unknown[], recent: unknown[] = []) {
        mockDb.automationExecution.findMany
            .mockResolvedValueOnce(running)
            .mockResolvedValueOnce(recent);
    }

    it('does NOT report a healthy in-flight execution as stuck', async () => {
        // The whole bug: the query had no timeout predicate, so the console
        // badged every RUNNING row "Stuck" and offered to cancel it.
        primeDb([exec({ createdAt: minsAgo(1) })]);
        const out = await listLiveExecutions(makeRequestContext('ADMIN'), NOW);
        expect(out.stuck).toHaveLength(0);
    });

    it('reports one past the default window when its rule declares none', async () => {
        // Rules without an slaWindowMinutes are never swept by sla-monitor, so
        // these are exactly the rows that hang forever.
        primeDb([exec({ createdAt: minsAgo(DEFAULT_STUCK_AFTER_MINUTES + 1) })]);
        const out = await listLiveExecutions(makeRequestContext('ADMIN'), NOW);
        expect(out.stuck).toHaveLength(1);
        expect(out.stuck[0].ruleName).toBe('R1');
    });

    it("honours the rule's own window over the default, in both directions", async () => {
        primeDb([
            // 5m window, running 6m → stuck, even though under the 15m default
            exec({ id: 'tight', createdAt: minsAgo(6), rule: { name: 'Tight', slaWindowMinutes: 5 } }),
            // 60m window, running 20m → healthy, even though over the default
            exec({ id: 'loose', createdAt: minsAgo(20), rule: { name: 'Loose', slaWindowMinutes: 60 } }),
        ]);
        const out = await listLiveExecutions(makeRequestContext('ADMIN'), NOW);
        expect(out.stuck.map((e) => e.id)).toEqual(['tight']);
    });

    it('measures from startedAt when present, not createdAt', async () => {
        // A queued-then-started execution must not be called stuck for time it
        // spent waiting in the queue.
        primeDb([exec({ createdAt: minsAgo(60), startedAt: minsAgo(2) })]);
        const out = await listLiveExecutions(makeRequestContext('ADMIN'), NOW);
        expect(out.stuck).toHaveLength(0);
    });

    it('reads the RUNNING page oldest-first so stuck rows are not paged out', async () => {
        primeDb([]);
        await listLiveExecutions(makeRequestContext('ADMIN'), NOW);
        const arg = mockDb.automationExecution.findMany.mock.calls[0][0];
        expect(arg.orderBy).toEqual({ createdAt: 'asc' });
        expect(arg.where).toMatchObject({ status: 'RUNNING' });
    });

    it('still returns the recent tail untouched', async () => {
        primeDb([], [exec({ id: 'r-1', status: 'SUCCEEDED' })]);
        const out = await listLiveExecutions(makeRequestContext('ADMIN'), NOW);
        expect(out.recent).toHaveLength(1);
        expect(out.recent[0].ruleName).toBe('R1');
    });
});

describe('cancelExecution', () => {
    it('marks an in-flight execution SKIPPED', async () => {
        execRepo.getById.mockResolvedValue({ id: 'e1', status: 'RUNNING' } as any);
        const ctx = makeRequestContext('EDITOR');
        await cancelExecution(ctx, 'e1');
        expect(execRepo.recordCompletion).toHaveBeenCalledWith(
            mockDb,
            expect.anything(),
            'e1',
            expect.objectContaining({ status: 'SKIPPED' }),
        );
    });

    it('refuses to cancel a finished execution', async () => {
        execRepo.getById.mockResolvedValue({ id: 'e1', status: 'SUCCEEDED' } as any);
        const ctx = makeRequestContext('EDITOR');
        await expect(cancelExecution(ctx, 'e1')).rejects.toThrow(/in-flight/i);
        expect(execRepo.recordCompletion).not.toHaveBeenCalled();
    });
});

describe('dryRunRule', () => {
    it('evaluates the filter without creating an execution', async () => {
        ruleRepo.getById.mockResolvedValue({ id: 'r1', triggerEvent: 'RISK_CREATED', triggerFilterJson: null } as any);
        execRepo.listForRule.mockResolvedValue([{ triggerPayloadJson: { severity: 'HIGH' } }] as any);
        matches.mockReturnValue(true);
        const ctx = makeRequestContext('EDITOR');
        const out = await dryRunRule(ctx, 'r1');
        expect(out.matches).toBe(true);
        expect(out.triggerEvent).toBe('RISK_CREATED');
        expect(matches).toHaveBeenCalled();
    });
});
