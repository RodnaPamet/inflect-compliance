/**
 * Coverage wave E — `src/app-layer/usecases/control/health.ts`.
 *
 * Boundary mocks only: the tenant-context runner, the policy gate, the
 * integrations read, and the effectiveness aggregate. The composite
 * verdict function (`@/lib/controls/control-health`) is deliberately NOT
 * mocked — it is pure, and asserting real verdicts is what proves the
 * usecase feeds it the right signals (evidence freshness, overdue,
 * exceptions) rather than merely calling it.
 */
import { makeRequestContext } from '../../helpers/make-context';

const assertCanReadControls = jest.fn();
jest.mock('@/app-layer/policies/control.policies', () => ({
    assertCanReadControls: (...args: unknown[]) => assertCanReadControls(...args),
}));

const db = {
    control: { findFirst: jest.fn(), findMany: jest.fn() },
    controlTestRun: { findFirst: jest.fn() },
    controlRequirementLink: { findMany: jest.fn() },
    controlException: { count: jest.fn() },
    controlEvidenceLink: { findFirst: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (d: typeof db) => unknown) => fn(db),
    ),
}));

const listExecutionsForControl = jest.fn();
jest.mock('@/app-layer/usecases/integrations', () => ({
    listExecutionsForControl: (...args: unknown[]) =>
        listExecutionsForControl(...args),
}));

const computeControlEffectivenessMap = jest.fn();
jest.mock('@/app-layer/usecases/control-test', () => ({
    computeControlEffectivenessMap: (...args: unknown[]) =>
        computeControlEffectivenessMap(...args),
}));

import {
    getControlHealth,
    getControlHealthVerdicts,
    HEALTH_VERDICT_SCAN_CAP,
} from '@/app-layer/usecases/control/health';

const ctx = makeRequestContext('ADMIN', { tenantId: 't-1' });

const DAY = 86_400_000;
const eff = (over: Record<string, unknown> = {}) => ({
    passRate: 100,
    total: 4,
    passes: 4,
    fails: 0,
    inconclusive: 0,
    ...over,
});

function primeHealthy() {
    db.control.findFirst.mockResolvedValue({
        id: 'c-1',
        status: 'IMPLEMENTED',
        applicability: 'APPLICABLE',
        lastTested: new Date('2026-06-01T00:00:00Z'),
        nextDueAt: new Date(Date.now() + 30 * DAY),
    });
    db.controlTestRun.findFirst.mockResolvedValue({
        result: 'PASS',
        executedAt: new Date('2026-06-01T00:00:00Z'),
    });
    db.controlRequirementLink.findMany.mockResolvedValue([
        { requirement: { framework: { name: 'ISO/IEC 27001' } } },
        { requirement: { framework: { name: 'SOC 2' } } },
        { requirement: { framework: { name: 'ISO/IEC 27001' } } },
    ]);
    db.controlException.count.mockResolvedValue(0);
    db.controlEvidenceLink.findFirst.mockResolvedValue({
        createdAt: new Date(Date.now() - 10 * DAY),
    });
    computeControlEffectivenessMap.mockResolvedValue(new Map([['c-1', eff()]]));
    listExecutionsForControl.mockResolvedValue([
        { status: 'PASSED', executedAt: '2026-06-20T00:00:00.000Z' },
    ]);
}

beforeEach(() => {
    jest.clearAllMocks();
    primeHealthy();
});

