/**
 * The agent BEHAVIOURAL CIRCUIT BREAKER — anomaly, not volume (OWASP ASI08/ASI10).
 *
 * A cap catches an agent doing too MUCH. This catches an agent doing something
 * DIFFERENT, which is the rogue-agent signal a volume threshold set high enough
 * to be quiet will miss entirely: an agent that has read framework status every
 * night for a month and starts calling propose tools has not exceeded any
 * budget, and never will.
 *
 * The shape is borrowed from the identity subsystem's metric annotations — "a
 * `gate_denied` spike means …" — which is this repo's existing instinct for
 * reading a rate against its own history rather than against a constant. What
 * that instinct never had was somewhere to put the conclusion. This module is
 * that place: it produces a VERDICT, and a verdict that says TRIP latches the
 * agent stopped at `authorizeToolCall` until a named human closes it.
 *
 * ## This file is PURE, and the clock is an argument
 *
 * No `Date.now()`, no `new Date()`, no randomness, no I/O, no Prisma. Every
 * input arrives in `BreakerInput`, including `now`. That is not a testing
 * convenience: a control whose verdict depends on when it happened to run is a
 * control nobody can reproduce during the incident review that matters, and the
 * first question asked of any trip is "would it have tripped on yesterday's
 * numbers". `circuit-breaker-store.ts` owns the reads; this owns the judgement.
 *
 * ## The three signals, and why each earns its place
 *
 *   PROPOSAL_RATE  — how many propose-class calls per active window. The flood.
 *   REJECTION_RATE — what share of this agent's reviewed proposals humans are
 *                    rejecting. The queue is the only observer that can see the
 *                    agent's output QUALITY, and a step change in it is the
 *                    queue saying the agent changed.
 *   TOOL_MIX       — the distribution over capability CLASS (read / propose /
 *                    orchestrate). The low-volume signal: one propose call from
 *                    an agent that has only ever read is a bigger fact than a
 *                    hundred extra reads.
 *
 * ## THE THING THAT KILLS A BREAKER IS FALSE POSITIVES
 *
 * A breaker that trips on legitimate change gets switched off by the first
 * operator it inconveniences, and then protects nothing at all. Five separate
 * suppressions, each of which alone would leave it too noisy to survive:
 *
 *   1. NO VERDICT WITHOUT A BASELINE. Below `MIN_BASELINE_WINDOWS` complete
 *      windows or `MIN_BASELINE_OBSERVATIONS` calls the answer is `NO_BASELINE`
 *      — a named outcome, not `STEADY`. See the section below.
 *   2. ROBUST STATISTICS. Median and MAD, never mean and standard deviation.
 *      One prior spike inflates a mean enough to hide the next one, and inflates
 *      a standard deviation enough to hide everything; the median does not move
 *      and the MAD does not either.
 *   3. THREE CONDITIONS PER RATE TRIP, ALL REQUIRED — an absolute delta, a
 *      multiple, and a robust z. Any one alone is a false-positive machine: the
 *      absolute one fires on every busy agent, the multiple fires on every quiet
 *      one (2 calls to 6 is a tripling), and the z fires on any agent whose
 *      history happens to be flat.
 *   4. PERSISTENCE. One anomalous window ARMS; it takes `WINDOWS_TO_TRIP`
 *      consecutive windows sharing a signal to trip. This is the single largest
 *      suppression, and it is why `ARMED` is a distinct code rather than an
 *      internal detail — an operator should be able to see the breaker leaning
 *      before it fires.
 *   5. A DELIBERATE OPERATOR CHANGE RESETS THE BASELINE RATHER THAN TRIPPING
 *      IT. Widening a policy card or granting a tool advances the breaker's
 *      `baselineEpoch`; samples from before it are discarded and the agent is
 *      back to `NO_BASELINE`. The alternative — trip, then explain — is how a
 *      security control teaches people that its alerts are noise.
 *
 * What is deliberately NOT a trip condition: a novel TOOL NAME inside a class
 * the agent already uses. It is the most tempting signal here and the worst
 * one — every routine grant produces it — so novel tool names are carried in
 * the verdict as EVIDENCE (they are what makes a trip legible to whoever reads
 * it) and never as a cause.
 *
 * ## NO BASELINE IS A VERDICT, NOT A SILENCE
 *
 * A brand-new agent has no history. A breaker that trips on its first action is
 * useless and one that waits for ever protects nothing, so the refusal to judge
 * has to be VISIBLE: `NO_BASELINE` carries the counts it had and the reason it
 * was not enough, the store records it, and the metric counts it under its own
 * outcome label. "The breaker found nothing" and "the breaker declined to look"
 * are different facts, and a control that reports them identically is reporting
 * the second one as the first.
 *
 * ## Tripping is RECOVERABLE, and only by a human
 *
 * Nothing here closes a breaker. There is no half-open probe and no timeout,
 * because both are auto-recovery and an agent that has gone rogue can simply
 * wait one out. The close is `closeAgentCircuitBreaker`, gated by
 * `admin.agent_registry` and audited, and it carries a REASON that decides what
 * happens to the baseline — see `BREAKER_CLOSE_REASONS`.
 */

