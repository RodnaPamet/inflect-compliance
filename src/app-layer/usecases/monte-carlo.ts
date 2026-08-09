/**
 * RQ-3 — Monte Carlo simulation engine.
 *
 * Samples each risk's ALE from its FAIR PERT distributions (RQ-1) across
 * thousands of iterations to produce a portfolio loss distribution,
 * percentiles / VaR, a loss-exceedance curve, and per-risk contribution —
 * the stochastic analysis boards + actuaries expect.
 *
 * The simulation MATH is pure (`simulatePortfolio`) — unit-testable with a
 * seed, no DB. `runSimulation` is the DB wrapper (load risks → simulate →
 * persist a RiskSimulationRun).
 *
 * @module usecases/monte-carlo
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { Prisma } from '@prisma/client';
import { badRequest } from '@/lib/errors/types';
import { assertCanRead } from '../policies/common';
import {
    seededRng,
    sampleFairALE,
    computeFairALE,
    pointToPert,
    resolveALE,
    type FairDistributions,
    type PertDistribution,
} from './fair-calculator';
import { parsePerRiskResults, type RiskTailPercentiles } from '@/lib/risk/per-risk-results';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const MAX_ITERATIONS = 100_000;
export const DEFAULT_ITERATIONS = 10_000;

/** Mulberry32 seeded PRNG (re-exported from the FAIR core for reproducibility). */
export const createPRNG = seededRng;

/**
 * Triangular inverse-CDF sample of a PERT triple from a uniform variate.
 * u=0 → min, u=1 → max, u at the mode-CDF → mode. Used for point-estimate
 * risks + the RQ-8 correlated-sampling path (uniform from Cholesky).
 */
export function samplePert(dist: PertDistribution, u: number): number {
    const { min, mode, max } = dist;
    if (max <= min) return min;
    if (u <= 0) return min;
    if (u >= 1) return max;
    const fc = (mode - min) / (max - min);
    if (u < fc) return min + Math.sqrt(u * (max - min) * (mode - min));
    return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

export interface SimRisk {
    id: string;
    title: string;
    /** Point ALE (resolveALE) — used when `distributions` is absent. */
    pointAle: number;
    /** Full PERT distributions (from fairInputsJson) — preferred. */
    distributions?: FairDistributions;
}

export interface SimulationConfig {
    iterations?: number;
    confidenceLevels?: number[];
    seed?: number;
    /** RQ-8 — NxN correlation matrix aligned to `risks` order. When set,
     *  each iteration draws correlated uniforms (Cholesky) and samples every
     *  risk's ALE via the single-uniform PERT path. */
    correlationMatrix?: number[][];
}

// ── RQ-8 — correlated sampling (Cholesky) ─────────────────────────────

/** Standard-normal CDF (Abramowitz–Stegun 7.1.26 erf approximation). */
function normalCdf(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
}

/**
 * Cholesky decomposition of a symmetric positive-definite matrix Σ → lower
 * triangular L with L·Lᵀ = Σ. Throws if the matrix is not positive-definite.
 */
export function choleskyDecompose(matrix: number[][]): number[][] {
    const n = matrix.length;
    const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = 0;
            for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
            if (i === j) {
                const d = matrix[i][i] - sum;
                if (d <= 1e-12) throw badRequest('Matrix is not positive-definite (Cholesky failed)');
                L[i][j] = Math.sqrt(d);
            } else {
                L[i][j] = (matrix[i][j] - sum) / L[j][j];
            }
        }
    }
    return L;
}

