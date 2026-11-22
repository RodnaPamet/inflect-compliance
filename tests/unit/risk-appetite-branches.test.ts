/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * RQ-2 — risk-appetite DB-wrapper branch coverage.
 *
 * The pure `detectBreaches` math is exercised by
 * `tests/unit/risk-appetite.test.ts` and `createBreachRemediationTask`
 * by `tests/unit/breach-remediation-task.test.ts`. This file targets the
 * UNCOVERED branches in the DB-wrapper functions: the config CRUD upsert
 * (create-vs-update + null/coalesce arms), the check orchestrators
 * (no-config short-circuits, simulated-vs-Σ fallbacks), breach
 * persistence (create-vs-update idempotency, stale resolution), and the
 * dashboard status badge (NONE/WITHIN/APPROACHING/BREACHED).
 *
 * Pure UNIT tests — no DB. Everything mocked.
 */

const mockDbHolder: { db: any } = { db: null };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: any, fn: (db: any) => any) => fn(mockDbHolder.db),
    ),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

// resolveALE is used by loadAppetiteRisks — return the fairAle directly.
jest.mock('@/app-layer/usecases/fair-calculator', () => ({
    resolveALE: jest.fn((r: any) => r.fairAle ?? null),
}));

// getLatestSimulation feeds loadSimulatedPercentiles.
jest.mock('@/app-layer/usecases/monte-carlo', () => ({
    getLatestSimulation: jest.fn(),
}));

// task usecases — no-ops (not exercised here).
jest.mock('@/app-layer/usecases/task', () => ({
    createTask: jest.fn(),
    addTaskLink: jest.fn(),
}));

import {
    createBreachRemediationTask,
    getAppetiteConfig,
    upsertAppetiteConfig,
    checkPortfolioAppetite,
    checkSingleRiskAppetite,
    recordBreaches,
    resolveStaleBreaches,
    listBreaches,
    acknowledgeBreach,
    getAppetiteStatus,
    approveAppetiteConfig,
    getAppetiteApproval,
    type Breach,
} from '@/app-layer/usecases/risk-appetite';
import { logEvent } from '@/app-layer/events/audit';
import { createTask } from '@/app-layer/usecases/task';
import { getLatestSimulation } from '@/app-layer/usecases/monte-carlo';
import { makeRequestContext } from '../helpers/make-context';

const adminCtx = makeRequestContext('ADMIN');
// READER lacks write/admin; explicit override flips canRead off for guard tests.
const noReadCtx = makeRequestContext('READER', {
    permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
});
const readerCtx = makeRequestContext('READER');

function makeDb() {
    return {
        $queryRaw: jest.fn().mockResolvedValue([]),
        riskAppetiteConfig: {
            findFirst: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            create: jest.fn(),
        },
        risk: {
            findMany: jest.fn().mockResolvedValue([]),
        },
        riskAppetiteBreach: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        tenant: {
            findUnique: jest.fn().mockResolvedValue({ currencySymbol: '$' }),
        },
        user: {
            findUnique: jest.fn().mockResolvedValue(null),
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDbHolder.db = makeDb();
    (getLatestSimulation as jest.Mock).mockResolvedValue(null);
});

// ─── getAppetiteConfig — read guard + passthrough ───
describe('getAppetiteConfig', () => {
    it('returns the config row when read is permitted', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({ id: 'cfg-1' });
        await expect(getAppetiteConfig(adminCtx)).resolves.toEqual({ id: 'cfg-1' });
    });

    it('throws when read permission is missing (assertCanRead guard)', async () => {
        await expect(getAppetiteConfig(noReadCtx)).rejects.toThrow(/permission/i);
    });
});

