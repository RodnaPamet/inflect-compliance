/**
 * RQ-4 — scenario & what-if analysis.
 *
 * Patches the risk portfolio with hypothetical overrides (control
 * investment lowering vulnerability, threat-frequency changes, synthetic
 * new risks) and re-runs the RQ-3 Monte Carlo to compare baseline vs
 * scenario VaR — the decision-support layer (ROI of a security spend).
 *
 * The override application + ROI are PURE (`applyOverrides`, `computeRoi`)
 * — unit-testable without a DB.
 *
 * @module usecases/risk-scenario
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { Prisma } from '@prisma/client';
import { notFound, badRequest } from '@/lib/errors/types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { computeTEF, computeVulnerability, computePLM, computeFairALE, resolveALE, type FairDistributions } from './fair-calculator';
import { simulatePortfolio, type SimRisk, type SimulationResult } from './monte-carlo';
import { isScenarioFairField, scenarioValueRefusal } from '@/lib/risk-scenario-fields';

/** FAIR fields an override may patch. */
export type FairField =
    | 'threatEventFrequency' | 'contactFrequency' | 'probabilityOfAction'
    | 'vulnerabilityProbability' | 'threatCapability' | 'controlStrength'
    | 'primaryLossMagnitude' | 'productivityLoss' | 'responseCost' | 'replacementCost'
    | 'secondaryLossEventFrequency' | 'secondaryLossMagnitude';

export interface ScenarioOverride {
    riskId: string | null;
    synthetic?: boolean;
    fairInputs?: FairDistributions;
    title?: string;
    field?: FairField;
    newValue?: number;
    rationale?: string;
}

/** A risk with the FAIR fields needed to recompute ALE on a field patch. */
export interface ScenarioRisk {
    id: string;
    title: string;
    ale: number;
    distributions?: FairDistributions;
    fair: Partial<Record<FairField, number>>;
}

function recomputeAle(r: ScenarioRisk): number {
    const f = r.fair;
    const tef = f.threatEventFrequency ??
        (f.contactFrequency != null && f.probabilityOfAction != null ? computeTEF(f.contactFrequency, f.probabilityOfAction) : null);
    const vuln = f.vulnerabilityProbability ??
        (f.threatCapability != null && f.controlStrength != null ? computeVulnerability(f.threatCapability, f.controlStrength) : null);
    if (tef == null || vuln == null) return r.ale; // not enough FAIR data — keep legacy ALE
    const plm = computePLM({ productivityLoss: f.productivityLoss, responseCost: f.responseCost, replacementCost: f.replacementCost, flatEstimate: f.primaryLossMagnitude });
    return computeFairALE({ tef, vulnerability: vuln, plm, slef: f.secondaryLossEventFrequency ?? 0, slm: f.secondaryLossMagnitude ?? 0 });
}

/**
 * Apply scenario overrides to a portfolio (pure). Field patches mutate a
 * FAIR field and recompute that risk's ALE; synthetic overrides add a new
 * virtual risk. Throws on a field patch to an unknown risk.
 */
export function applyOverrides(risks: ScenarioRisk[], overrides: ScenarioOverride[]): ScenarioRisk[] {
    const out = risks.map((r) => ({ ...r, fair: { ...r.fair } }));
    const byId = new Map(out.map((r) => [r.id, r]));
    let synthCount = 0;
    for (const ov of overrides) {
        if (ov.synthetic) {
            const id = `synthetic-${synthCount++}`;
            const dist = ov.fairInputs;
            const ale = dist ? computeFairALE({ tef: dist.tef.mode, vulnerability: dist.vulnerability.mode, plm: dist.plm.mode, slef: dist.slef.mode, slm: dist.slm.mode }) : 0;
            out.push({ id, title: ov.title ?? 'Synthetic risk', ale, distributions: dist, fair: {} });
            continue;
        }
        if (!ov.riskId || ov.field == null || ov.newValue == null) continue;
        const target = byId.get(ov.riskId);
        if (!target) throw badRequest(`Override targets unknown risk ${ov.riskId}`);
        target.fair[ov.field] = ov.newValue;
        target.ale = recomputeAle(target);
        // A patched risk's distribution shape is no longer trustworthy — drop
        // it so the sim uses pointToPert(patched ALE).
        target.distributions = undefined;
    }
    return out;
}

/** ROI = (baseline mean ALE − scenario mean ALE) / investment. */
export function computeRoi(baselineMean: number, scenarioMean: number, investment: number | null | undefined): number | null {
    if (!investment || investment <= 0) return null;
    return (baselineMean - scenarioMean) / investment;
}

const toSim = (r: ScenarioRisk): SimRisk => ({ id: r.id, title: r.title, pointAle: r.ale, distributions: r.distributions });

// ── CRUD ──────────────────────────────────────────────────────────────

export interface CreateScenarioInput { name: string; description?: string | null; investmentCost?: number | null; overrides?: ScenarioOverride[] }