/** Two independent standard normals via Box–Muller. */
function boxMuller(rng: () => number): [number, number] {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

/**
 * Generate a vector of correlated uniform variates from a Cholesky factor L:
 * draw independent normals Z, correlate via X = L·Z, map to uniforms via Φ.
 */
export function generateCorrelatedUniforms(L: number[][], rng: () => number): number[] {
    const n = L.length;
    const z: number[] = [];
    while (z.length < n) { const [a, b] = boxMuller(rng); z.push(a); if (z.length < n) z.push(b); }
    const u: number[] = [];
    for (let i = 0; i < n; i++) {
        let x = 0;
        for (let k = 0; k <= i; k++) x += L[i][k] * z[k];
        u.push(normalCdf(x));
    }
    return u;
}

/**
 * RQ-8 — sample a FULL FAIR ALE (all five factors, not just PLM) from a
 * single correlated uniform `u`. Each factor is drawn via the triangular
 * inverse-CDF at `u`, then `computeFairALE` combines them.
 *
 * This is a one-common-factor Gaussian copula: the cross-risk dependence is
 * carried by `u` (from the Cholesky factor), while the factors WITHIN a risk
 * move comonotonically with that risk's draw. That within-risk comonotonicity
 * is a deliberate simplification — it preserves the full TEF×Vuln×PLM + SLEF×SLM
 * structure (strictly more complete than the previous PLM-only correlated path)
 * without a per-(risk×factor) Cholesky. A future factor model could decompose
 * each loss into systematic + idiosyncratic to also preserve marginals exactly.
 */
export function sampleFairALEFromUniform(d: FairDistributions, u: number): number {
    return computeFairALE({
        tef: samplePert(d.tef, u),
        vulnerability: clamp01(samplePert(d.vulnerability, u)),
        plm: samplePert(d.plm, u),
        slef: clamp01(samplePert(d.slef, u)),
        slm: samplePert(d.slm, u),
    });
}

export interface SimulationResult {
    portfolioAle: { mean: number; median: number; p80: number; p90: number; p95: number; p99: number; stdDev: number; min: number; max: number };
    /** RQ3-1 — per-risk tail percentiles (P50/P90/P95) are the data
     *  spine for tail-aware ranking, board reporting, and the
     *  portfolio percentile views. Sampled when the portfolio is
     *  ≤ 200 risks; mean-only fallback otherwise. */
    perRisk: Array<{ riskId: string; title: string; aleMean: number; aleP50: number; aleP90: number; aleP95: number; contribution: number }>;
    lossExceedanceCurve: Array<{ threshold: number; probability: number }>;
    convergenceDelta: number;
    iterationsRun: number;
    executionMs: number;
    /**
     * True when a correlation matrix WAS supplied but could not be
     * Cholesky-decomposed (non-PSD) — the sim silently fell back to
     * independent sampling. Surfaced so the UI can tell the operator the
     * correlations they configured were dropped, rather than pretending
     * they were applied. (RQ-8 / PR-L.)
     */
    correlationsDropped: boolean;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
    return sorted[idx];
}

/** Pure Monte Carlo over a fixed risk set. Deterministic for a given seed. */
export function simulatePortfolio(risks: SimRisk[], config: SimulationConfig = {}): SimulationResult {
    const start = Date.now();
    const iterations = Math.min(MAX_ITERATIONS, Math.max(1, config.iterations ?? DEFAULT_ITERATIONS));
    const rng = createPRNG(config.seed ?? 1);

    if (risks.length === 0) {
        return {
            portfolioAle: { mean: 0, median: 0, p80: 0, p90: 0, p95: 0, p99: 0, stdDev: 0, min: 0, max: 0 },
            perRisk: [], lossExceedanceCurve: [], convergenceDelta: 0, iterationsRun: iterations, executionMs: Date.now() - start,
            correlationsDropped: false,
        };
    }

    const portfolioLosses = new Float64Array(iterations);
    const perRiskSum = new Array(risks.length).fill(0);
    // Per-risk samples kept only for modest portfolios (for p95); else mean-only.
    const keepPerRisk = risks.length <= 200;
    const perRiskSamples: number[][] = keepPerRisk ? risks.map(() => []) : [];
    let runningSum = 0;
    const tail = Math.min(1000, iterations);
    let tailSum = 0;

    // RQ-8 — when a correlation matrix is supplied (and well-formed), drive each
    // risk's draw from a Cholesky-correlated uniform so risks co-materialise.
    // FAIR risks sample their FULL factor set from that uniform
    // (sampleFairALEFromUniform); point-only risks use the single-uniform PERT.
    // Falls back to independent sampling if Cholesky fails.
    let cholesky: number[][] | null = null;
    const correlationRequested = !!(config.correlationMatrix && config.correlationMatrix.length === risks.length && risks.length > 0);
    if (correlationRequested) {
        try { cholesky = choleskyDecompose(config.correlationMatrix!); } catch { cholesky = null; }
    }
    // Correlations were requested but the matrix was non-PSD → we dropped
    // them and sampled independently. Report it instead of hiding it.
    const correlationsDropped = correlationRequested && cholesky === null;

    for (let i = 0; i < iterations; i++) {
        let loss = 0;
        const u = cholesky ? generateCorrelatedUniforms(cholesky, rng) : null;
        for (let r = 0; r < risks.length; r++) {
            const risk = risks[r];
            const ale = u
                ? risk.distributions
                    ? sampleFairALEFromUniform(risk.distributions, u[r])
                    : samplePert(pointToPert(risk.pointAle, 0.2), u[r])
                : risk.distributions
                    ? sampleFairALE(risk.distributions, rng)
                    : samplePert(pointToPert(risk.pointAle, 0.2), rng());
            loss += ale;
            perRiskSum[r] += ale;
            if (keepPerRisk) perRiskSamples[r].push(ale);
        }
        portfolioLosses[i] = loss;
        runningSum += loss;
        if (i >= iterations - tail) tailSum += loss;
    }

    const sorted = Array.from(portfolioLosses).sort((a, b) => a - b);
    const mean = runningSum / iterations;
    const variance = sorted.reduce((s, v) => s + (v - mean) * (v - mean), 0) / iterations;
    const stdDev = Math.sqrt(variance);

    const perRisk = risks.map((risk, r) => {
        const aleMean = perRiskSum[r] / iterations;
        // RQ3-1 — the full tail trio. Mean-only fallback for very
        // large portfolios keeps memory bounded; consumers treat
        // p50 === p90 === mean as "no tail data".
        let aleP50 = aleMean;
        let aleP90 = aleMean;
        let aleP95 = aleMean;
        if (keepPerRisk) {
            const s = perRiskSamples[r].sort((a, b) => a - b);
            aleP50 = percentile(s, 0.5);
            aleP90 = percentile(s, 0.9);
            aleP95 = percentile(s, 0.95);
        }
        return { riskId: risk.id, title: risk.title, aleMean, aleP50, aleP90, aleP95, contribution: mean > 0 ? aleMean / mean : 0 };
    }).sort((a, b) => b.aleMean - a.aleMean);

    // Loss exceedance curve — 20 thresholds spanning [p50, max].
    const lossExceedanceCurve: Array<{ threshold: number; probability: number }> = [];
    const lo = percentile(sorted, 0.5);
    const hi = sorted[sorted.length - 1];
    const steps = 20;
    for (let k = 0; k <= steps; k++) {
        const threshold = lo + ((hi - lo) * k) / steps;
        // P(loss >= threshold) via binary-ish count on sorted ascending.
        let count = 0;
        for (let j = sorted.length - 1; j >= 0 && sorted[j] >= threshold; j--) count++;
        lossExceedanceCurve.push({ threshold, probability: count / sorted.length });
    }

    const tailMean = tailSum / tail;
    const convergenceDelta = mean > 0 ? Math.abs(tailMean - mean) / mean : 0;

    return {
        portfolioAle: {
            mean, median: percentile(sorted, 0.5), p80: percentile(sorted, 0.8), p90: percentile(sorted, 0.9),
            p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), stdDev,
            min: sorted[0], max: sorted[sorted.length - 1],
        },
        perRisk, lossExceedanceCurve, convergenceDelta, iterationsRun: iterations, executionMs: Date.now() - start,
        correlationsDropped,
    };
}