// ─── upsertAppetiteConfig — admin guard, create vs update, null/date coalesce ───
describe('upsertAppetiteConfig', () => {
    it('throws when admin permission is missing', async () => {
        await expect(upsertAppetiteConfig(readerCtx, {})).rejects.toThrow(/administrative/i);
    });

    it('CREATE branch: no existing row → create + audit, with full coalesced fields', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue(null);
        mockDbHolder.db.riskAppetiteConfig.create.mockResolvedValue({ id: 'new-cfg' });

        const saved = await upsertAppetiteConfig(adminCtx, {
            totalAleThreshold: 1_000_000,
            singleRiskAleMax: 200_000,
            qualScoreMax: 15,
            testedPercentile: 90,
            categoryOverridesJson: { Ops: { totalAleMax: 1 } },
            appetiteStatement: 'stmt',
            reviewCadence: 'QUARTERLY',
            nextReviewAt: '2026-04-01T00:00:00Z',
        });

        expect(saved).toEqual({ id: 'new-cfg' });
        expect(mockDbHolder.db.riskAppetiteConfig.update).not.toHaveBeenCalled();
        const data = mockDbHolder.db.riskAppetiteConfig.create.mock.calls[0][0].data;
        expect(data.tenantId).toBe(adminCtx.tenantId);
        // A save never approves (#5313 item 11).
        expect(data).not.toHaveProperty('approvedAt');
        expect(data).not.toHaveProperty('approvedByUserId');
        expect(data.nextReviewAt).toBeInstanceOf(Date);
        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(), adminCtx,
            expect.objectContaining({ action: 'RISK_APPETITE_CONFIGURED' }),
        );
    });

    it('UPDATE branch: existing row → update by id; null/undefined arms collapse', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({ id: 'cfg-existing' });
        mockDbHolder.db.riskAppetiteConfig.update.mockResolvedValue({ id: 'cfg-existing' });

        // All optional inputs omitted → null/undefined coalesce arms.
        const saved = await upsertAppetiteConfig(adminCtx, {});

        expect(saved).toEqual({ id: 'cfg-existing' });
        expect(mockDbHolder.db.riskAppetiteConfig.create).not.toHaveBeenCalled();
        const args = mockDbHolder.db.riskAppetiteConfig.update.mock.calls[0][0];
        expect(args.where).toEqual({ id: 'cfg-existing' });
        expect(args.data.totalAleThreshold).toBeNull();
        expect(args.data).not.toHaveProperty('approvedAt'); // a save never touches the approval
        expect(args.data.nextReviewAt).toBeNull();    // falsy nextReviewAt → null
        expect(args.data.categoryOverridesJson).toBeUndefined();
    });
});