// ─── Windowing ──────────────────────────────────────────────────────

/**
 * One hour, in milliseconds. The observation bucket.
 *
 * An hour rather than a day because the flood signal has to be actionable
 * inside a shift; an hour rather than a minute because the rejection signal
 * needs humans to have reviewed something, and because a minute-wide bucket on
 * a nightly agent is 1439 empty buckets and one that looks like a spike.
 */
export const WINDOW_MS = 3_600_000;

/**
 * The bucket key for an instant: `YYYY-MM-DDTHH` in UTC.
 *
 * UTC, stated once, for the reason `AgentPolicyCard.usageWindowDate` is a
 * `@db.Date` — a window whose boundary depends on the reader's timezone
 * produces two different histories from the same rows.
 */
export function windowKeyFor(at: Date): string {
    return at.toISOString().slice(0, 13);
}

/** The instant a window opens — the key, back as a `Date`. */
export function windowStartFor(at: Date): Date {
    return new Date(Math.floor(at.getTime() / WINDOW_MS) * WINDOW_MS);
}

// ─── Vocabulary ─────────────────────────────────────────────────────

/**
 * The signals, as stable codes. They are written into an audit row and into a
 * metric label, so they have to mean the same thing to somebody reading a trip
 * a year later as they did to whoever wrote the threshold.
 */
export const BREAKER_SIGNALS = ['PROPOSAL_RATE', 'REJECTION_RATE', 'TOOL_MIX'] as const;
export type BreakerSignal = (typeof BREAKER_SIGNALS)[number];

/**
 * What one signal concluded THIS window.
 *
 *   NOT_JUDGED — the signal's own denominator was too small. Distinct from
 *                STEADY on purpose: "nobody reviewed any proposals this window"
 *                is not "humans are happy with this agent".
 *   STEADY     — judged, and unremarkable.
 *   ANOMALOUS  — judged, and unlike this agent's own history.
 */
export const SIGNAL_STATES = ['NOT_JUDGED', 'STEADY', 'ANOMALOUS'] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];

/**
 * The verdict for a whole window.
 *
 *   NO_BASELINE — refused to judge. Not an error and not an all-clear.
 *   STEADY      — a baseline exists and nothing fired.
 *   ARMED       — something fired, but not for long enough yet.
 *   TRIP        — latch the breaker OPEN.
 */
export const BREAKER_VERDICT_CODES = ['NO_BASELINE', 'STEADY', 'ARMED', 'TRIP'] as const;
export type BreakerVerdictCode = (typeof BREAKER_VERDICT_CODES)[number];

/**
 * The breaker's own state, as stored.
 *
 * `OPEN` is the electrical sense — the circuit is broken and nothing flows. It
 * is the state in which the agent is stopped.
 */
export const BREAKER_STATES = ['CLOSED', 'OPEN'] as const;
export type BreakerState = (typeof BREAKER_STATES)[number];

/**
 * Why a human closed a breaker, and what that does to the baseline. The two
 * reasons are not interchangeable, and collapsing them is how a breaker becomes
 * a rubber stamp:
 *
 *   ACCEPTED_NEW_BASELINE — "yes, I changed this agent." The anomaly WAS the
 *                           new normal, so the old baseline is discarded and
 *                           the epoch advances: the agent is back to
 *                           `NO_BASELINE` and re-learns. Without this, the
 *                           operator's only way to stop being paged is to
 *                           disable the breaker.
 *   RESOLVED              — "I fixed the agent." The old baseline is what the
 *                           agent should return to, so it is KEPT and the
 *                           anomalous streak is cleared. Re-baselining here
 *                           would silently adopt the rogue behaviour as normal,
 *                           which is the failure mode that makes an
 *                           auto-recovering breaker worthless.
 */