describe('getControlHealth', () => {
    it('enforces the controls.view gate before reading', async () => {
        await getControlHealth(ctx, 'c-1');
        expect(assertCanReadControls).toHaveBeenCalledWith(ctx);
    });

    it('throws notFound when the control does not resolve', async () => {
        db.control.findFirst.mockResolvedValue(null);
        await expect(getControlHealth(ctx, 'missing')).rejects.toThrow(
            'Control not found',
        );
    });

    it('scopes the control read to the tenant OR the global catalog', async () => {
        await getControlHealth(ctx, 'c-1');
        const where = db.control.findFirst.mock.calls[0][0].where;
        expect(where.id).toBe('c-1');
        expect(where.OR).toEqual([{ tenantId: 't-1' }, { tenantId: null }]);
    });

    it('returns a HEALTHY verdict when every signal is good', async () => {
        const res = await getControlHealth(ctx, 'c-1');
        expect(res.verdict).toBe('HEALTHY');
        expect(res.status).toBe('IMPLEMENTED');
        expect(res.applicability).toBe('APPLICABLE');
    });

    it('deduplicates frameworks and reports coverage counts', async () => {
        const res = await getControlHealth(ctx, 'c-1');
        expect(res.coverage.requirementCount).toBe(3);
        expect(res.coverage.frameworkCount).toBe(2);
        expect(res.coverage.frameworks).toEqual(['ISO/IEC 27001', 'SOC 2']);
    });

    it('serialises the latest manual test result and timestamp', async () => {
        const res = await getControlHealth(ctx, 'c-1');
        expect(res.latestTestResult).toBe('PASS');
        expect(res.latestTestAt).toBe('2026-06-01T00:00:00.000Z');
        expect(res.lastTested).toBe('2026-06-01T00:00:00.000Z');
    });

    it('nulls the manual-test fields when there is no completed run', async () => {
        db.controlTestRun.findFirst.mockResolvedValue(null);
        db.control.findFirst.mockResolvedValue({
            id: 'c-1',
            status: 'IMPLEMENTED',
            applicability: 'APPLICABLE',
            lastTested: null,
            nextDueAt: null,
        });
        const res = await getControlHealth(ctx, 'c-1');
        expect(res.latestTestResult).toBeNull();
        expect(res.latestTestAt).toBeNull();
        expect(res.lastTested).toBeNull();
    });

    it('surfaces the latest automated check, and nulls it when there are none', async () => {
        let res = await getControlHealth(ctx, 'c-1');
        expect(res.latestCheckStatus).toBe('PASSED');
        expect(res.latestCheckAt).toBe('2026-06-20T00:00:00.000Z');
        expect(listExecutionsForControl).toHaveBeenCalledWith(ctx, 'c-1', {
            limit: 1,
        });

        listExecutionsForControl.mockResolvedValue([]);
        res = await getControlHealth(ctx, 'c-1');
        expect(res.latestCheckStatus).toBeNull();
        expect(res.latestCheckAt).toBeNull();
    });

    it('degrades to DEGRADED when an approved exception is open', async () => {
        db.controlException.count.mockResolvedValue(2);
        const res = await getControlHealth(ctx, 'c-1');
        expect(res.openExceptions).toBe(2);
        expect(res.verdict).toBe('DEGRADED');
    });

    it('degrades when the next test is overdue', async () => {
        db.control.findFirst.mockResolvedValue({
            id: 'c-1',
            status: 'IMPLEMENTED',
            applicability: 'APPLICABLE',
            lastTested: null,
            nextDueAt: new Date(Date.now() - DAY),
        });
        expect((await getControlHealth(ctx, 'c-1')).verdict).toBe('DEGRADED');
    });

    it('degrades when the newest evidence is older than the freshness window', async () => {
        db.controlEvidenceLink.findFirst.mockResolvedValue({
            createdAt: new Date(Date.now() - 400 * DAY),
        });
        expect((await getControlHealth(ctx, 'c-1')).verdict).toBe('DEGRADED');
    });

    it('degrades when there is no evidence at all', async () => {
        db.controlEvidenceLink.findFirst.mockResolvedValue(null);
        expect((await getControlHealth(ctx, 'c-1')).verdict).toBe('DEGRADED');
    });

    it('is AT_RISK when the measured pass rate is failing', async () => {
        computeControlEffectivenessMap.mockResolvedValue(
            new Map([['c-1', eff({ passRate: 40, passes: 2, fails: 3 })]]),
        );
        expect((await getControlHealth(ctx, 'c-1')).verdict).toBe('AT_RISK');
    });

    it('is NOT_APPLICABLE when the control is scoped out', async () => {
        db.control.findFirst.mockResolvedValue({
            id: 'c-1',
            status: 'NOT_STARTED',
            applicability: 'NOT_APPLICABLE',
            lastTested: null,
            nextDueAt: null,
        });
        expect((await getControlHealth(ctx, 'c-1')).verdict).toBe(
            'NOT_APPLICABLE',
        );
    });

    it('passes the effectiveness window through to the aggregate and the DTO', async () => {
        const res = await getControlHealth(ctx, 'c-1');
        expect(computeControlEffectivenessMap).toHaveBeenCalledWith(
            db,
            't-1',
            ['c-1'],
            90,
        );
        expect(res.effectiveness).toEqual({
            passRate: 100,
            total: 4,
            passes: 4,
            fails: 0,
            inconclusive: 0,
            windowDays: 90,
        });
    });

    it('bounds the requirement-link read', async () => {
        await getControlHealth(ctx, 'c-1');
        expect(db.controlRequirementLink.findMany.mock.calls[0][0].take).toBe(
            500,
        );
    });

    it('counts only APPROVED exceptions for this control', async () => {
        await getControlHealth(ctx, 'c-1');
        expect(db.controlException.count).toHaveBeenCalledWith({
            where: { tenantId: 't-1', controlId: 'c-1', status: 'APPROVED' },
        });
    });
});