// ─── #5313 item 11 — the approval is its own act, and a change clears it ───
describe('risk-appetite approval (#5313 item 11)', () => {
    const ownerCtx = makeRequestContext('OWNER', { userId: 'owner-1' });
    const stored = {
        id: 'cfg-1',
        appetiteStatement: 'We accept moderate operational risk.',
        totalAleThreshold: 1_000_000,
        singleRiskAleMax: 200_000,
        qualScoreMax: 15,
        testedPercentile: 80,
        categoryOverridesJson: { Ops: { totalAleMax: 5, singleAleMax: 1 } },
        approvedAt: new Date('2026-11-01T00:00:00Z'),
    };
    const sameTerms = {
        appetiteStatement: stored.appetiteStatement,
        totalAleThreshold: stored.totalAleThreshold,
        singleRiskAleMax: stored.singleRiskAleMax,
        qualScoreMax: stored.qualScoreMax,
        testedPercentile: 80 as const,
        // Same overrides, keys in another order: not a change.
        categoryOverridesJson: { Ops: { singleAleMax: 1, totalAleMax: 5 } },
    };

    function savedData() {
        mockDbHolder.db.riskAppetiteConfig.update.mockResolvedValue({ id: 'cfg-1' });
        return () => mockDbHolder.db.riskAppetiteConfig.update.mock.calls[0][0].data;
    }

    it('a save that changes the statement clears the approval, and says so in the audit row', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue(stored);
        const data = savedData();
        await upsertAppetiteConfig(adminCtx, { ...sameTerms, appetiteStatement: 'We accept high risk.' });
        expect(data()).toMatchObject({ approvedByUserId: null, approvedAt: null });
        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(), adminCtx,
            expect.objectContaining({
                action: 'RISK_APPETITE_CONFIGURED',
                detailsJson: expect.objectContaining({ approvalCleared: true }),
            }),
        );
    });

    it.each([
        ['a limit', { totalAleThreshold: 2_000_000 }],
        ['a limit cleared', { qualScoreMax: null }],
        ['the tested percentile', { testedPercentile: 95 as const }],
        ['a category override', { categoryOverridesJson: { Ops: { totalAleMax: 6, singleAleMax: 1 } } }],
    ])('a save that changes %s clears the approval', async (_label, change) => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue(stored);
        const data = savedData();
        await upsertAppetiteConfig(adminCtx, { ...sameTerms, ...change });
        expect(data()).toMatchObject({ approvedByUserId: null, approvedAt: null });
    });

    it('a save that changes neither keeps the approval (cadence and review date are not the terms)', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue(stored);
        const data = savedData();
        await upsertAppetiteConfig(adminCtx, { ...sameTerms, reviewCadence: 'QUARTERLY', nextReviewAt: '2027-01-01T00:00:00Z' });
        expect(data()).not.toHaveProperty('approvedAt');
        expect(data()).not.toHaveProperty('approvedByUserId');
        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(), adminCtx,
            expect.objectContaining({ detailsJson: expect.objectContaining({ approvalCleared: false }) }),
        );
    });

    it('a save never carries an approval the caller supplies', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({ ...stored, approvedAt: null });
        const data = savedData();
        await upsertAppetiteConfig(adminCtx, {
            ...sameTerms,
            // The input type no longer has these; a caller that forces them in
            // still cannot get them stored.
            ...({ approvedByUserId: 'someone-else', approvedAt: '2026-01-01T00:00:00Z' } as object),
        });
        expect(data()).not.toHaveProperty('approvedAt');
        expect(data()).not.toHaveProperty('approvedByUserId');
    });

    // The version the approver's page loaded (owner decision 2026-11-15).
    const viewed = { configId: 'cfg-1', viewedUpdatedAt: '2026-11-15T09:00:00.123Z' };

    it('approve stamps the caller and the server clock in ONE write bound to the version shown', async () => {
        mockDbHolder.db.riskAppetiteConfig.updateMany.mockResolvedValue({ count: 1 });
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({ id: 'cfg-1' });
        const before = Date.now();
        await approveAppetiteConfig(ownerCtx, viewed);
        expect(mockDbHolder.db.riskAppetiteConfig.updateMany).toHaveBeenCalledTimes(1);
        const args = mockDbHolder.db.riskAppetiteConfig.updateMany.mock.calls[0][0];
        expect(args.where).toEqual({
            tenantId: ownerCtx.tenantId,
            id: 'cfg-1',
            updatedAt: new Date('2026-11-15T09:00:00.123Z'),
        });
        expect(args.data.approvedByUserId).toBe('owner-1');
        expect(args.data.approvedAt.getTime()).toBeGreaterThanOrEqual(before);
        // Never read-then-write: nothing was read before the stamp.
        expect(mockDbHolder.db.riskAppetiteConfig.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
            mockDbHolder.db.riskAppetiteConfig.findFirst.mock.invocationCallOrder[0],
        );
        expect(mockDbHolder.db.riskAppetiteConfig.update).not.toHaveBeenCalled();
        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(), ownerCtx,
            expect.objectContaining({ action: 'RISK_APPETITE_APPROVED', entityId: 'cfg-1' }),
        );
    });

    it('approve of a version that is no longer stored is a 409 and writes no audit row', async () => {
        // A save after the page loaded moved updatedAt: the conditional write
        // matches nothing.
        mockDbHolder.db.riskAppetiteConfig.updateMany.mockResolvedValue({ count: 0 });
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({ id: 'cfg-1' });
        await expect(approveAppetiteConfig(ownerCtx, viewed)).rejects.toMatchObject({
            status: 409,
            details: { reason: 'RISK_APPETITE_CHANGED_SINCE_VIEWED' },
        });
        expect(mockDbHolder.db.riskAppetiteConfig.update).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('approve refuses an ADMIN (no admin.tenant_lifecycle) and writes nothing', async () => {
        await expect(approveAppetiteConfig(adminCtx, viewed)).rejects.toMatchObject({
            status: 403,
            details: { reason: 'RISK_APPETITE_APPROVAL_IS_OWNER_TIER' },
        });
        expect(mockDbHolder.db.riskAppetiteConfig.updateMany).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('approve refuses an API key, even one carrying the key', async () => {
        await expect(approveAppetiteConfig({ ...ownerCtx, apiKeyId: 'key-1' }, viewed)).rejects.toMatchObject({
            status: 403,
            details: { reason: 'RISK_APPETITE_APPROVAL_NEEDS_PERSON' },
        });
        expect(mockDbHolder.db.riskAppetiteConfig.updateMany).not.toHaveBeenCalled();
    });

    it('approve with nothing saved is a 404', async () => {
        mockDbHolder.db.riskAppetiteConfig.updateMany.mockResolvedValue({ count: 0 });
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue(null);
        await expect(approveAppetiteConfig(ownerCtx, viewed)).rejects.toMatchObject({ status: 404 });
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('approve naming no valid version is a 400 and writes nothing', async () => {
        await expect(approveAppetiteConfig(ownerCtx, { configId: 'cfg-1', viewedUpdatedAt: 'not a date' }))
            .rejects.toMatchObject({ status: 400 });
        expect(mockDbHolder.db.riskAppetiteConfig.updateMany).not.toHaveBeenCalled();
    });

    it('a save locks the row before it reads it, so an approval cannot land between its read and its write', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue(stored);
        savedData();
        await upsertAppetiteConfig(adminCtx, sameTerms);
        expect(mockDbHolder.db.$queryRaw).toHaveBeenCalledTimes(1);
        const sql = (mockDbHolder.db.$queryRaw.mock.calls[0][0] as string[]).join('?');
        expect(sql).toMatch(/FROM "RiskAppetiteConfig"\s+WHERE "tenantId" = \?\s+FOR UPDATE/);
        expect(mockDbHolder.db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            mockDbHolder.db.riskAppetiteConfig.findFirst.mock.invocationCallOrder[0],
        );
    });

    it('getAppetiteApproval names the approver, and is null when unapproved', async () => {
        mockDbHolder.db.user.findUnique.mockResolvedValue({ name: 'Olga Owner', email: 'o@example.test' });
        await expect(getAppetiteApproval(adminCtx, {
            approvedByUserId: 'owner-1', approvedAt: new Date('2026-11-15T10:00:00Z'),
        })).resolves.toEqual({ approvedAt: '2026-11-15T10:00:00.000Z', approverName: 'Olga Owner' });
        await expect(getAppetiteApproval(adminCtx, { approvedByUserId: null, approvedAt: null })).resolves.toBeNull();
    });
});

// ─── checkPortfolioAppetite — no-config short-circuit, simulated vs Σ ───
describe('checkPortfolioAppetite', () => {
    it('no config → within-appetite zero result (early return branch)', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue(null);
        const r = await checkPortfolioAppetite(adminCtx);
        expect(r).toEqual({
            breaches: [],
            portfolioAle: 0,
            portfolioTested: { value: 0, percentile: 80, simulated: false },
            isWithinAppetite: true,
        });
        expect(mockDbHolder.db.risk.findMany).not.toHaveBeenCalled();
    });

    it('config present, no simulation → Σ(mean) fallback, breach when over ceiling', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({
            totalAleThreshold: 1_000, singleRiskAleMax: null, qualScoreMax: null,
            categoryOverridesJson: null, testedPercentile: 80,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'a', score: 5, category: 'Ops', fairAle: 800, sleAmount: null, aroAmount: null },
            { id: 'b', score: 5, category: 'Ops', fairAle: 800, sleAmount: null, aroAmount: null },
        ]);
        (getLatestSimulation as jest.Mock).mockResolvedValue(null);

        const r = await checkPortfolioAppetite(adminCtx);
        expect(r.portfolioAle).toBe(1_600);
        expect(r.portfolioTested.simulated).toBe(false);
        expect(r.breaches.some((b) => b.type === 'PORTFOLIO_ALE')).toBe(true);
    });

    it('config present, simulation present → tested at simulated percentile', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({
            totalAleThreshold: 1_000, singleRiskAleMax: null, qualScoreMax: null,
            categoryOverridesJson: null, testedPercentile: 95,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'a', score: 5, category: null, fairAle: 100, sleAmount: null, aroAmount: null },
        ]);
        // Every percentile field set — exercises all five if-branches in loadSimulatedPercentiles.
        (getLatestSimulation as jest.Mock).mockResolvedValue({
            portfolioP50: 200, portfolioP80: 400, portfolioP90: 600, portfolioP95: 5_000, portfolioP99: 9_000,
        });

        const r = await checkPortfolioAppetite(adminCtx);
        expect(r.portfolioTested).toEqual({ value: 5_000, percentile: 95, simulated: true });
        expect(r.breaches.find((b) => b.type === 'PORTFOLIO_ALE')).toMatchObject({ actual: 5_000 });
    });

    it('simulation present but all percentiles null → empty map → null → Σ fallback', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({
            totalAleThreshold: 50, singleRiskAleMax: null, qualScoreMax: null,
            categoryOverridesJson: null, testedPercentile: 80,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'a', score: 1, category: null, fairAle: 100, sleAmount: null, aroAmount: null },
        ]);
        (getLatestSimulation as jest.Mock).mockResolvedValue({
            portfolioP50: null, portfolioP80: null, portfolioP90: null, portfolioP95: null, portfolioP99: null,
        });

        const r = await checkPortfolioAppetite(adminCtx);
        expect(r.portfolioTested.simulated).toBe(false);
        expect(r.portfolioTested.value).toBe(100);
    });

    it('resolveALE returning null falls back to 0 in loadAppetiteRisks', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({
            totalAleThreshold: null, singleRiskAleMax: null, qualScoreMax: null,
            categoryOverridesJson: null, testedPercentile: 80,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'a', score: 1, category: null, fairAle: null, sleAmount: null, aroAmount: null },
        ]);
        const r = await checkPortfolioAppetite(adminCtx);
        expect(r.portfolioAle).toBe(0);
    });
});