export const BREAKER_CLOSE_REASONS = ['ACCEPTED_NEW_BASELINE', 'RESOLVED'] as const;
export type BreakerCloseReason = (typeof BREAKER_CLOSE_REASONS)[number];

// ─── Thresholds ─────────────────────────────────────────────────────
//
// Every number below is a constant with a written reason, in ONE place, for the
// reason `write-ladder.ts` exists: a threshold copied into the evaluator and
// into whatever renders it agrees only by coincidence.

/**
 * Complete windows required before any judgement. Twelve ACTIVE windows — see
 * `BreakerInput.baseline` for why an empty hour is not a sample.
 *
 * Twelve rather than three because MAD over three points is not a dispersion
 * estimate, and rather than a hundred because an agent that acts nightly would
 * take three months to earn a baseline and be unprotected throughout.
 */
export const MIN_BASELINE_WINDOWS = 12;

/**
 * Tool calls required across those windows. Twelve windows of one call each
 * satisfies the count above while telling you nothing about a rate.
 */
export const MIN_BASELINE_OBSERVATIONS = 30;

/** Windows the baseline looks back over — seven days of active hours. */
export const BASELINE_WINDOW_LIMIT = 168;

/**
 * Consecutive windows sharing a signal before the breaker trips.
 *
 * Two, and the streak counts ACTIVE windows, not wall-clock hours: for a
 * nightly agent that is its next two runs, which is the right amount of
 * evidence for stopping something, and for a flooding agent it is two hours.
 */
export const WINDOWS_TO_TRIP = 2;

/** The three conditions on a rate trip. ALL of them, never any of them. */
export const RATE_MIN_ABSOLUTE_DELTA = 10;
export const RATE_MIN_MULTIPLE = 3;
export const RATE_Z_THRESHOLD = 6;

/**
 * The floor under the MAD divisor.
 *
 * An agent that has made exactly 4 propose calls in every one of its baseline
 * windows has MAD 0, and every z against it is infinite — so a perfectly
 * regular agent would be the easiest one to trip, which is precisely backwards.
 * One call of dispersion is the least this pretends to know.
 */
export const MAD_FLOOR = 1;

/** Calls in the current window before its class MIX is worth comparing. */
export const MIX_MIN_SAMPLE = 10;

/**
 * Total-variation distance between the current window's class distribution and
 * the baseline's, above which the mix counts as shifted. 0.5 = half the calls
 * moved class.
 */
export const MIX_TVD_THRESHOLD = 0.5;

/** Reviewed proposals needed in each period before the rejection rate is read. */
export const REJECTION_MIN_RECENT_REVIEWED = 5;
export const REJECTION_MIN_BASELINE_REVIEWED = 20;
/** The rise in rejected SHARE that counts, and the absolute floor under it. */
export const REJECTION_RATE_DELTA = 0.4;
export const REJECTION_MIN_ABSOLUTE = 3;

// ─── Inputs ─────────────────────────────────────────────────────────

/** One window's observations, as the ledger stores them. */
export interface BreakerObservation {
    /** `YYYY-MM-DDTHH`, from `windowKeyFor`. */
    readonly windowKey: string;
    readonly readCalls: number;
    readonly proposeCalls: number;
    readonly orchestrateCalls: number;
    /**
     * The distinct tool names seen. EVIDENCE ONLY — never a trip condition; see
     * the header for why a novel tool name is the worst signal here.
     */
    readonly toolNames: readonly string[];
    /**
     * TRUE when this window's own verdict fired a signal.
     *
     * A DETECTOR MUST NOT LEARN FROM THE ANOMALY. Without this flag the
     * strongest signal here is also the shortest-lived: an agent that has only
     * ever read makes one propose call, the ledger records it, and by the next
     * window `propose` is no longer a class this agent has never used — so the
     * signal extinguishes itself in exactly the case it exists for, and the
     * two-window persistence rule can never be satisfied. `evaluateCircuitBreaker`
     * drops these windows before it computes anything.
     *
     * The flag is on the OBSERVATION rather than applied by the caller, so a
     * store that hands over every row still behaves correctly. A filter the
     * evaluator cannot see is a filter nothing verifies.
     */
    readonly anomalous: boolean;
}

/**
 * The rejection signal's two periods, pre-aggregated.
 *
 * Attributed by REVIEW time, not by proposal time. "The queue is suddenly
 * rejecting this agent's work" is an event that happens when a human clicks
 * reject, and attributing it to the hour the proposal was written would make
 * the signal permanently lag by however long the queue is — which on a quiet
 * tenant is unbounded.
 *
 * The periods are wider than one window for the same reason: an hour in which
 * nobody reviewed anything is the common case, and a rate over a denominator of
 * zero is not a rate.
 */
