/**
 * The agent BEHAVIOUR FINGERPRINT — a nightly, per-agent, per-day detector
 * (Morpheus roadmap Phase 1, decision D-L1-3: a CPU detector in the worker
 * before Morpheus DFP).
 *
 * The circuit breaker (`circuit-breaker.ts`) judges an agent HOUR BY HOUR on
 * three signals, lazily, on the agent's own next call. This judges it DAY BY
 * DAY on a wider fingerprint, from the worker, after the day has closed. The
 * two answer different questions — "is this agent doing something different
 * right now" and "was yesterday unlike this agent's normal day" — and share
 * one response: a high enough score here latches the SAME breaker, through
 * `latchOnBehaviourAnomaly`, never a second one.
 *
 * ## This file is PURE, and the day is an argument
 *
 * No clock, no I/O, no Prisma. `usecases/agent-behaviour-fingerprint.ts` reads
 * the ledger and hands this file numbers; this file hands back a verdict.
 * The first question asked of any finding it raises is "would yesterday's
 * numbers have raised it", and only a pure function can answer that.
 *
 * ## The features are COUNTS — never content
 *
 * Every feature is a count or a sum of counts over columns named in
 * `FINGERPRINT_SOURCE_COLUMNS`. The guard
 * `tests/guards/agent-behaviour-fingerprint-content-free.test.ts` refuses a
 * column there that could carry content (any String that is not an identifier,
 * any encrypted field), and refuses any other column of those tables in the
 * ledger read. That allowlist is what keeps this a behaviour detector and
 * not a content reader (roadmap hardening G10).
 *
 * ## The statistic: rolling mean and σ, upward only
 *
 * The roadmap's Phase 0 names "a rolling mean/σ per feature", and this is that,
 * with three suppressions borrowed from the breaker's false-positive lessons:
 *
 *   1. NO VERDICT WITHOUT A BASELINE. Fewer than `BASELINE_MIN_DAYS` active
 *      baseline days is `LEARNING` — a recorded verdict, never a finding.
 *   2. A σ FLOOR. A flat history has σ = 0, and every deviation from it is an
 *      infinite z. The floor (`max(SD_FLOOR_ABSOLUTE, SD_FLOOR_RATIO × mean)`)
 *      turns "an agent that read exactly 10 things every day reads 11" back
 *      into the non-event it is.
 *   3. AN ABSOLUTE DELTA PER FEATURE. A z alone fires on every quiet agent
 *      (2 → 6 is a tripling); a feature contributes only when it also moved by
 *      at least its `MIN_ABSOLUTE_DELTA`.
 *
 * Only UPWARD departures score. An agent that did less than usual is not a
 * threat this control exists for; an agent that went quiet needs no stop.
 *
 * ## A detector must not learn from the anomaly
 *
 * A day judged anomalous is stored with `inBaseline = false` and never enters
 * a later day's baseline — otherwise the first tripled day makes tripling
 * normal and the second one scores nothing. A LEARNING day does enter it: it is
 * the baseline being built.
 *
 * A change a PERSON accepted is the exception, and it is the breaker's own:
 * closing it `ACCEPTED_NEW_BASELINE` advances `baselineEpoch`, and days before
 * that epoch leave the fingerprint's baseline too (`personSetBaselineEpoch`,
 * `baselineDaysSinceEpoch`), so the agent re-learns from LEARNING.
 */

// ─── Vocabulary ─────────────────────────────────────────────────────

/**
 * The fingerprint, in a stable order. Each is a per-agent, per-UTC-day count.
 *
 *   readCalls         authorized read-class tool calls (AgentBehaviourWindow)
 *   proposeCalls      authorized propose-class tool calls
 *   orchestrateCalls  authorized orchestrate-class tool calls
 *   activeHours       hours in the day with at least one authorized call
 *   proposals         proposals the agent filed (AgentProposal)
 *   guardFlags        of those, the ones the output guard FLAGGED or QUARANTINED
 *   modelCalls        AI decision-log rows attributed to the agent (AiDecisionLog)
 *   tokens            tokensIn + tokensOut over those rows
 *
 * Written into anomaly rows and metric labels, so a member is never renamed.
 */
export const FINGERPRINT_FEATURES = [
    'readCalls',
    'proposeCalls',
    'orchestrateCalls',
    'activeHours',
    'proposals',
    'guardFlags',
    'modelCalls',
    'tokens',
] as const;
export type FingerprintFeature = (typeof FINGERPRINT_FEATURES)[number];
export type FingerprintFeatures = Readonly<Record<FingerprintFeature, number>>;