// ─── checkSingleRiskAppetite — no-config, missing-target, breached ───
describe('checkSingleRiskAppetite', () => {
    it('no config → not breached', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue(null);
        await expect(checkSingleRiskAppetite(adminCtx, 'r-1')).resolves.toEqual({ breached: false });
    });

    it('target risk not found in portfolio → not breached', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({
            totalAleThreshold: null, singleRiskAleMax: 100, qualScoreMax: null,
            categoryOverridesJson: null, testedPercentile: 80,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'other', score: 1, category: null, fairAle: 999, sleAmount: null, aroAmount: null },
        ]);
        await expect(checkSingleRiskAppetite(adminCtx, 'missing')).resolves.toEqual({ breached: false });
    });

    it('target over single-risk cap → breached with details', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({
            totalAleThreshold: null, singleRiskAleMax: 100, qualScoreMax: null,
            categoryOverridesJson: null, testedPercentile: 80,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'r-1', score: 1, category: null, fairAle: 500, sleAmount: null, aroAmount: null },
        ]);
        const r = await checkSingleRiskAppetite(adminCtx, 'r-1');
        expect(r.breached).toBe(true);
        expect(r.details).toMatchObject({ type: 'SINGLE_RISK_ALE', riskId: 'r-1', actual: 500 });
    });

    it('target present but within caps → not breached, no details', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({
            totalAleThreshold: null, singleRiskAleMax: 1_000, qualScoreMax: 50,
            categoryOverridesJson: null, testedPercentile: 80,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'r-1', score: 1, category: null, fairAle: 10, sleAmount: null, aroAmount: null },
        ]);
        const r = await checkSingleRiskAppetite(adminCtx, 'r-1');
        expect(r.breached).toBe(false);
        expect(r.details).toBeUndefined();
    });
});

