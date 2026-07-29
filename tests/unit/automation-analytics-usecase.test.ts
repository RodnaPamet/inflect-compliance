/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Unit tests for getAutomationAnalytics (Automation Epic 9) — aggregation
 * correctness over a mixed success/failure execution set.
 */

const mockDb = {
    automationRule: { count: jest.fn(), findMany: jest.fn() },
    automationExecution: { findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));
jest.mock('@/app-layer/automation', () => ({
    assertCanReadAutomation: (ctx: any) => {
        if (!ctx.permissions.canRead) throw new Error('forbidden:read');
    },
}));

import { getAutomationAnalytics } from '@/app-layer/usecases/automation-analytics';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => jest.clearAllMocks());

describe('getAutomationAnalytics', () => {
    function primeRules(total = 5, enabled = 3) {
        mockDb.automationRule.count
            .mockResolvedValueOnce(total)
            .mockResolvedValueOnce(enabled);
        mockDb.automationRule.findMany.mockResolvedValue([
            { id: 'r1', name: 'Rule One' },
            { id: 'r2', name: 'Rule Two' },
        ]);
    }
    const run = (over: Record<string, unknown>) => ({
        ruleId: 'r1',
        status: 'SUCCEEDED',
        durationMs: 100,
        outcomeJson: null,
        createdAt: new Date('2026-06-01T10:00:00Z'),
        ...over,
    });

    it('aggregates counts, daily buckets, top rules and durations', async () => {
        primeRules();
        mockDb.automationExecution.findMany.mockResolvedValue([
            run({ status: 'SUCCEEDED', durationMs: 100 }),
            run({ status: 'FAILED', durationMs: 200, createdAt: new Date('2026-06-01T11:00:00Z') }),
            run({ ruleId: 'r2', durationMs: 300, createdAt: new Date('2026-06-02T09:00:00Z') }),
        ]);

        const out = await getAutomationAnalytics(makeRequestContext('ADMIN'), 30);

        expect(out.totalRules).toBe(5);
        expect(out.enabledRules).toBe(3);
        expect(out.totalExecutions).toBe(3);
        expect(out.executions).toHaveLength(2);
        expect(out.executions[0].date).toBe('2026-06-01');
        expect(out.executions[0].succeeded + out.executions[0].failed).toBe(2);
        expect(out.topRules[0].ruleId).toBe('r1');
        expect(out.topRules[0].count).toBe(2);
        expect(out.avgDurationMs).toBe(200);
    });

    describe('rates use a TERMINAL denominator', () => {
        it('a SKIPPED run is neither a success nor a failure', async () => {
            // The bug: SKIPPED counted in the denominator, so a rule whose
            // conditions never matched read as a success.
            primeRules();
            mockDb.automationExecution.findMany.mockResolvedValue([
                run({ status: 'SUCCEEDED' }),
                run({ status: 'FAILED' }),
                run({ status: 'SKIPPED' }),
                run({ status: 'SKIPPED' }),
            ]);

            const out = await getAutomationAnalytics(makeRequestContext('ADMIN'), 30);

            expect(out.totalExecutions).toBe(4);
            expect(out.terminalExecutions).toBe(2);
            expect(out.successRate).toBe(50);
            expect(out.errorRate).toBe(50);
        });

        it('successRate and errorRate are exact complements', async () => {
            // The client used to render `100 - errorRate` as the success rate,
            // which was only ever true by coincidence of the denominators.
            primeRules();
            mockDb.automationExecution.findMany.mockResolvedValue([
                run({ status: 'SUCCEEDED' }),
                run({ status: 'SUCCEEDED' }),
                run({ status: 'FAILED' }),
                run({ status: 'PENDING' }),
            ]);

            const out = await getAutomationAnalytics(makeRequestContext('ADMIN'), 30);
            expect(out.successRate + out.errorRate).toBe(100);
        });

        it('topRules uses the SAME denominator as the headline', async () => {
            // A rule could read 100% under "Most-fired" (succeeded/count) while
            // the headline disagreed on the very same executions.
            primeRules();
            mockDb.automationExecution.findMany.mockResolvedValue([
                run({ ruleId: 'r1', status: 'SUCCEEDED' }),
                run({ ruleId: 'r1', status: 'SKIPPED' }),
                run({ ruleId: 'r1', status: 'SKIPPED' }),
            ]);

            const out = await getAutomationAnalytics(makeRequestContext('ADMIN'), 30);
            expect(out.topRules[0].count).toBe(3);
            expect(out.topRules[0].successRate).toBe(100);
            expect(out.topRules[0].successRate).toBe(out.successRate);
        });

        it('reports 0% rather than dividing by zero when nothing terminated', async () => {
            primeRules();
            mockDb.automationExecution.findMany.mockResolvedValue([
                run({ status: 'SKIPPED' }),
                run({ status: 'PENDING' }),
            ]);

            const out = await getAutomationAnalytics(makeRequestContext('ADMIN'), 30);
            expect(out.successRate).toBe(0);
            expect(out.errorRate).toBe(0);
            expect(out.topRules[0].successRate).toBe(0);
        });
    });

    describe('SLA breaches come from structured outcome, not error text', () => {
        it('counts an execution whose outcomeJson.slaBreached is true', async () => {
            primeRules();
            mockDb.automationExecution.findMany.mockResolvedValue([
                run({ status: 'FAILED', outcomeJson: { slaBreached: true, slaWindowMinutes: 60 } }),
                run({ status: 'FAILED', outcomeJson: { slaBreached: false } }),
            ]);

            const out = await getAutomationAnalytics(makeRequestContext('ADMIN'), 30);
            expect(out.slaBreaches).toBe(1);
        });

        it('does NOT count an unrelated failure that merely mentions the phrase', async () => {
            // The old `errorMessage?.includes('SLA window')` match: a reworded
            // message zeroed the KPI, and any error quoting the phrase inflated it.
            primeRules();
            mockDb.automationExecution.findMany.mockResolvedValue([
                run({
                    status: 'FAILED',
                    errorMessage: 'webhook rejected: SLA window config invalid',
                    outcomeJson: null,
                }),
            ]);

            const out = await getAutomationAnalytics(makeRequestContext('ADMIN'), 30);
            expect(out.slaBreaches).toBe(0);
        });

        it('selects outcomeJson from the database, not errorMessage', async () => {
            primeRules();
            mockDb.automationExecution.findMany.mockResolvedValue([]);
            await getAutomationAnalytics(makeRequestContext('ADMIN'), 30);
            const select = mockDb.automationExecution.findMany.mock.calls[0][0].select;
            expect(select.outcomeJson).toBe(true);
            expect(select.errorMessage).toBeUndefined();
        });
    });

    it('flags truncation so the client can say the figures are a lower bound', async () => {
        primeRules();
        // MAX_ROWS + 1 rows come back; the extra one is the sentinel.
        mockDb.automationExecution.findMany.mockResolvedValue(
            Array.from({ length: 5001 }, () => run({})),
        );
        const out = await getAutomationAnalytics(makeRequestContext('ADMIN'), 30);
        expect(out.truncated).toBe(true);
        expect(out.totalExecutions).toBe(5000);
    });

    it('rejects a caller without read', async () => {
        const ctx = makeRequestContext('READER', { permissions: { canRead: false } as any });
        await expect(getAutomationAnalytics(ctx)).rejects.toThrow('forbidden:read');
    });
});