/**
 * The ONLY columns the fingerprint reads, per model. The ledger read
 * (`usecases/agent-behaviour-fingerprint-ledger.ts`) may name no other column
 * of these tables, and the content-free guard checks both that file against
 * this list and this list against the Prisma datamodel: an identifier or a
 * count, an enum, a timestamp — never a free-text String, never an encrypted
 * field.
 *
 * A model or column added here is a reviewed widening of what the detector may
 * see.
 */
export const FINGERPRINT_SOURCE_COLUMNS = {
    AgentBehaviourWindow: ['tenantId', 'agentId', 'windowStart', 'readCalls', 'proposeCalls', 'orchestrateCalls'],
    AgentProposal: ['tenantId', 'agentId', 'createdAt', 'guardVerdict'],
    AiDecisionLog: ['tenantId', 'agentId', 'createdAt', 'tokensIn', 'tokensOut'],
} as const;
export type FingerprintSourceModel = keyof typeof FINGERPRINT_SOURCE_COLUMNS;

/** The proposal guard verdicts counted as a guard flag. */
export const GUARD_FLAG_VERDICTS = ['FLAGGED', 'QUARANTINED'] as const;

/**
 * The verdict for one agent-day.
 *
 *   LEARNING   — too little baseline to judge. Recorded, never raised.
 *   STEADY     — judged, below threshold A.
 *   ANOMALOUS  — judged, at or above threshold A.
 */
export const FINGERPRINT_VERDICTS = ['LEARNING', 'STEADY', 'ANOMALOUS'] as const;
export type FingerprintVerdict = (typeof FINGERPRINT_VERDICTS)[number];

/**
 * What an ANOMALOUS day does.
 *
 *   FINDING — threshold A: a finding on the agent, for a person to read.
 *   LATCH   — threshold B: the finding, AND the existing circuit breaker
 *             latched OPEN with `BEHAVIOUR_ANOMALY` (when the operator has
 *             turned the latch on). A person closes it, as for every trip.
 */
export const ANOMALY_TIERS = ['FINDING', 'LATCH'] as const;
export type AnomalyTier = (typeof ANOMALY_TIERS)[number];

// ─── Thresholds ─────────────────────────────────────────────────────

/** Active baseline days required before any judgement. Two weeks of a daily agent. */
export const BASELINE_MIN_DAYS = 14;
/** The most recent baseline days the mean and σ are computed over. */
export const BASELINE_MAX_DAYS = 28;
/**
 * How far back a baseline day may be. An agent active twice a month would
 * otherwise judge today against last year.
 */
export const BASELINE_LOOKBACK_DAYS = 90;

/** Threshold A: a z at or above this raises a finding. */
export const Z_FINDING = 4;
/** Threshold B: a z at or above this latches the breaker (when the latch is on). */
export const Z_LATCH = 8;

/** σ floor: never below this many units… */
export const SD_FLOOR_ABSOLUTE = 1;
/** …nor below this share of the mean. */
export const SD_FLOOR_RATIO = 0.1;

/**
 * The smallest upward move each feature must make to contribute, whatever its
 * z. Tokens move in thousands; hours move in ones.
 */
export const MIN_ABSOLUTE_DELTA: FingerprintFeatures = Object.freeze({
    readCalls: 20,
    proposeCalls: 5,
    orchestrateCalls: 5,
    activeHours: 4,
    proposals: 5,
    guardFlags: 3,
    modelCalls: 20,
    tokens: 20_000,
});

// ─── Scoring ────────────────────────────────────────────────────────

export interface FeatureReading {
    readonly feature: FingerprintFeature;
    readonly observed: number;
    readonly mean: number;
    readonly sd: number;
    /** Upward z against the floored σ. Negative departures read as 0. */
    readonly z: number;
    /** Whether this feature cleared both its z (threshold A) and its absolute delta. */
    readonly driving: boolean;
}

export interface DayScore {
    readonly verdict: FingerprintVerdict;
    /** `null` unless ANOMALOUS. */
    readonly tier: AnomalyTier | null;
    /** The highest driving z, or 0. `null` while LEARNING: nothing was judged. */
    readonly score: number | null;
    /** Baseline days the judgement used. */
    readonly baselineDays: number;
    /** Every feature's reading, in `FINGERPRINT_FEATURES` order; empty while LEARNING. */
    readonly readings: readonly FeatureReading[];
    /** The features that drove an ANOMALOUS verdict, highest z first. */
    readonly drivers: readonly FeatureReading[];
    /** Whether this day may enter a later day's baseline. */
    readonly inBaseline: boolean;
}