// ─── recordBreaches — empty short-circuit, create-vs-update map ───
describe('recordBreaches', () => {
    const b = (over: Partial<Breach> = {}): Breach => ({
        type: 'SINGLE_RISK_ALE', riskId: 'r-1', threshold: 100, actual: 200, ...over,
    });

    it('empty list short-circuits to 0 without touching the DB', async () => {
        const n = await recordBreaches(adminCtx, []);
        expect(n).toBe(0);
        expect(mockDbHolder.db.riskAppetiteBreach.findMany).not.toHaveBeenCalled();
    });

    it('new breach (not in open set) → create, returns created count', async () => {
        mockDbHolder.db.riskAppetiteBreach.findMany.mockResolvedValue([]);
        const n = await recordBreaches(adminCtx, [b()]);
        expect(n).toBe(1);
        expect(mockDbHolder.db.riskAppetiteBreach.create).toHaveBeenCalledTimes(1);
        expect(mockDbHolder.db.riskAppetiteBreach.update).not.toHaveBeenCalled();
    });

    it('existing open breach (same key) → update, not counted as created', async () => {
        mockDbHolder.db.riskAppetiteBreach.findMany.mockResolvedValue([
            { id: 'open-1', breachType: 'SINGLE_RISK_ALE', riskId: 'r-1', category: null },
        ]);
        const n = await recordBreaches(adminCtx, [b({ actual: 300, threshold: 150 })]);
        expect(n).toBe(0);
        expect(mockDbHolder.db.riskAppetiteBreach.update).toHaveBeenCalledWith({
            where: { id: 'open-1' },
            data: { actualValue: 300, thresholdValue: 150 },
        });
        expect(mockDbHolder.db.riskAppetiteBreach.create).not.toHaveBeenCalled();
    });

    it('mixed batch — category/portfolio breaches use null riskId in the key', async () => {
        mockDbHolder.db.riskAppetiteBreach.findMany.mockResolvedValue([
            { id: 'open-cat', breachType: 'CATEGORY_ALE', riskId: null, category: 'Ops' },
        ]);
        const n = await recordBreaches(adminCtx, [
            b({ type: 'CATEGORY_ALE', riskId: undefined, category: 'Ops', actual: 5, threshold: 4 }), // update
            b({ type: 'PORTFOLIO_ALE', riskId: undefined, category: undefined, actual: 9, threshold: 8 }), // create
        ]);
        expect(n).toBe(1);
        expect(mockDbHolder.db.riskAppetiteBreach.update).toHaveBeenCalledTimes(1);
        expect(mockDbHolder.db.riskAppetiteBreach.create).toHaveBeenCalledTimes(1);
    });
});

