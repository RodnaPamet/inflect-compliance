/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * RQ-4 — risk-scenario branch coverage.
 *
 * The pure `applyOverrides` / `computeRoi` paths are exercised by
 * `tests/unit/risk-scenario.test.ts`. This file targets the UNCOVERED
 * branches:
 *   • `recomputeAle` derivation arms (TEF from cf×poa, vuln from tc×cs,
 *     not-enough-data keep-legacy, secondary-loss defaults).
 *   • `applyOverrides` synthetic-without-fairInputs (ale 0) + skip arms
 *     (missing riskId/field/newValue).
 *   • CRUD wrappers: create / list (status filter on+off) / get
 *     (found + notFound) / archive / clone.
 *   • `simulateScenario`: archived-reject, persistence, ROI, per-risk
 *     deltas (filter to changed + deltaPercent baseline-zero arm),
 *     `loadScenarioRisks` resolveALE-null skip + parseDist valid/invalid,
 *     overrides defaulting when overridesJson is null.
 *
 * Pure UNIT tests — no DB. Prisma simulation core mocked; the FAIR
 * calculator stays REAL so recompute math is genuinely exercised.
 */

const mockDbHolder: { db: any } = { db: null };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: any, fn: (db: any) => any) => fn(mockDbHolder.db),
    ),
}));

// Mock only the simulation engine; keep type re-exports intact.
const simulatePortfolioMock = jest.fn();
jest.mock('@/app-layer/usecases/monte-carlo', () => ({
    simulatePortfolio: (...args: any[]) => simulatePortfolioMock(...args),
}));

import {
    applyOverrides,
    computeRoi,
    createScenario,
    listScenarios,
    getScenario,
    archiveScenario,
    cloneScenario,
    simulateScenario,
    getScenarioComparison,
    type ScenarioRisk,
    type ScenarioOverride,
} from '@/app-layer/usecases/risk-scenario';
import { makeRequestContext } from '../helpers/make-context';

const adminCtx = makeRequestContext('ADMIN');
const noReadCtx = makeRequestContext('READER', {
    permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
});
const noWriteCtx = makeRequestContext('READER'); // canWrite false

function makeDb() {
    return {
        riskScenario: {
            create: jest.fn(),
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            update: jest.fn().mockResolvedValue({}),
        },
        risk: {
            findMany: jest.fn().mockResolvedValue([]),
        },
        riskSimulationRun: {
            create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        },
    };
}

const SIM_RESULT = {
    iterationsRun: 1000,
    executionMs: 5,
    portfolioAle: { mean: 1000, median: 900, p90: 1500, p95: 1800, p99: 2200, stdDev: 100 },
    lossExceedanceCurve: [],
    perRisk: [],
};

beforeEach(() => {
    jest.clearAllMocks();
    mockDbHolder.db = makeDb();
    simulatePortfolioMock.mockReturnValue({ ...SIM_RESULT, portfolioAle: { ...SIM_RESULT.portfolioAle } });
});