/**
 * #4770 — refuse an override the engine would read as nonsense: a field it
 * does not know, a probability outside 0..1, a negative frequency or amount.
 * The page refuses the same values first; this holds every other caller.
 */
const REFUSAL_SENTENCE = {
    NOT_A_NUMBER: 'is not a number',
    NEGATIVE: 'cannot be negative',
    PROBABILITY_RANGE: 'is a probability and must be between 0 and 1',
} as const;

export function assertOverridesValid(overrides: ScenarioOverride[]): void {
    for (const ov of overrides) {
        if (ov.synthetic || ov.field == null) continue;
        if (!isScenarioFairField(ov.field)) throw badRequest(`Unknown FAIR field "${String(ov.field)}"`);
        if (ov.newValue == null) continue;
        const refusal = scenarioValueRefusal(ov.field, ov.newValue);
        if (refusal) throw badRequest(`The value for ${ov.field} ${REFUSAL_SENTENCE[refusal]}`);
    }
}

export async function createScenario(ctx: RequestContext, input: CreateScenarioInput) {
    assertCanWrite(ctx);
    assertOverridesValid(input.overrides ?? []);
    return runInTenantContext(ctx, (db) =>
        db.riskScenario.create({
            data: {
                tenantId: ctx.tenantId,
                name: input.name,
                description: input.description ?? null,
                createdByUserId: ctx.userId,
                investmentCost: input.investmentCost ?? null,
                overridesJson: (input.overrides ?? []) as unknown as Prisma.InputJsonValue,
                status: 'DRAFT',
            },
        }),
    );
}

export async function listScenarios(ctx: RequestContext, opts: { status?: string } = {}) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.riskScenario.findMany({
            where: { tenantId: ctx.tenantId, ...(opts.status ? { status: opts.status } : {}) },
            orderBy: { createdAt: 'desc' },
            take: 200,
        }),
    );
}

export async function getScenario(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    const s = await runInTenantContext(ctx, (db) => db.riskScenario.findFirst({ where: { id, tenantId: ctx.tenantId } }));
    if (!s) throw notFound('Scenario not found');
    return s;
}

export async function archiveScenario(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    await runInTenantContext(ctx, (db) => db.riskScenario.updateMany({ where: { id, tenantId: ctx.tenantId }, data: { status: 'ARCHIVED' } }));
}

export async function cloneScenario(ctx: RequestContext, id: string, newName: string) {
    assertCanWrite(ctx);
    const src = await getScenario(ctx, id);
    return runInTenantContext(ctx, (db) =>
        db.riskScenario.create({
            data: {
                tenantId: ctx.tenantId, name: newName, description: src.description, createdByUserId: ctx.userId,
                investmentCost: src.investmentCost, overridesJson: src.overridesJson as Prisma.InputJsonValue, status: 'DRAFT',
            },
        }),
    );
}

// ── Simulation ────────────────────────────────────────────────────────

export interface ScenarioComparisonResult {
    baseline: SimulationResult;
    scenario: SimulationResult;
    delta: { meanAleDelta: number; varP95Delta: number; varP99Delta: number; roi: number | null };
    perRiskDeltas: Array<{ riskId: string; title: string; baselineAle: number; scenarioAle: number; deltaAle: number; deltaPercent: number }>;
}

async function loadScenarioRisks(ctx: RequestContext): Promise<ScenarioRisk[]> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.risk.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null },
            select: {
                id: true, title: true, fairAle: true, sleAmount: true, aroAmount: true, fairInputsJson: true,
                threatEventFrequency: true, contactFrequency: true, probabilityOfAction: true,
                vulnerabilityProbability: true, threatCapability: true, controlStrength: true,
                primaryLossMagnitude: true, productivityLoss: true, responseCost: true, replacementCost: true,
                secondaryLossEventFrequency: true, secondaryLossMagnitude: true,
            },
            take: 10000,
        }),
    );
    const out: ScenarioRisk[] = [];
    for (const r of rows) {
        const ale = resolveALE({ fairAle: r.fairAle, sleAmount: r.sleAmount, aroAmount: r.aroAmount });
        if (ale == null) continue;
        out.push({
            id: r.id, title: r.title, ale,
            distributions: parseDist(r.fairInputsJson),
            fair: {
                threatEventFrequency: r.threatEventFrequency ?? undefined, contactFrequency: r.contactFrequency ?? undefined,
                probabilityOfAction: r.probabilityOfAction ?? undefined, vulnerabilityProbability: r.vulnerabilityProbability ?? undefined,
                threatCapability: r.threatCapability ?? undefined, controlStrength: r.controlStrength ?? undefined,
                primaryLossMagnitude: r.primaryLossMagnitude ?? undefined, productivityLoss: r.productivityLoss ?? undefined,
                responseCost: r.responseCost ?? undefined, replacementCost: r.replacementCost ?? undefined,
                secondaryLossEventFrequency: r.secondaryLossEventFrequency ?? undefined, secondaryLossMagnitude: r.secondaryLossMagnitude ?? undefined,
            },
        });
    }
    return out;
}