// ─── resolveStaleBreaches — resolve absent vs keep active ───
describe('resolveStaleBreaches', () => {
    it('resolves open breaches no longer active; keeps still-active ones', async () => {
        mockDbHolder.db.riskAppetiteBreach.findMany.mockResolvedValue([
            { id: 'stale', breachType: 'SINGLE_RISK_ALE', riskId: 'r-1', category: null },
            { id: 'still', breachType: 'CATEGORY_ALE', riskId: null, category: 'Ops' },
        ]);
        const active: Breach[] = [
            { type: 'CATEGORY_ALE', riskId: undefined, category: 'Ops', threshold: 1, actual: 2 },
        ];
        const n = await resolveStaleBreaches(adminCtx, active);
        expect(n).toBe(1);
        expect(mockDbHolder.db.riskAppetiteBreach.update).toHaveBeenCalledTimes(1);
        expect(mockDbHolder.db.riskAppetiteBreach.update.mock.calls[0][0].where).toEqual({ id: 'stale' });
    });

    it('no open breaches → resolves nothing', async () => {
        mockDbHolder.db.riskAppetiteBreach.findMany.mockResolvedValue([]);
        const n = await resolveStaleBreaches(adminCtx, []);
        expect(n).toBe(0);
    });
});

// ─── listBreaches / acknowledgeBreach — guard + passthrough ───
describe('listBreaches & acknowledgeBreach', () => {
    it('listBreaches returns rows under read permission', async () => {
        mockDbHolder.db.riskAppetiteBreach.findMany.mockResolvedValue([{ id: 'br-1' }]);
        await expect(listBreaches(adminCtx)).resolves.toEqual([{ id: 'br-1' }]);
    });

    it('listBreaches throws without read permission', async () => {
        await expect(listBreaches(noReadCtx)).rejects.toThrow(/permission/i);
    });

    it('acknowledgeBreach with a note writes acknowledgement fields', async () => {
        mockDbHolder.db.riskAppetiteBreach.updateMany.mockResolvedValue({ count: 1 });
        await acknowledgeBreach(adminCtx, 'br-1', 'looking into it');
        const args = mockDbHolder.db.riskAppetiteBreach.updateMany.mock.calls[0][0];
        expect(args.where).toMatchObject({ id: 'br-1', tenantId: adminCtx.tenantId });
        expect(args.data.acknowledgementNote).toBe('looking into it');
        expect(args.data.acknowledgedBy).toBe(adminCtx.userId);
    });

    it('acknowledgeBreach without a note coalesces to null', async () => {
        mockDbHolder.db.riskAppetiteBreach.updateMany.mockResolvedValue({ count: 1 });
        await acknowledgeBreach(adminCtx, 'br-1');
        expect(mockDbHolder.db.riskAppetiteBreach.updateMany.mock.calls[0][0].data.acknowledgementNote).toBeNull();
    });

    it('acknowledgeBreach throws without admin permission', async () => {
        await expect(acknowledgeBreach(readerCtx, 'br-1')).rejects.toThrow(/administrative/i);
    });
});

