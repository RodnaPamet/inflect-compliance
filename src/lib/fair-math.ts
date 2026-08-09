/**
 * RQ-1 — FAIR (Factor Analysis of Information Risk) calculation core.
 *
 * Pure, stateless functions — no DB, no IO. The mathematical foundation
 * every downstream quantitative feature (Monte Carlo RQ-3, scenarios
 * RQ-4, correlation RQ-8, VaR reporting RQ-10) builds on.
 *
 * FAIR ontology:
 *   ALE = LEF × (PLM + SLEF × SLM)
 *   LEF (Loss Event Frequency) = TEF × Vulnerability
 *   TEF (Threat Event Frequency) = ContactFrequency × ProbabilityOfAction
 *   Vulnerability = P(threat capability exceeds control strength)
 *
 * @module usecases/fair-calculator
 */

// ── Point-estimate calculations ──────────────────────────────────────

/** Loss Event Frequency = Threat Event Frequency × Vulnerability. */
export function computeLEF(tef: number, vuln: number): number {
    return tef * vuln;
}

/**
 * Primary Loss Magnitude. Sum of the decomposed components when any are
 * given; otherwise the flat estimate. Returns 0 when nothing is set.
 */
export function computePLM(components: {
    productivityLoss?: number | null;
    responseCost?: number | null;
    replacementCost?: number | null;
    flatEstimate?: number | null;
}): number {
    const { productivityLoss, responseCost, replacementCost, flatEstimate } = components;
    const parts = [productivityLoss, responseCost, replacementCost].filter(
        (v): v is number => typeof v === 'number',
    );
    if (parts.length > 0) return parts.reduce((a, b) => a + b, 0);
    return flatEstimate ?? 0;
}

/** Full FAIR ALE = LEF × (PLM + SLEF × SLM). */
export function computeFairALE(params: {
    tef: number;
    vulnerability: number;
    plm: number;
    slef: number;
    slm: number;
}): number {
    const lef = computeLEF(params.tef, params.vulnerability);
    return lef * (params.plm + params.slef * params.slm);
}

/** Threat Event Frequency = contact frequency × probability of action. */
export function computeTEF(cf: number, poa: number): number {
    return cf * poa;
}

/**
 * Vulnerability (0..1) — the probability a threat event becomes a loss
 * event, approximated from the threat-capability vs control-strength
 * balance on 1..10 scales: `tc / (tc + cs)`. Monotonic, bounded, and
 * 0.5 at parity. (RQ-3 replaces this with a distributional comparison.)
 */
export function computeVulnerability(tc: number, cs: number): number {
    if (tc <= 0 && cs <= 0) return 0;
    return clamp01(tc / (tc + cs));
}

// ── Distribution-aware calculations (Monte Carlo RQ-3) ────────────────

export interface PertDistribution {
    min: number;
    mode: number;
    max: number;
}

export interface FairDistributions {
    tef: PertDistribution;
    vulnerability: PertDistribution; // bounded 0..1
    plm: PertDistribution;
    slef: PertDistribution; // bounded 0..1
    slm: PertDistribution;
}

/** Sample one ALE from PERT distributions (one Monte Carlo iteration). */
export function sampleFairALE(distributions: FairDistributions, rng: () => number): number {
    const tef = samplePert(distributions.tef, rng);
    const vuln = clamp01(samplePert(distributions.vulnerability, rng));
    const plm = samplePert(distributions.plm, rng);
    const slef = clamp01(samplePert(distributions.slef, rng));
    const slm = samplePert(distributions.slm, rng);
    return computeFairALE({ tef, vulnerability: vuln, plm, slef, slm });
}

/** Auto-generate a ±spread PERT range around a point estimate. */
export function pointToPert(value: number, spread = 0.2): PertDistribution {
    return { min: value * (1 - spread), mode: value, max: value * (1 + spread) };
}

/**
 * RQ3-2 — the Beta-PERT mean: (min + 4·mode + max) / 6. The derived
 * point estimate the UI SHOWS (never asks for) once inputs are
 * calibrated ranges. Degenerate triples (min = mode = max) collapse
 * to the point value, which is what makes the migration of legacy
 * point estimates a true round-trip.
 */
export function pertMean(d: PertDistribution): number {
    return (d.min + 4 * d.mode + d.max) / 6;
}

// ── Backward compatibility ────────────────────────────────────────────

/** Legacy ALE = SLE × ARO. Used when FAIR fields are absent. */
export function computeLegacyALE(sle: number, aro: number): number {
    return sle * aro;
}

/**
 * Unified ALE resolver: FAIR ALE if present, else legacy SLE×ARO, else
 * null. Makes analytics transparent to whether a risk has adopted FAIR.
 *
 * The null is load-bearing — it means "not quantified", which every
 * caller must render as absence rather than as zero. A zero on a money
 * column reads as "we measured this and it is nil".
 */
export function resolveALE(risk: {
    fairAle: number | null;
    sleAmount: number | null;
    aroAmount: number | null;
}): number | null {
    if (risk.fairAle != null) return risk.fairAle;
    if (risk.sleAmount != null && risk.aroAmount != null) {
        return computeLegacyALE(risk.sleAmount, risk.aroAmount);
    }
    return null;
}


// ── PERT (Beta-PERT) sampling internals ──────────────────────────────

/** Deterministic mulberry32 PRNG — seed for reproducible simulations. */
export function seededRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Sample a Beta-PERT distribution scaled to [min, max]. */
function samplePert(p: PertDistribution, rng: () => number): number {
    const range = p.max - p.min;
    if (range <= 0) return p.mode;
    const alpha = 1 + (4 * (p.mode - p.min)) / range;
    const beta = 1 + (4 * (p.max - p.mode)) / range;
    return p.min + sampleBeta(alpha, beta, rng) * range;
}

function sampleBeta(a: number, b: number, rng: () => number): number {
    const ga = sampleGamma(a, rng);
    const gb = sampleGamma(b, rng);
    return ga / (ga + gb || 1);
}

/** Marsaglia–Tsang gamma sampler (shape k ≥ 1, which PERT alpha/beta satisfy). */
function sampleGamma(k: number, rng: () => number): number {
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    // Bounded iteration count keeps this deterministic + non-hanging.
    for (let i = 0; i < 1000; i++) {
        let x: number;
        let v: number;
        do {
            x = sampleNormal(rng);
            v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = rng();
        if (u < 1 - 0.0331 * x * x * x * x) return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
    return d; // fallback (vanishingly rare)
}

function sampleNormal(rng: () => number): number {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp01(v: number): number {
    return Math.min(1, Math.max(0, v));
}