// ─── applyOverrides — recompute derivation arms + synthetic/skip ───
describe('applyOverrides — recompute & override arms', () => {
    it('field patch derives TEF from contactFrequency×probabilityOfAction', () => {
        // No threatEventFrequency — TEF derived from cf×poa; vuln direct.
        const risk: ScenarioRisk = {
            id: 'a', title: 'a', ale: 0,
            fair: { contactFrequency: 4, probabilityOfAction: 0.5, vulnerabilityProbability: 0.5, primaryLossMagnitude: 100_000 },
        };
        const out = applyOverrides([risk], [{ riskId: 'a', field: 'primaryLossMagnitude', newValue: 200_000 }]);
        // TEF = 4×0.5 = 2; LEF = 2×0.5 = 1; ALE = 1×200000
        expect(out[0].ale).toBeCloseTo(200_000, 0);
    });

    it('field patch derives vulnerability from threatCapability×controlStrength', () => {
        const risk: ScenarioRisk = {
            id: 'a', title: 'a', ale: 0,
            fair: { threatEventFrequency: 10, threatCapability: 0.8, controlStrength: 0.3, primaryLossMagnitude: 1000 },
        };
        const out = applyOverrides([risk], [{ riskId: 'a', field: 'primaryLossMagnitude', newValue: 1000 }]);
        // vuln derived → recompute succeeds → a finite, non-legacy ALE
        expect(out[0].ale).toBeGreaterThan(0);
    });

    it('not-enough-FAIR-data keeps the legacy ALE (tef or vuln null)', () => {
        const risk: ScenarioRisk = { id: 'a', title: 'a', ale: 777, fair: { primaryLossMagnitude: 100 } };
        const out = applyOverrides([risk], [{ riskId: 'a', field: 'primaryLossMagnitude', newValue: 100 }]);
        expect(out[0].ale).toBe(777); // legacy retained
    });

    it('uses present secondary-loss components (slef/slm) when set', () => {
        // All fair fields including slef/slm present → recompute uses them (not the ?? 0 default).
        const risk: ScenarioRisk = {
            id: 'a', title: 'a', ale: 0,
            fair: {
                threatEventFrequency: 2, vulnerabilityProbability: 0.5, primaryLossMagnitude: 100,
                secondaryLossEventFrequency: 0.5, secondaryLossMagnitude: 40,
            },
        };
        const out = applyOverrides([risk], [{ riskId: 'a', field: 'primaryLossMagnitude', newValue: 100 }]);
        // primary = LEF×PLM = 1×100 = 100; secondary = LEF×slef×slm = 1×0.5×40 = 20 → 120
        expect(out[0].ale).toBeCloseTo(120, 0);
    });

    it('secondary-loss components default to 0 when absent', () => {
        const risk: ScenarioRisk = {
            id: 'a', title: 'a', ale: 0,
            fair: { threatEventFrequency: 2, vulnerabilityProbability: 0.5, primaryLossMagnitude: 100 },
        };
        const out = applyOverrides([risk], [{ riskId: 'a', field: 'primaryLossMagnitude', newValue: 100 }]);
        // slef/slm default 0 → ALE = LEF×PLM = (2×0.5)×100 = 100
        expect(out[0].ale).toBeCloseTo(100, 0);
    });

    it('synthetic override WITHOUT fairInputs adds a zero-ALE virtual risk with default title', () => {
        const out = applyOverrides([], [{ riskId: null, synthetic: true }]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('synthetic-0');
        expect(out[0].title).toBe('Synthetic risk');
        expect(out[0].ale).toBe(0);
        expect(out[0].distributions).toBeUndefined();
    });

    it('skips overrides missing riskId / field / newValue', () => {
        const risk: ScenarioRisk = { id: 'a', title: 'a', ale: 500, fair: {} };
        const out = applyOverrides([risk], [
            { riskId: null, field: 'threatEventFrequency', newValue: 1 } as ScenarioOverride, // no riskId
            { riskId: 'a', newValue: 1 } as ScenarioOverride,                                 // no field
            { riskId: 'a', field: 'threatEventFrequency' } as ScenarioOverride,               // no newValue
        ]);
        expect(out[0].ale).toBe(500); // untouched
    });
});

// ─── computeRoi positive-investment branch sanity ───
describe('computeRoi positive branch', () => {
    it('returns a finite ratio for a positive investment', () => {
        expect(computeRoi(1000, 600, 200)).toBeCloseTo(2, 5);
    });
});

// ─── createScenario — write guard + null coalesce arms ───
describe('createScenario', () => {
    it('throws without write permission', async () => {
        await expect(createScenario(noWriteCtx, { name: 'x' })).rejects.toThrow(/permission/i);
    });

    it('creates with omitted optionals coalescing to null/[]', async () => {
        mockDbHolder.db.riskScenario.create.mockResolvedValue({ id: 's-1' });
        const r = await createScenario(adminCtx, { name: 'Scenario X' });
        expect(r).toEqual({ id: 's-1' });
        const data = mockDbHolder.db.riskScenario.create.mock.calls[0][0].data;
        expect(data.description).toBeNull();
        expect(data.investmentCost).toBeNull();
        expect(data.overridesJson).toEqual([]);
        expect(data.status).toBe('DRAFT');
    });

    it('passes through supplied optionals', async () => {
        mockDbHolder.db.riskScenario.create.mockResolvedValue({ id: 's-2' });
        await createScenario(adminCtx, {
            name: 'Y', description: 'd', investmentCost: 500,
            overrides: [{ riskId: null, synthetic: true }],
        });
        const data = mockDbHolder.db.riskScenario.create.mock.calls[0][0].data;
        expect(data.description).toBe('d');
        expect(data.investmentCost).toBe(500);
        expect(data.overridesJson).toHaveLength(1);
    });
});

// ─── listScenarios — status filter on / off ───
describe('listScenarios', () => {
    it('throws without read permission', async () => {
        await expect(listScenarios(noReadCtx)).rejects.toThrow(/permission/i);
    });

    it('no status → where omits status filter', async () => {
        mockDbHolder.db.riskScenario.findMany.mockResolvedValue([{ id: 's' }]);
        await listScenarios(adminCtx);
        const where = mockDbHolder.db.riskScenario.findMany.mock.calls[0][0].where;
        expect(where).toEqual({ tenantId: adminCtx.tenantId });
    });

    it('status supplied → where includes status filter', async () => {
        mockDbHolder.db.riskScenario.findMany.mockResolvedValue([]);
        await listScenarios(adminCtx, { status: 'SIMULATED' });
        const where = mockDbHolder.db.riskScenario.findMany.mock.calls[0][0].where;
        expect(where).toMatchObject({ tenantId: adminCtx.tenantId, status: 'SIMULATED' });
    });
});

// ─── getScenario — found vs notFound ───
describe('getScenario', () => {
    it('returns the row when found', async () => {
        mockDbHolder.db.riskScenario.findFirst.mockResolvedValue({ id: 's-1' });
        await expect(getScenario(adminCtx, 's-1')).resolves.toEqual({ id: 's-1' });
    });

    it('throws notFound when absent', async () => {
        mockDbHolder.db.riskScenario.findFirst.mockResolvedValue(null);
        await expect(getScenario(adminCtx, 'ghost')).rejects.toThrow(/not found/i);
    });

    it('throws without read permission', async () => {
        await expect(getScenario(noReadCtx, 's-1')).rejects.toThrow(/permission/i);
    });
});

// ─── archiveScenario — write guard + updateMany ───
describe('archiveScenario', () => {
    it('updates status to ARCHIVED, tenant-scoped', async () => {
        await archiveScenario(adminCtx, 's-1');
        const args = mockDbHolder.db.riskScenario.updateMany.mock.calls[0][0];
        expect(args.where).toMatchObject({ id: 's-1', tenantId: adminCtx.tenantId });
        expect(args.data).toEqual({ status: 'ARCHIVED' });
    });

    it('throws without write permission', async () => {
        await expect(archiveScenario(noWriteCtx, 's-1')).rejects.toThrow(/permission/i);
    });
});

// ─── cloneScenario — copies source fields into a fresh DRAFT ───
describe('cloneScenario', () => {
    it('clones source fields under a new name', async () => {
        mockDbHolder.db.riskScenario.findFirst.mockResolvedValue({
            id: 'src', description: 'desc', investmentCost: 99, overridesJson: [{ a: 1 }],
        });
        mockDbHolder.db.riskScenario.create.mockResolvedValue({ id: 'clone-1' });
        const r = await cloneScenario(adminCtx, 'src', 'Copy');
        expect(r).toEqual({ id: 'clone-1' });
        const data = mockDbHolder.db.riskScenario.create.mock.calls[0][0].data;
        expect(data.name).toBe('Copy');
        expect(data.description).toBe('desc');
        expect(data.investmentCost).toBe(99);
        expect(data.status).toBe('DRAFT');
    });

    it('throws without write permission', async () => {
        await expect(cloneScenario(noWriteCtx, 'src', 'Copy')).rejects.toThrow(/permission/i);
    });
});

// ─── simulateScenario — archived-reject, persistence, deltas, loads ───
describe('simulateScenario', () => {
    it('rejects an archived scenario', async () => {
        mockDbHolder.db.riskScenario.findFirst.mockResolvedValue({ id: 's', status: 'ARCHIVED', overridesJson: [] });
        await expect(simulateScenario(adminCtx, 's')).rejects.toThrow(/archived/i);
    });

    it('throws without write permission', async () => {
        await expect(simulateScenario(noWriteCtx, 's')).rejects.toThrow(/permission/i);
    });

    it('runs end-to-end: persists run, links scenario, returns deltas + roi', async () => {
        mockDbHolder.db.riskScenario.findFirst.mockResolvedValue({
            id: 's', status: 'DRAFT', investmentCost: 100,
            // Patch risk r-1 so its ALE changes → appears in perRiskDeltas.
            overridesJson: [{ riskId: 'r-1', field: 'vulnerabilityProbability', newValue: 0.1 }],
        });
        // Two risks: r-1 has full FAIR (recomputable), r-2 only legacy ALE (unchanged).
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            {
                id: 'r-1', title: 'R1', fairAle: 500_000, sleAmount: null, aroAmount: null,
                fairInputsJson: null,
                threatEventFrequency: 10, contactFrequency: null, probabilityOfAction: null,
                vulnerabilityProbability: 0.5, threatCapability: null, controlStrength: null,
                primaryLossMagnitude: 100_000, productivityLoss: null, responseCost: null, replacementCost: null,
                secondaryLossEventFrequency: null, secondaryLossMagnitude: null,
            },
            {
                id: 'r-2', title: 'R2', fairAle: null, sleAmount: 100, aroAmount: 2,
                fairInputsJson: null,
                threatEventFrequency: null, contactFrequency: null, probabilityOfAction: null,
                vulnerabilityProbability: null, threatCapability: null, controlStrength: null,
                primaryLossMagnitude: null, productivityLoss: null, responseCost: null, replacementCost: null,
                secondaryLossEventFrequency: null, secondaryLossMagnitude: null,
            },
        ]);
        // Different baseline vs scenario means so roi/delta are non-trivial.
        simulatePortfolioMock
            .mockReturnValueOnce({ ...SIM_RESULT, portfolioAle: { mean: 1000, median: 1, p90: 1, p95: 1500, p99: 2000, stdDev: 1 } })
            .mockReturnValueOnce({ ...SIM_RESULT, portfolioAle: { mean: 600, median: 1, p90: 1, p95: 1100, p99: 1500, stdDev: 1 } });

        const r = await simulateScenario(adminCtx, 's');

        expect(mockDbHolder.db.riskSimulationRun.create).toHaveBeenCalledTimes(1);
        expect(mockDbHolder.db.riskScenario.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 's' },
            data: expect.objectContaining({ status: 'SIMULATED', resultRunId: 'run-1' }),
        }));
        expect(r.delta.meanAleDelta).toBe(-400);
        expect(r.delta.roi).toBeCloseTo((1000 - 600) / 100, 5);
        // r-1 changed ALE → present; r-2 unchanged → filtered out by deltaAle !== 0.
        expect(r.perRiskDeltas.map((d) => d.riskId)).toEqual(['r-1']);
        expect(r.perRiskDeltas[0].deltaPercent).not.toBe(0);
    });

    it('loadScenarioRisks maps all populated FAIR fields; deltaPercent is 0 when baseline ALE is 0', async () => {
        mockDbHolder.db.riskScenario.findFirst.mockResolvedValue({
            id: 's', status: 'DRAFT', investmentCost: null,
            // Patch raises ALE from 0 → positive, so the risk appears in deltas.
            overridesJson: [{ riskId: 'r-0', field: 'primaryLossMagnitude', newValue: 100_000 }],
        });
        // fairAle 0 → resolveALE returns 0 (baseline ale 0 → deltaPercent 0 arm),
        // every FAIR column populated → the `?? undefined` left-side arms (184-189).
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            {
                id: 'r-0', title: 'Zero', fairAle: 0, sleAmount: null, aroAmount: null,
                fairInputsJson: null,
                threatEventFrequency: 5, contactFrequency: 2, probabilityOfAction: 0.5,
                vulnerabilityProbability: 0.4, threatCapability: 0.6, controlStrength: 0.3,
                primaryLossMagnitude: 1, productivityLoss: 10, responseCost: 20, replacementCost: 30,
                secondaryLossEventFrequency: 0.1, secondaryLossMagnitude: 50,
            },
        ]);
        const r = await simulateScenario(adminCtx, 's');
        const delta = r.perRiskDeltas.find((d) => d.riskId === 'r-0');
        expect(delta).toBeDefined();
        expect(delta!.baselineAle).toBe(0);
        expect(delta!.deltaPercent).toBe(0); // b > 0 is false → 0 branch
    });

    it('defaults overrides to [] when overridesJson is null', async () => {
        mockDbHolder.db.riskScenario.findFirst.mockResolvedValue({
            id: 's', status: 'DRAFT', investmentCost: null, overridesJson: null,
        });
        mockDbHolder.db.risk.findMany.mockResolvedValue([]);
        const r = await simulateScenario(adminCtx, 's');
        // No investment → roi null branch.
        expect(r.delta.roi).toBeNull();
        expect(r.perRiskDeltas).toEqual([]);
    });

    it('loadScenarioRisks: parseDist accepts a valid distribution and skips resolveALE-null rows', async () => {
        mockDbHolder.db.riskScenario.findFirst.mockResolvedValue({
            id: 's', status: 'DRAFT', investmentCost: null, overridesJson: [],
        });
        const validDist = {
            tef: { min: 1 }, vulnerability: { min: 1 }, plm: { min: 1 }, slef: { min: 0 }, slm: { min: 0 },
        };
        mockDbHolder.db.risk.findMany.mockResolvedValue([
            // kept: resolves an ALE, valid distribution
            {
                id: 'keep', title: 'K', fairAle: 1000, sleAmount: null, aroAmount: null,
                fairInputsJson: validDist,
                threatEventFrequency: null, contactFrequency: null, probabilityOfAction: null,
                vulnerabilityProbability: null, threatCapability: null, controlStrength: null,
                primaryLossMagnitude: null, productivityLoss: null, responseCost: null, replacementCost: null,
                secondaryLossEventFrequency: null, secondaryLossMagnitude: null,
            },
            // kept, but dist is MISSING a required key (slm) → parseDist undefined (j[k] falsy arm)
            {
                id: 'partial', title: 'P', fairAle: 200, sleAmount: null, aroAmount: null,
                fairInputsJson: { tef: { min: 1 }, vulnerability: { min: 1 }, plm: { min: 1 }, slef: { min: 0 } },
                threatEventFrequency: null, contactFrequency: null, probabilityOfAction: null,
                vulnerabilityProbability: null, threatCapability: null, controlStrength: null,
                primaryLossMagnitude: null, productivityLoss: null, responseCost: null, replacementCost: null,
                secondaryLossEventFrequency: null, secondaryLossMagnitude: null,
            },
            // kept, but dist has a non-number min → parseDist undefined (typeof !== 'number' arm)
            {
                id: 'badmin', title: 'B', fairAle: 300, sleAmount: null, aroAmount: null,
                fairInputsJson: { tef: { min: 'bad' }, vulnerability: { min: 1 }, plm: { min: 1 }, slef: { min: 0 }, slm: { min: 0 } },
                threatEventFrequency: null, contactFrequency: null, probabilityOfAction: null,
                vulnerabilityProbability: null, threatCapability: null, controlStrength: null,
                primaryLossMagnitude: null, productivityLoss: null, responseCost: null, replacementCost: null,
                secondaryLossEventFrequency: null, secondaryLossMagnitude: null,
            },
            // skipped: resolveALE returns null (no fair/sle/aro) AND non-object dist json
            {
                id: 'skip', title: 'S', fairAle: null, sleAmount: null, aroAmount: null,
                fairInputsJson: 'not-an-object', // typeof !== object → parseDist undefined early
                threatEventFrequency: null, contactFrequency: null, probabilityOfAction: null,
                vulnerabilityProbability: null, threatCapability: null, controlStrength: null,
                primaryLossMagnitude: null, productivityLoss: null, responseCost: null, replacementCost: null,
                secondaryLossEventFrequency: null, secondaryLossMagnitude: null,
            },
        ]);

        await simulateScenario(adminCtx, 's');
        // simulatePortfolio gets the three kept (ALE-resolvable) risks; the
        // resolveALE-null row is skipped.
        const baselineArg = simulatePortfolioMock.mock.calls[0][0];
        const ids = baselineArg.map((r: any) => r.id);
        expect(ids).toEqual(['keep', 'partial', 'badmin']);
        // 'keep' has a valid dist; 'partial'/'badmin' have invalid dists → undefined.
        const keep = baselineArg.find((r: any) => r.id === 'keep');
        const partial = baselineArg.find((r: any) => r.id === 'partial');
        expect(keep.distributions).toBeDefined();
        expect(partial.distributions).toBeUndefined();
    });
});