export interface RejectionCounts {
    readonly recentReviewed: number;
    readonly recentRejected: number;
    readonly baselineReviewed: number;
    readonly baselineRejected: number;
}

export interface BreakerInput {
    /** The clock, injected. Nothing in this module reads one. */
    readonly now: Date;
    /** The window just completed — the one being judged. */
    readonly current: BreakerObservation;
    /**
     * Complete windows before it, newest first, at most `BASELINE_WINDOW_LIMIT`.
     *
     * ONLY windows in which the agent was observed at all. An hour with no row
     * is AMBIGUOUS — the agent was idle, or the worker was down, or the tenant
     * was asleep — and a baseline that reads every such hour as a hard zero
     * drifts toward zero and then trips on the first ordinary hour. The rate
     * this module judges is therefore "calls per ACTIVE window", which is a
     * claim the data can actually support.
     *
     * Windows carrying `anomalous: true` are dropped here rather than by the
     * caller — see that field.
     */
    readonly baseline: readonly BreakerObservation[];
    readonly rejection: RejectionCounts;
    /** Consecutive anomalous windows before this one. */
    readonly priorStreak: number;
    /** The signals that carried that streak. */
    readonly priorStreakSignals: readonly BreakerSignal[];
}

// ─── Outputs ────────────────────────────────────────────────────────

/**
 * One signal's reading. `basis` is a STABLE CODE, never prose assembled at read
 * time: it lands in an audit row and in a metric label, and a message that
 * changes wording between builds cannot be grouped by either.
 */
export interface SignalReading {
    readonly signal: BreakerSignal;
    readonly state: SignalState;
    readonly basis: string;
    /** The number the current window produced, in the signal's own units. */
    readonly observed: number;
    /** What this agent's own history said to expect. */
    readonly expected: number;
}

export interface BaselineReading {
    readonly windows: number;
    readonly observations: number;
    readonly sufficient: boolean;
    /** The stable code for WHY it was not enough, or `null` when it was. */
    readonly shortfall: string | null;
}

export interface BreakerVerdict {
    readonly code: BreakerVerdictCode;
    /** All three signals, always — so "not judged" is visible rather than absent. */
    readonly signals: readonly SignalReading[];
    /** The signals that were ANOMALOUS this window. */
    readonly firing: readonly BreakerSignal[];
    readonly streak: number;
    readonly streakSignals: readonly BreakerSignal[];
    readonly baseline: BaselineReading;
    /**
     * Tool names in the current window that no baseline window held. Evidence
     * for whoever reads the trip; never a cause of one.
     */
    readonly novelToolNames: readonly string[];
    /** The window this verdict is about, so a stored verdict is self-describing. */
    readonly windowKey: string;
}

// ─── Robust statistics ──────────────────────────────────────────────