// ─── createBreachRemediationTask — QUAL_SCORE title + null-tenant currency + fallback title ───
describe('createBreachRemediationTask — title arms', () => {
    const baseBreach = (over: any = {}) => ({
        id: 'br-1', tenantId: adminCtx.tenantId, breachType: 'QUAL_SCORE',
        riskId: 'r-1', category: null, thresholdValue: 15, actualValue: 22.6,
        detectedAt: new Date('2026-06-01T00:00:00Z'), resolvedAt: null, remediationTaskId: null, ...over,
    });

    beforeEach(() => {
        (createTask as jest.Mock).mockResolvedValue({ id: 'task-q' });
    });

    it('QUAL_SCORE breach → rounded-score title (lines 351-353)', async () => {
        mockDbHolder.db.riskAppetiteBreach.findFirst.mockResolvedValue(baseBreach());
        await createBreachRemediationTask(adminCtx, 'br-1');
        const title = (createTask as jest.Mock).mock.calls[0][1].title;
        expect(title).toMatch(/risk score 23 exceeds the 15 cap/);
    });

    it('null tenant currencySymbol falls back to € default', async () => {
        mockDbHolder.db.tenant.findUnique.mockResolvedValue(null);
        mockDbHolder.db.riskAppetiteBreach.findFirst.mockResolvedValue(
            baseBreach({ breachType: 'PORTFOLIO_ALE', riskId: null, thresholdValue: 1_000_000, actualValue: 2_000_000 }),
        );
        await createBreachRemediationTask(adminCtx, 'br-1');
        const title = (createTask as jest.Mock).mock.calls[0][1].title;
        expect(title).toContain('€');
    });

    it('unknown breachType → generic fallback title (line 395)', async () => {
        mockDbHolder.db.riskAppetiteBreach.findFirst.mockResolvedValue(
            baseBreach({ breachType: 'MYSTERY_TYPE', riskId: null }),
        );
        await createBreachRemediationTask(adminCtx, 'br-1');
        const title = (createTask as jest.Mock).mock.calls[0][1].title;
        expect(title).toMatch(/Remediate risk-appetite breach \(MYSTERY_TYPE\)/);
    });
});

// ─── getAppetiteStatus — NONE / BREACHED / APPROACHING / WITHIN ───
describe('getAppetiteStatus', () => {
    it('NONE when no config', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue(null);
        const r = await getAppetiteStatus(adminCtx);
        expect(r).toEqual({ status: 'NONE', portfolioAle: 0, portfolioTested: null, activeBreaches: 0 });
    });

    it('BREACHED when checkPortfolioAppetite returns breaches', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({
            totalAleThreshold: 100, singleRiskAleMax: null, qualScoreMax: null,
            categoryOverridesJson: null, testedPercentile: 80,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'a', score: 1, category: null, fairAle: 500, sleAmount: null, aroAmount: null },
        ]);
        const r = await getAppetiteStatus(adminCtx);
        expect(r.status).toBe('BREACHED');
        expect(r.activeBreaches).toBeGreaterThan(0);
    });

    it('APPROACHING when tested value is > 80% of ceiling but not breached', async () => {
        // ceiling 1000, value 900 → not breached (900 < 1000) but > 800.
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({
            totalAleThreshold: 1_000, singleRiskAleMax: null, qualScoreMax: null,
            categoryOverridesJson: null, testedPercentile: 80,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'a', score: 1, category: null, fairAle: 900, sleAmount: null, aroAmount: null },
        ]);
        const r = await getAppetiteStatus(adminCtx);
        expect(r.status).toBe('APPROACHING');
        expect(r.activeBreaches).toBe(0);
    });

    it('WITHIN when well under the ceiling', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({
            totalAleThreshold: 1_000, singleRiskAleMax: null, qualScoreMax: null,
            categoryOverridesJson: null, testedPercentile: 80,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'a', score: 1, category: null, fairAle: 10, sleAmount: null, aroAmount: null },
        ]);
        const r = await getAppetiteStatus(adminCtx);
        expect(r.status).toBe('WITHIN');
    });

    it('WITHIN when threshold is null (approaching branch skipped)', async () => {
        mockDbHolder.db.riskAppetiteConfig.findFirst.mockResolvedValue({
            totalAleThreshold: null, singleRiskAleMax: null, qualScoreMax: null,
            categoryOverridesJson: null, testedPercentile: 80,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            { id: 'a', score: 1, category: null, fairAle: 9_999_999, sleAmount: null, aroAmount: null },
        ]);
        const r = await getAppetiteStatus(adminCtx);
        expect(r.status).toBe('WITHIN');
    });
});