function parseDist(json: unknown): FairDistributions | undefined {
    if (!json || typeof json !== 'object') return undefined;
    const j = json as Record<string, { min: number } | undefined>;
    const need = ['tef', 'vulnerability', 'plm', 'slef', 'slm'] as const;
    if (!need.every((k) => j[k] && typeof j[k]!.min === 'number')) return undefined;
    return json as FairDistributions;
}

/** Same seed for both runs, so the difference reflects the overrides, not RNG noise. */
const SCENARIO_SEED = 1;

/**
 * The comparison of a scenario against the portfolio as it is now. Writes
 * nothing: `simulateScenario` persists it, `getScenarioComparison` returns it.
 */
async function compareScenario(
    ctx: RequestContext,
    scenario: { overridesJson: unknown; investmentCost: number | null },
): Promise<ScenarioComparisonResult> {
    const overrides = (scenario.overridesJson ?? []) as unknown as ScenarioOverride[];
    const baselineRisks = await loadScenarioRisks(ctx);
    const scenarioRisks = applyOverrides(baselineRisks, overrides);

    const seed = SCENARIO_SEED;
    const baseline = simulatePortfolio(baselineRisks.map(toSim), { seed });
    const scenarioResult = simulatePortfolio(scenarioRisks.map(toSim), { seed });

    const roi = computeRoi(baseline.portfolioAle.mean, scenarioResult.portfolioAle.mean, scenario.investmentCost);

    const baseAleById = new Map(baselineRisks.map((r) => [r.id, r.ale]));
    const perRiskDeltas = scenarioRisks
        .filter((r) => baseAleById.has(r.id))
        .map((r) => {
            const b = baseAleById.get(r.id)!;
            return { riskId: r.id, title: r.title, baselineAle: b, scenarioAle: r.ale, deltaAle: r.ale - b, deltaPercent: b > 0 ? ((r.ale - b) / b) * 100 : 0 };
        })
        .filter((d) => d.deltaAle !== 0);

    return {
        baseline, scenario: scenarioResult,
        delta: {
            meanAleDelta: scenarioResult.portfolioAle.mean - baseline.portfolioAle.mean,
            varP95Delta: scenarioResult.portfolioAle.p95 - baseline.portfolioAle.p95,
            varP99Delta: scenarioResult.portfolioAle.p99 - baseline.portfolioAle.p99,
            roi,
        },
        perRiskDeltas,
    };
}

/**
 * #4770 — reopen a scenario's comparison without running it again.
 *
 * A read: it computes the comparison with the same seed `simulateScenario`
 * uses and stores nothing, so a reader can see it and a reload can show it
 * again. It is computed against the portfolio as it is now, which is the same
 * result as the last run unless the risks have changed since.
 */
export async function getScenarioComparison(ctx: RequestContext, scenarioId: string): Promise<ScenarioComparisonResult> {
    assertCanRead(ctx);
    const scenario = await getScenario(ctx, scenarioId);
    if (scenario.status === 'ARCHIVED') throw badRequest('An archived scenario has no comparison');
    return compareScenario(ctx, scenario);
}

export async function simulateScenario(ctx: RequestContext, scenarioId: string): Promise<ScenarioComparisonResult> {
    assertCanWrite(ctx);
    const scenario = await getScenario(ctx, scenarioId);
    if (scenario.status === 'ARCHIVED') throw badRequest('Cannot simulate an archived scenario');

    const comparison = await compareScenario(ctx, scenario);
    const scenarioResult = comparison.scenario;
    const roi = comparison.delta.roi;
    const seed = SCENARIO_SEED;

    // Persist the scenario run + link it.
    await runInTenantContext(ctx, async (db) => {
        const run = await db.riskSimulationRun.create({
            data: {
                tenantId: ctx.tenantId, triggeredBy: 'scenario', createdByUserId: ctx.userId, iterations: scenarioResult.iterationsRun, seed,
                portfolioMean: scenarioResult.portfolioAle.mean, portfolioP50: scenarioResult.portfolioAle.median,
                // P2 — persist P80 like the baseline path (was omitted, which
                // is what blanked the dashboard when a scenario run leaked in
                // as "latest"; now belt-and-braces with the scope fix).
                portfolioP80: scenarioResult.portfolioAle.p80,
                portfolioP90: scenarioResult.portfolioAle.p90, portfolioP95: scenarioResult.portfolioAle.p95,
                portfolioP99: scenarioResult.portfolioAle.p99, portfolioStdDev: scenarioResult.portfolioAle.stdDev,
                lecPointsJson: scenarioResult.lossExceedanceCurve as unknown as Prisma.InputJsonValue,
                perRiskResultsJson: scenarioResult.perRisk as unknown as Prisma.InputJsonValue,
                executionMs: scenarioResult.executionMs, status: 'COMPLETED', completedAt: new Date(),
            },
        });
        await db.riskScenario.update({
            where: { id: scenarioId },
            data: { resultRunId: run.id, status: 'SIMULATED', computedRoi: roi },
        });
    });

    return comparison;
}