/** The median of a non-empty sample. Returns 0 for an empty one. */
export function median(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median absolute deviation — the robust dispersion estimate.
 *
 * Not the standard deviation, and the difference is the whole point: one prior
 * incident in the history inflates a standard deviation enough to hide the next
 * one, which is the failure mode of every naive anomaly detector.
 */
export function medianAbsoluteDeviation(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const centre = median(values);
    return median(values.map((v) => Math.abs(v - centre)));
}

/** Deviation in MAD units, with the floor applied. */
export function robustZ(observed: number, centre: number, dispersion: number): number {
    return (observed - centre) / Math.max(dispersion, MAD_FLOOR);
}

/**
 * Total-variation distance between two distributions over the same three
 * classes — half the L1 distance, bounded to `[0, 1]`.
 *
 * Bounded is what makes the threshold readable: 0.5 means "half the calls
 * changed class", in every tenant, at every volume.
 */
export function totalVariationDistance(
    a: readonly number[],
    b: readonly number[],
): number {
    const sumA = a.reduce((t, v) => t + v, 0);
    const sumB = b.reduce((t, v) => t + v, 0);
    if (sumA === 0 || sumB === 0) return 0;
    let total = 0;
    for (let i = 0; i < a.length; i++) {
        total += Math.abs(a[i] / sumA - b[i] / sumB);
    }
    return total / 2;
}

/** Calls in one window, all classes. */
export function totalCalls(o: BreakerObservation): number {
    return o.readCalls + o.proposeCalls + o.orchestrateCalls;
}

/** The class vector, in one order, used by every distribution comparison. */
function classVector(o: BreakerObservation): number[] {
    return [o.readCalls, o.proposeCalls, o.orchestrateCalls];
}

// ─── The signals ────────────────────────────────────────────────────

function readProposalRate(input: BreakerInput): SignalReading {
    const history = input.baseline.map((w) => w.proposeCalls);
    const centre = median(history);
    const observed = input.current.proposeCalls;
    const dispersion = medianAbsoluteDeviation(history);
    const z = robustZ(observed, centre, dispersion);

    const meetsAbsolute = observed - centre >= RATE_MIN_ABSOLUTE_DELTA;
    const meetsMultiple = observed >= centre * RATE_MIN_MULTIPLE;
    const meetsZ = z >= RATE_Z_THRESHOLD;

    // All three, and the basis names the one that held it back — an operator
    // tuning this needs to know which condition is doing the work.
    const state: SignalState = meetsAbsolute && meetsMultiple && meetsZ ? 'ANOMALOUS' : 'STEADY';
    const basis = state === 'ANOMALOUS'
        ? 'RATE_SPIKE'
        : !meetsAbsolute
          ? 'BELOW_ABSOLUTE_DELTA'
          : !meetsMultiple
            ? 'BELOW_MULTIPLE'
            : 'WITHIN_DISPERSION';

    return { signal: 'PROPOSAL_RATE', state, basis, observed, expected: centre };
}

function readRejectionRate(input: BreakerInput): SignalReading {
    const r = input.rejection;
    const observed = r.recentReviewed === 0 ? 0 : r.recentRejected / r.recentReviewed;
    const expected = r.baselineReviewed === 0 ? 0 : r.baselineRejected / r.baselineReviewed;

    // Both denominators first. A rate over five reviews compared against a rate
    // over two is arithmetic, not evidence.
    if (r.recentReviewed < REJECTION_MIN_RECENT_REVIEWED) {
        return {
            signal: 'REJECTION_RATE',
            state: 'NOT_JUDGED',
            basis: 'TOO_FEW_RECENT_REVIEWS',
            observed,
            expected,
        };
    }
    if (r.baselineReviewed < REJECTION_MIN_BASELINE_REVIEWED) {
        return {
            signal: 'REJECTION_RATE',
            state: 'NOT_JUDGED',
            basis: 'TOO_FEW_BASELINE_REVIEWS',
            observed,
            expected,
        };
    }

    const anomalous =
        observed - expected >= REJECTION_RATE_DELTA && r.recentRejected >= REJECTION_MIN_ABSOLUTE;
    return {
        signal: 'REJECTION_RATE',
        state: anomalous ? 'ANOMALOUS' : 'STEADY',
        basis: anomalous ? 'REJECTION_SHARE_ROSE' : 'REJECTION_SHARE_STABLE',
        observed,
        expected,
    };
}

function readToolMix(input: BreakerInput): SignalReading {
    const pooled: BreakerObservation = {
        windowKey: 'pooled',
        anomalous: false,
        readCalls: input.baseline.reduce((t, w) => t + w.readCalls, 0),
        proposeCalls: input.baseline.reduce((t, w) => t + w.proposeCalls, 0),
        orchestrateCalls: input.baseline.reduce((t, w) => t + w.orchestrateCalls, 0),
        toolNames: [],
    };
    const currentVector = classVector(input.current);
    const pooledVector = classVector(pooled);
    const distance = totalVariationDistance(currentVector, pooledVector);

    // A class the agent has NEVER used, appearing. This is the low-volume arm
    // and it is the one the prompt's scenario lands on: an agent a month into
    // reading framework status that makes one propose call has moved no rate and
    // exceeded no budget. It is checked BEFORE the sample-size gate below,
    // because requiring ten calls to notice the first propose call would defeat
    // the only signal that sees this.
    for (let i = 0; i < currentVector.length; i++) {
        if (currentVector[i] > 0 && pooledVector[i] === 0) {
            return {
                signal: 'TOOL_MIX',
                state: 'ANOMALOUS',
                basis: 'NOVEL_CAPABILITY_CLASS',
                observed: currentVector[i],
                expected: 0,
            };
        }
    }

    if (totalCalls(input.current) < MIX_MIN_SAMPLE) {
        // A two-call window is 100% of something whatever it does. Comparing its
        // shape to a week of history is a coin flip wearing a decimal point.
        return {
            signal: 'TOOL_MIX',
            state: 'NOT_JUDGED',
            basis: 'SAMPLE_TOO_SMALL',
            observed: distance,
            expected: 0,
        };
    }

    const anomalous = distance >= MIX_TVD_THRESHOLD;
    return {
        signal: 'TOOL_MIX',
        state: anomalous ? 'ANOMALOUS' : 'STEADY',
        basis: anomalous ? 'DISTRIBUTION_SHIFTED' : 'DISTRIBUTION_STABLE',
        observed: distance,
        expected: MIX_TVD_THRESHOLD,
    };
}

// ─── The verdict ────────────────────────────────────────────────────

function readBaseline(input: BreakerInput): BaselineReading {
    const windows = input.baseline.length;
    const observations = input.baseline.reduce((t, w) => t + totalCalls(w), 0);
    // Windows first, so a short history reports the reason an operator can act
    // on: "wait" rather than "wait, and also there is a second thing".
    const shortfall =
        windows < MIN_BASELINE_WINDOWS
            ? 'TOO_FEW_WINDOWS'
            : observations < MIN_BASELINE_OBSERVATIONS
              ? 'TOO_FEW_OBSERVATIONS'
              : null;
    return { windows, observations, sufficient: shortfall === null, shortfall };
}

function novelToolNamesIn(input: BreakerInput): string[] {
    const seen = new Set<string>();
    for (const w of input.baseline) {
        for (const name of w.toolNames) seen.add(name);
    }
    return input.current.toolNames.filter((name) => !seen.has(name));
}

/**
 * Judge one completed window.
 *
 * The one entry point. Deterministic in its argument: the same `BreakerInput`
 * always yields the same `BreakerVerdict`, which is what makes a trip
 * reproducible from the ledger months later.
 */
export function evaluateCircuitBreaker(rawInput: BreakerInput): BreakerVerdict {
    // A detector must not learn from the anomaly. Dropped ONCE, here, so every
    // reader below is looking at the same accepted history — a filter applied in
    // two of the three signals is the shape that produces a verdict nobody can
    // reproduce.
    const input: BreakerInput = {
        ...rawInput,
        baseline: rawInput.baseline.filter((w) => !w.anomalous),
    };
    const baseline = readBaseline(input);
    const novelToolNames = novelToolNamesIn(input);

    if (!baseline.sufficient) {
        // Refusing to judge, out loud. Every signal reports NOT_JUDGED with the
        // baseline's own shortfall as its basis, so a caller that only reads the
        // signal list still learns that nothing was measured — rather than
        // reading three STEADYs and concluding the agent is fine.
        const notJudged: SignalReading[] = BREAKER_SIGNALS.map((signal) => ({
            signal,
            state: 'NOT_JUDGED' as const,
            basis: baseline.shortfall ?? 'NO_BASELINE',
            observed: 0,
            expected: 0,
        }));
        return {
            code: 'NO_BASELINE',
            signals: notJudged,
            firing: [],
            // The streak is CLEARED, not carried. A baseline that has just been
            // reset by an operator accepting a change must not have the streak
            // from before the reset finish the job two windows later.
            streak: 0,
            streakSignals: [],
            baseline,
            novelToolNames,
            windowKey: input.current.windowKey,
        };
    }

    const signals: SignalReading[] = [
        readProposalRate(input),
        readRejectionRate(input),
        readToolMix(input),
    ];
    const firing = signals.filter((s) => s.state === 'ANOMALOUS').map((s) => s.signal);

    // Persistence, per signal rather than per window. Two consecutive windows
    // that fire DIFFERENT signals are two unrelated oddities; the claim worth
    // stopping an agent for is that the SAME thing is still true.
    let streak = 0;
    let streakSignals: BreakerSignal[] = [];
    if (firing.length > 0) {
        const persisted =
            input.priorStreak > 0
                ? firing.filter((s) => input.priorStreakSignals.includes(s))
                : [];
        if (persisted.length > 0) {
            streak = input.priorStreak + 1;
            streakSignals = persisted;
        } else {
            streak = 1;
            streakSignals = firing;
        }
    }

    const code: BreakerVerdictCode =
        streak >= WINDOWS_TO_TRIP ? 'TRIP' : streak > 0 ? 'ARMED' : 'STEADY';

    return {
        code,
        signals,
        firing,
        streak,
        streakSignals,
        baseline,
        novelToolNames,
        windowKey: input.current.windowKey,
    };
}