// ── DB-backed simulation ──────────────────────────────────────────────

/** Load the tenant's quantified risks as SimRisk[] (FAIR dists or point ALE). */
async function loadSimRisks(ctx: RequestContext): Promise<SimRisk[]> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.risk.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, title: true, fairAle: true, sleAmount: true, aroAmount: true, fairInputsJson: true },
            take: 10000,
        }),
    );
    const out: SimRisk[] = [];
    for (const r of rows) {
        const point = resolveALE({ fairAle: r.fairAle, sleAmount: r.sleAmount, aroAmount: r.aroAmount });
        const dists = parseDistributions(r.fairInputsJson);
        if (point == null && !dists) continue; // not quantified
        out.push({ id: r.id, title: r.title, pointAle: point ?? 0, distributions: dists });
    }
    return out;
}

/** Parse fairInputsJson into FairDistributions if it carries all 5 factors. */
function parseDistributions(json: unknown): FairDistributions | undefined {
    if (!json || typeof json !== 'object') return undefined;
    const j = json as Record<string, PertDistribution | undefined>;
    const need = ['tef', 'vulnerability', 'plm', 'slef', 'slm'] as const;
    if (!need.every((k) => j[k] && typeof j[k]!.min === 'number')) return undefined;
    return { tef: j.tef!, vulnerability: j.vulnerability!, plm: j.plm!, slef: j.slef!, slm: j.slm! };
}

/**
 * RQ3-3 — load the tenant's stored pairwise correlations (RQ-8) as an
 * NxN matrix aligned to the simulated risk order. Returns undefined
 * when no non-zero pair touches the simulated risks (identity matrix
 * — independent sampling is equivalent and cheaper) or when the
 * portfolio exceeds the matrix cap (Cholesky is O(n³); 500 matches
 * the correlation-page bound).
 */