// ─── #4770 — override values refused at create; the comparison read ───
describe('createScenario — override values', () => {
    it('refuses a probability outside 0..1, naming the field', async () => {
        await expect(createScenario(adminCtx, {
            name: 'x', overrides: [{ riskId: 'r', field: 'vulnerabilityProbability', newValue: 1.5 }],
        })).rejects.toThrow(/vulnerabilityProbability.*between 0 and 1/);
        expect(mockDbHolder.db.riskScenario.create).not.toHaveBeenCalled();
    });

    it('refuses a negative amount and an unknown field', async () => {
        await expect(createScenario(adminCtx, {
            name: 'x', overrides: [{ riskId: 'r', field: 'responseCost', newValue: -1 }],
        })).rejects.toThrow(/cannot be negative/);
        await expect(createScenario(adminCtx, {
            name: 'x', overrides: [{ riskId: 'r', field: 'nonsense' as never, newValue: 1 }],
        })).rejects.toThrow(/Unknown FAIR field/);
    });

    it('accepts capability and strength on either scale the risks use', async () => {
        mockDbHolder.db.riskScenario.create.mockResolvedValue({ id: 's' });
        await createScenario(adminCtx, {
            name: 'x',
            overrides: [
                { riskId: 'r', field: 'threatCapability', newValue: 0.6 },
                { riskId: 'r', field: 'controlStrength', newValue: 8 },
            ],
        });
        expect(mockDbHolder.db.riskScenario.create).toHaveBeenCalledTimes(1);
    });
});