/** Is the day active at all? A day with no activity is not a sample. */
export function isActiveDay(f: FingerprintFeatures): boolean {
    return FINGERPRINT_FEATURES.some((k) => f[k] > 0);
}

function mean(values: readonly number[]): number {
    return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Population σ. The baseline IS the population it describes. */
function sd(values: readonly number[], m: number): number {
    return Math.sqrt(values.reduce((s, v) => s + (v - m) * (v - m), 0) / values.length);
}

/** The floored σ every z divides by. */
export function flooredSd(rawSd: number, m: number): number {
    return Math.max(rawSd, SD_FLOOR_ABSOLUTE, SD_FLOOR_RATIO * m);
}

/**
 * Score one agent-day against its baseline.
 *
 * `baseline` is the agent's prior IN-BASELINE days, any order; only the most
 * recent `BASELINE_MAX_DAYS` are used, so the caller may over-read. Each entry
 * carries its `day` (`YYYY-MM-DD`) so "most recent" is decided here, not by
 * whatever order the read returned.
 */
export function scoreDay(input: {
    readonly today: FingerprintFeatures;
    readonly baseline: readonly { readonly day: string; readonly features: FingerprintFeatures }[];
}): DayScore {
    const history = [...input.baseline]
        .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
        .slice(0, BASELINE_MAX_DAYS);

    if (history.length < BASELINE_MIN_DAYS) {
        return {
            verdict: 'LEARNING',
            tier: null,
            score: null,
            baselineDays: history.length,
            readings: [],
            drivers: [],
            inBaseline: true,
        };
    }

    const readings: FeatureReading[] = FINGERPRINT_FEATURES.map((feature) => {
        const values = history.map((h) => h.features[feature]);
        const m = mean(values);
        const s = flooredSd(sd(values, m), m);
        const observed = input.today[feature];
        const z = Math.max(0, (observed - m) / s);
        const driving = z >= Z_FINDING && observed - m >= MIN_ABSOLUTE_DELTA[feature];
        return { feature, observed, mean: m, sd: s, z, driving };
    });

    const drivers = readings.filter((r) => r.driving).sort((a, b) => b.z - a.z);
    if (drivers.length === 0) {
        return { verdict: 'STEADY', tier: null, score: 0, baselineDays: history.length, readings, drivers, inBaseline: true };
    }
    const score = drivers[0].z;
    return {
        verdict: 'ANOMALOUS',
        tier: score >= Z_LATCH ? 'LATCH' : 'FINDING',
        score,
        baselineDays: history.length,
        readings,
        drivers,
        // The detector must not learn from the anomaly (header).
        inBaseline: false,
    };
}

// ─── Feature building ───────────────────────────────────────────────

/** One agent's aggregated counts for one day, as the usecase reads them. */
export interface AgentDayCounts {
    readonly readCalls?: number | null;
    readonly proposeCalls?: number | null;
    readonly orchestrateCalls?: number | null;
    readonly activeHours?: number | null;
    readonly proposals?: number | null;
    readonly guardFlags?: number | null;
    readonly modelCalls?: number | null;
    readonly tokensIn?: number | null;
    readonly tokensOut?: number | null;
}

function n(v: number | null | undefined): number {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Normalise one agent's counts into the fingerprint. Nulls are zero; negatives are zero. */
export function buildFeatures(c: AgentDayCounts): FingerprintFeatures {
    return {
        readCalls: n(c.readCalls),
        proposeCalls: n(c.proposeCalls),
        orchestrateCalls: n(c.orchestrateCalls),
        activeHours: Math.min(24, n(c.activeHours)),
        proposals: n(c.proposals),
        guardFlags: n(c.guardFlags),
        modelCalls: n(c.modelCalls),
        tokens: n(c.tokensIn) + n(c.tokensOut),
    };
}

// ─── Days ───────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` in UTC. */
export function dayKeyFor(at: Date): string {
    return at.toISOString().slice(0, 10);
}

/** The UTC day before `now` — the day a nightly run scores. */
export function previousUtcDay(now: Date): { day: string; start: Date; end: Date } {
    const todayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
    const start = new Date(todayStart - DAY_MS);
    return { day: dayKeyFor(start), start, end: new Date(todayStart) };
}

/** The first day a baseline may reach back to, for a scored day starting at `start`. */
export function baselineLookbackStart(start: Date): Date {
    return new Date(start.getTime() - BASELINE_LOOKBACK_DAYS * DAY_MS);
}

// ─── A person's re-baseline ─────────────────────────────────────────
//
// An anomalous day never enters a later baseline (header), so a DELIBERATE,
// lasting change — an owner doubling an agent's workload — would be scored
// against the pre-change days every night until they aged out of the 90-day
// look-back: about 76 nights of re-raised findings and, with the latch key on,
// a breaker re-latched every night a person closed it. The breaker already has
// the answer, `ACCEPTED_NEW_BASELINE`, which advances
// `AgentCircuitBreaker.baselineEpoch`. The fingerprint honours that same epoch,
// so one decision re-baselines both detectors and there is no second control.

/**
 * The re-baseline instant a PERSON set on this agent's breaker, or `null`.
 *
 * `baselineEpoch` defaults to the row's creation time, and the row is created by
 * whatever touches the breaker first — including a latch (`ensureLatchRow`), the
 * fingerprint's own among them. An epoch at the creation instant is that
 * default, not a decision, and honouring it would let the act of latching wipe
 * the baseline the latch was judged against: a later `RESOLVED` close would
 * then re-learn from the anomaly. Only an epoch AFTER creation was moved, and
 * the one writer that moves it is `closeAgentCircuitBreaker` on
 * `ACCEPTED_NEW_BASELINE`. (The row has a single insert site, raw SQL, where
 * both columns take `CURRENT_TIMESTAMP` from one statement, so a defaulted epoch
 * equals `createdAt` exactly.)
 *
 * `RESOLVED` leaves the epoch where it was, so the old baseline keeps judging:
 * "I fixed the agent" means the agent should look like it did before.
 */
export function personSetBaselineEpoch(
    breaker: { readonly baselineEpoch: Date; readonly createdAt: Date } | null | undefined,
): Date | null {
    if (!breaker) return null;
    return breaker.baselineEpoch.getTime() > breaker.createdAt.getTime() ? breaker.baselineEpoch : null;
}

/**
 * Keep only the baseline days that began at or after `epoch`. A day that began
 * before it holds behaviour from before the change a person accepted, even if
 * the change came at 10:00 that day, so it is discarded whole. `null` keeps
 * everything.
 */
export function baselineDaysSinceEpoch<T extends { readonly day: string }>(
    baseline: readonly T[],
    epoch: Date | null,
): T[] {
    if (epoch === null) return [...baseline];
    const from = epoch.getTime();
    return baseline.filter((b) => Date.parse(`${b.day}T00:00:00.000Z`) >= from);
}

// ─── Findings ───────────────────────────────────────────────────────

/** `Finding.sourceKind` for a behaviour anomaly. */
export const BEHAVIOUR_ANOMALY_FINDING_SOURCE_KIND = 'AGENT_BEHAVIOUR_ANOMALY';
/** `Finding.sourceRef` prefix: one finding per agent, reopened rather than duplicated. */
export const BEHAVIOUR_ANOMALY_REF_PREFIX = 'BEHAVIOUR_ANOMALY:';

export function behaviourAnomalySourceRef(agentId: string): string {
    return `${BEHAVIOUR_ANOMALY_REF_PREFIX}${agentId}`;
}

/** `IntegrationExecution.automationKey` for a fingerprint pass row. */
export const FINGERPRINT_AUTOMATION_KEY = 'agentic.agent_fingerprint';

/** Two decimals: what a reader of the "why" needs, and stable in JSON. */
export function round2(v: number): number {
    return Math.round(v * 100) / 100;
}

/** The "why", as stored on the anomaly row and quoted in the finding. Numbers and feature names only. */
export function driversForStorage(drivers: readonly FeatureReading[]): {
    feature: FingerprintFeature;
    observed: number;
    mean: number;
    sd: number;
    z: number;
}[] {
    return drivers.map((d) => ({
        feature: d.feature,
        observed: d.observed,
        mean: round2(d.mean),
        sd: round2(d.sd),
        z: round2(d.z),
    }));
}

/** The finding's description: identifiers and numbers only, ending in the ownership sentence. */
export function anomalyFindingText(input: {
    agentId: string;
    agentName: string;
    day: string;
    tier: AnomalyTier;
    score: number;
    drivers: readonly FeatureReading[];
    baselineDays: number;
}): { title: string; description: string } {
    const why = input.drivers
        .map((d) => `${d.feature} ${d.observed} against a mean of ${round2(d.mean)} (z ${round2(d.z)})`)
        .join('; ');
    return {
        title: `Agent behaviour anomaly: ${input.agentName}`,
        description:
            `On ${input.day} (UTC) agent ${input.agentId} behaved unlike its own baseline of `
            + `${input.baselineDays} active days. Score ${round2(input.score)}, tier ${input.tier}. `
            + `Driving features: ${why}. The fingerprint reads counts only, never content. `
            + `The agent's accountable owner should confirm whether the change was intended.`,
    };
}