async function loadStoredCorrelationMatrix(
    ctx: RequestContext,
    riskIds: string[],
): Promise<number[][] | undefined> {
    if (riskIds.length === 0 || riskIds.length > 500) return undefined;
    const pairs = await runInTenantContext(ctx, (db) =>
        db.riskCorrelation.findMany({
            where: { tenantId: ctx.tenantId },
            select: { riskAId: true, riskBId: true, coefficient: true },
            take: 50000,
        }),
    );
    const idx = new Map(riskIds.map((id, i) => [id, i]));
    const n = riskIds.length;
    let any = false;
    const matrix: number[][] = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j): number => (i === j ? 1 : 0)),
    );
    for (const p of pairs) {
        const i = idx.get(p.riskAId);
        const j = idx.get(p.riskBId);
        if (i == null || j == null || p.coefficient === 0) continue;
        matrix[i][j] = p.coefficient;
        matrix[j][i] = p.coefficient;
        any = true;
    }
    return any ? matrix : undefined;
}

/** Run + persist a simulation. Returns the result + the run id. */
export async function runSimulation(
    ctx: RequestContext,
    config: SimulationConfig = {},
): Promise<SimulationResult & { runId: string }> {
    assertCanRead(ctx);
    const risks = await loadSimRisks(ctx);
    // RQ3-3 — stored correlations apply by default; an explicit
    // matrix (scenario engine) still wins.
    const correlationMatrix =
        config.correlationMatrix ??
        (await loadStoredCorrelationMatrix(ctx, risks.map((r) => r.id)));
    const result = simulatePortfolio(risks, { ...config, correlationMatrix });
    const run = await runInTenantContext(ctx, (db) =>
        db.riskSimulationRun.create({
            data: {
                tenantId: ctx.tenantId,
                triggeredBy: 'manual',
                createdByUserId: ctx.userId,
                iterations: result.iterationsRun,
                seed: config.seed ?? null,
                portfolioMean: result.portfolioAle.mean,
                portfolioP50: result.portfolioAle.median,
                portfolioP80: result.portfolioAle.p80,
                portfolioP90: result.portfolioAle.p90,
                portfolioP95: result.portfolioAle.p95,
                portfolioP99: result.portfolioAle.p99,
                portfolioStdDev: result.portfolioAle.stdDev,
                perRiskResultsJson: result.perRisk as unknown as Prisma.InputJsonValue,
                lecPointsJson: result.lossExceedanceCurve as unknown as Prisma.InputJsonValue,
                convergenceDelta: result.convergenceDelta,
                executionMs: result.executionMs,
                correlationsDropped: result.correlationsDropped,
                status: 'COMPLETED',
                completedAt: new Date(),
            },
        }),
    );
    return { ...result, runId: run.id };
}

/**
 * Most recent COMPLETED *baseline* simulation for the dashboard.
 *
 * P2 — scenario runs (`triggeredBy: 'scenario'`) are what-if projections,
 * NOT the portfolio's live position. They were leaking in here: a scenario
 * run is COMPLETED and newer, so it became "the latest simulation" and
 * blanked the Dashboard MonteCarloPanel + the Board P80 headline (scenario
 * runs historically omitted `portfolioP80`). Scope this to baseline runs
 * (`manual` / `scheduled`) so running a what-if can never alter the
 * executive dashboard.
 */
export async function getLatestSimulation(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.riskSimulationRun.findFirst({
            where: {
                tenantId: ctx.tenantId,
                status: 'COMPLETED',
                triggeredBy: { not: 'scenario' },
            },
            orderBy: { createdAt: 'desc' },
        }),
    );
}

// ── RQ3-1 — per-risk tail-percentile cache ────────────────────────────

export type { RiskTailPercentiles };

export interface PerRiskPercentilesSnapshot {
    runId: string;
    completedAt: Date | null;
    byRisk: Record<string, RiskTailPercentiles>;
}

/**
 * The cached per-risk tail percentiles from the latest COMPLETED
 * simulation run — the data spine for tail-aware ranking (RQ3-4),
 * portfolio percentile views (RQ3-3), and the board page (RQ3-10).
 * Pre-RQ3-1 runs (no aleP50/aleP90 in the JSON) degrade gracefully:
 * missing percentiles fall back to the persisted mean, which
 * consumers can read as "no tail data, re-run the simulation".
 * Returns null when no completed run exists.
 */
export async function getPerRiskPercentiles(
    ctx: RequestContext,
): Promise<PerRiskPercentilesSnapshot | null> {
    const run = await getLatestSimulation(ctx);
    if (!run) return null;
    // B2-6 — the validation this function used to inline now lives in
    // `@/lib/risk/per-risk-results`, shared with the report + board reads
    // that each had their own weaker copy.
    const byRisk = parsePerRiskResults(run.perRiskResultsJson);
    return { runId: run.id, completedAt: run.completedAt, byRisk };
}