describe('getScenarioComparison', () => {
    it('computes the comparison for a reader and stores nothing', async () => {
        mockDbHolder.db.riskScenario.findFirst.mockResolvedValue({ id: 's', status: 'SIMULATED', investmentCost: null, overridesJson: [] });
        const r = await getScenarioComparison(noWriteCtx, 's');
        expect(r.delta.meanAleDelta).toBe(0);
        expect(simulatePortfolioMock).toHaveBeenCalledTimes(2);
        // Both runs share the seed simulateScenario uses.
        expect(simulatePortfolioMock.mock.calls.map((c) => c[1])).toEqual([{ seed: 1 }, { seed: 1 }]);
        expect(mockDbHolder.db.riskSimulationRun.create).not.toHaveBeenCalled();
        expect(mockDbHolder.db.riskScenario.update).not.toHaveBeenCalled();
    });

    it('refuses an archived scenario', async () => {
        mockDbHolder.db.riskScenario.findFirst.mockResolvedValue({ id: 's', status: 'ARCHIVED', overridesJson: [] });
        await expect(getScenarioComparison(adminCtx, 's')).rejects.toThrow(/archived/i);
    });

    it('needs read', async () => {
        await expect(getScenarioComparison(noReadCtx, 's')).rejects.toThrow(/permission/i);
    });
});