describe('getControlHealthVerdicts', () => {
    const row = (over: Record<string, unknown> = {}) => ({
        id: 'c-1',
        status: 'IMPLEMENTED',
        applicability: 'APPLICABLE',
        nextDueAt: null,
        ...over,
    });

    it('enforces the controls.view gate', async () => {
        db.control.findMany.mockResolvedValue([]);
        computeControlEffectivenessMap.mockResolvedValue(new Map());
        await getControlHealthVerdicts(ctx);
        expect(assertCanReadControls).toHaveBeenCalledWith(ctx);
    });

    it('tallies a verdict per control and aggregates the counts', async () => {
        db.control.findMany.mockResolvedValue([
            row({ id: 'healthy' }),
            row({ id: 'at-risk', status: 'NOT_STARTED' }),
            row({ id: 'overdue', nextDueAt: new Date(Date.now() - DAY) }),
            row({ id: 'n-a', applicability: 'NOT_APPLICABLE' }),
            row({ id: 'unknown', status: 'IN_PROGRESS' }),
        ]);
        computeControlEffectivenessMap.mockResolvedValue(
            new Map([
                ['healthy', eff()],
                ['at-risk', eff()],
                ['overdue', eff()],
                ['n-a', eff()],
                // 'unknown' intentionally absent → no runs, not implemented.
            ]),
        );

        const res = await getControlHealthVerdicts(ctx);

        expect(res.counts).toEqual({
            HEALTHY: 1,
            DEGRADED: 1,
            AT_RISK: 1,
            NOT_APPLICABLE: 1,
            UNKNOWN: 1,
        });
        expect(res.verdicts).toHaveLength(5);
        expect(res.verdicts.find((v) => v.controlId === 'unknown')).toEqual({
            controlId: 'unknown',
            verdict: 'UNKNOWN',
            passRate: null,
        });
    });

    it('excludes soft-deleted controls and asks for cap+1 to detect truncation', async () => {
        db.control.findMany.mockResolvedValue([]);
        computeControlEffectivenessMap.mockResolvedValue(new Map());

        await getControlHealthVerdicts(ctx);

        const arg = db.control.findMany.mock.calls[0][0];
        expect(arg.where).toEqual({ tenantId: 't-1', deletedAt: null });
        expect(arg.take).toBe(HEALTH_VERDICT_SCAN_CAP + 1);
    });

    it('reports truncated=false and the scanned count under the cap', async () => {
        db.control.findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);
        computeControlEffectivenessMap.mockResolvedValue(
            new Map([
                ['a', eff()],
                ['b', eff()],
            ]),
        );

        const res = await getControlHealthVerdicts(ctx);
        expect(res.truncated).toBe(false);
        expect(res.scanned).toBe(2);
        expect(res.cap).toBe(HEALTH_VERDICT_SCAN_CAP);
    });

    it('slices back to the cap and flags truncation when the sentinel row comes back', async () => {
        const rows = Array.from({ length: HEALTH_VERDICT_SCAN_CAP + 1 }, (_, i) =>
            row({ id: `c-${i}` }),
        );
        db.control.findMany.mockResolvedValue(rows);
        computeControlEffectivenessMap.mockResolvedValue(new Map());

        const res = await getControlHealthVerdicts(ctx);

        expect(res.truncated).toBe(true);
        expect(res.scanned).toBe(HEALTH_VERDICT_SCAN_CAP);
        expect(res.verdicts).toHaveLength(HEALTH_VERDICT_SCAN_CAP);
        // The effectiveness aggregate must be asked only about the kept slice.
        expect(computeControlEffectivenessMap.mock.calls[0][2]).toHaveLength(
            HEALTH_VERDICT_SCAN_CAP,
        );
    });
});
