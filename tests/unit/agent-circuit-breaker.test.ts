/**
 * The agent behavioural circuit breaker judges an agent against ITS OWN history.
 *
 * Every fixture here is a hand-written window ledger and a hand-written clock.
 * There is no wall-clock read and no randomness anywhere in this file or in the
 * module it exercises — a breaker whose verdict depends on when it happened to
 * run cannot be re-derived during the incident review that matters, and "would
 * it have tripped on yesterday's numbers" is the first question anybody asks.
 *
 * The tests are written so that each one has something to lose. The negative
 * cases are the load-bearing half: a breaker that trips on a busy Tuesday gets
 * switched off by the first operator it inconveniences, and then protects
 * nothing at all.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
    BREAKER_SIGNALS,
    MIN_BASELINE_OBSERVATIONS,
    MIN_BASELINE_WINDOWS,
    WINDOWS_TO_TRIP,
    WINDOW_MS,
    evaluateCircuitBreaker,
    median,
    medianAbsoluteDeviation,
    totalVariationDistance,
    windowKeyFor,
    windowStartFor,
    type BreakerInput,
    type BreakerObservation,
    type BreakerSignal,
    type BreakerVerdict,
    type RejectionCounts,
} from '@/lib/agentic/circuit-breaker';
import { codeOf } from '../helpers/source-blocks';

// ─── The clock, injected ────────────────────────────────────────────

const HOUR = 3_600_000;
/** A fixed instant. Nothing in this file asks the machine what time it is. */
const EPOCH = Date.parse('2026-09-01T00:00:00.000Z');
const at = (hour: number): Date => new Date(EPOCH + hour * HOUR);

// ─── Fixture builders ───────────────────────────────────────────────

interface WindowSpec {
    readonly hour: number;
    readonly read?: number;
    readonly propose?: number;
    readonly orchestrate?: number;
    readonly tools?: readonly string[];
    readonly anomalous?: boolean;
}

function observation(spec: WindowSpec): BreakerObservation {
    return {
        windowKey: windowKeyFor(at(spec.hour)),
        readCalls: spec.read ?? 0,
        proposeCalls: spec.propose ?? 0,
        orchestrateCalls: spec.orchestrate ?? 0,
        toolNames: spec.tools ?? [],
        anomalous: spec.anomalous ?? false,
    };
}

const NO_REVIEWS: RejectionCounts = {
    recentReviewed: 0,
    recentRejected: 0,
    baselineReviewed: 0,
    baselineRejected: 0,
};

/**
 * Twelve windows of a busy-but-regular proposing agent: median 20 propose calls
 * per active window, five reads alongside. The cycle is written out rather than
 * generated so the median and the MAD are readable from the page.
 */
const REGULAR_PROPOSE_CYCLE = [18, 20, 22, 20, 19, 21, 20, 20, 18, 22, 20, 20];

function regularBaseline(): BreakerObservation[] {
    return REGULAR_PROPOSE_CYCLE.map((propose, i) =>
        observation({
            hour: -1 - i,
            read: 5,
            propose,
            tools: ['agent.list_risks', 'agent.propose_risk'],
        }),
    );
}

/** Twelve windows of an agent that has only ever READ. */
function readOnlyBaseline(): BreakerObservation[] {
    return Array.from({ length: 12 }, (_unused, i) =>
        observation({ hour: -1 - i, read: 5, tools: ['agent.framework_status'] }),
    );
}

function input(over: Partial<BreakerInput> & { current: BreakerObservation }): BreakerInput {
    return {
        now: at(0),
        baseline: regularBaseline(),
        rejection: NO_REVIEWS,
        priorStreak: 0,
        priorStreakSignals: [],
        ...over,
    };
}

function readingFor(verdict: BreakerVerdict, signal: BreakerSignal) {
    const found = verdict.signals.find((s) => s.signal === signal);
    if (found === undefined) throw new Error(`no reading for ${signal}`);
    return found;
}

// ─── Before there is a baseline ─────────────────────────────────────

describe('an agent with too little history is REFUSED a verdict, visibly', () => {
    it('names too-few-windows, and every signal says it was not judged', () => {
        // A spike so violent that any threshold would fire on it — so what this
        // asserts is the refusal itself, not an incidentally quiet fixture.
        const verdict = evaluateCircuitBreaker(
            input({
                baseline: regularBaseline().slice(0, 3),
                current: observation({ hour: 0, read: 5, propose: 500 }),
            }),
        );

        expect(verdict.code).toBe('NO_BASELINE');
        expect(verdict.baseline.sufficient).toBe(false);
        expect(verdict.baseline.shortfall).toBe('TOO_FEW_WINDOWS');
        expect(verdict.baseline.windows).toBe(3);
        expect(verdict.firing).toEqual([]);

        // The refusal is visible on every signal rather than implied by the
        // absence of one. Three STEADYs and a refusal to look are the same
        // output to a caller that only reads the signal list.
        expect(verdict.signals.map((s) => s.signal)).toEqual([...BREAKER_SIGNALS]);
        for (const reading of verdict.signals) {
            expect(reading.state).toBe('NOT_JUDGED');
            expect(reading.basis).toBe('TOO_FEW_WINDOWS');
        }
    });

    it('names too-few-observations separately — a long, thin history is its own case', () => {
        // Twelve windows, so the window count is satisfied; one call each, so
        // nothing has been learnt about a rate. Folding the two shortfalls
        // together would tell an operator to wait when waiting is not the fix.
        const thin = Array.from({ length: MIN_BASELINE_WINDOWS }, (_unused, i) =>
            observation({ hour: -1 - i, read: 1 }),
        );
        const verdict = evaluateCircuitBreaker(
            input({ baseline: thin, current: observation({ hour: 0, propose: 500 }) }),
        );

        expect(verdict.code).toBe('NO_BASELINE');
        expect(verdict.baseline.shortfall).toBe('TOO_FEW_OBSERVATIONS');
        expect(verdict.baseline.windows).toBe(MIN_BASELINE_WINDOWS);
        expect(verdict.baseline.observations).toBeLessThan(MIN_BASELINE_OBSERVATIONS);
    });
});

// ─── Proposal rate ──────────────────────────────────────────────────

describe('proposal rate', () => {
    it('a steady rate does not trip, and does not even arm', () => {
        // 20 → 32 in one hour. Absolutely large (+12) and statistically extreme
        // (12 MAD units), and DELIBERATELY not a trip: it is not a 3x multiple,
        // and a busy agent having a 60%-busier hour is a Tuesday. This is the
        // case that decides whether the breaker survives contact with an
        // operator, which is why it is asserted before either trip below.
        const verdict = evaluateCircuitBreaker(
            input({ current: observation({ hour: 0, read: 5, propose: 32 }) }),
        );

        expect(verdict.code).toBe('STEADY');
        expect(verdict.firing).toEqual([]);
        expect(verdict.streak).toBe(0);
        const rate = readingFor(verdict, 'PROPOSAL_RATE');
        expect(rate.state).toBe('STEADY');
        expect(rate.basis).toBe('BELOW_MULTIPLE');
        expect(rate.expected).toBe(20);
    });

    it('a spike ARMS on the first window and TRIPS on the second', () => {
        const first = evaluateCircuitBreaker(
            input({ current: observation({ hour: 0, read: 5, propose: 90 }) }),
        );

        expect(first.code).toBe('ARMED');
        expect(first.firing).toEqual(['PROPOSAL_RATE']);
        expect(first.streak).toBe(1);
        expect(readingFor(first, 'PROPOSAL_RATE').basis).toBe('RATE_SPIKE');

        // The second window carries the first one forward as history — flagged
        // anomalous, so it is not allowed to become the new normal — and the
        // streak is threaded from the first verdict rather than asserted afresh.
        const second = evaluateCircuitBreaker(
            input({
                now: at(1),
                baseline: [
                    observation({ hour: 0, read: 5, propose: 90, anomalous: true }),
                    ...regularBaseline(),
                ],
                current: observation({ hour: 1, read: 5, propose: 95 }),
                priorStreak: first.streak,
                priorStreakSignals: first.streakSignals,
            }),
        );

        expect(second.code).toBe('TRIP');
        expect(second.streak).toBe(WINDOWS_TO_TRIP);
        expect(second.streakSignals).toEqual(['PROPOSAL_RATE']);
    });

    it('one anomalous window followed by a normal one clears the streak', () => {
        // The persistence rule is the largest single false-positive suppression
        // in the design, so the case it exists for is asserted directly: a
        // one-off burst must leave no residue that a later, unrelated window can
        // finish the job with.
        const armed = evaluateCircuitBreaker(
            input({ current: observation({ hour: 0, read: 5, propose: 90 }) }),
        );
        expect(armed.streak).toBe(1);

        const after = evaluateCircuitBreaker(
            input({
                now: at(1),
                baseline: [
                    observation({ hour: 0, read: 5, propose: 90, anomalous: true }),
                    ...regularBaseline(),
                ],
                current: observation({ hour: 1, read: 5, propose: 20 }),
                priorStreak: armed.streak,
                priorStreakSignals: armed.streakSignals,
            }),
        );

        expect(after.code).toBe('STEADY');
        expect(after.streak).toBe(0);
        expect(after.streakSignals).toEqual([]);
    });

    it('one prior incident in the history does not blind the detector to the next', () => {
        // A mean and a standard deviation over this baseline put the centre at
        // ~52 with a spread of ~105, and the 90-call window below lands well
        // inside one deviation — i.e. an incident makes the following incident
        // invisible. The median and the MAD do not move.
        const scarred = [
            observation({ hour: -1, read: 5, propose: 400 }),
            ...regularBaseline().slice(0, 11),
        ];
        const verdict = evaluateCircuitBreaker(
            input({ baseline: scarred, current: observation({ hour: 0, read: 5, propose: 90 }) }),
        );

        expect(readingFor(verdict, 'PROPOSAL_RATE').expected).toBe(20);
        expect(verdict.firing).toEqual(['PROPOSAL_RATE']);
    });
});

// ─── Tool mix ───────────────────────────────────────────────────────

describe('tool mix', () => {
    it('a capability class the agent has never used trips it, at a volume no rate threshold sees', () => {
        // The ASI10 scenario. A month of reading framework status, then ONE
        // propose call. No budget is exceeded, no rate moves, and the only thing
        // that has changed is the kind of thing the agent is doing.
        const first = evaluateCircuitBreaker(
            input({
                baseline: readOnlyBaseline(),
                current: observation({
                    hour: 0,
                    read: 4,
                    propose: 1,
                    tools: ['agent.framework_status', 'agent.propose_risk'],
                }),
            }),
        );

        expect(first.code).toBe('ARMED');
        expect(first.firing).toEqual(['TOOL_MIX']);
        expect(readingFor(first, 'TOOL_MIX').basis).toBe('NOVEL_CAPABILITY_CLASS');
        // And the rate signal stayed quiet, which is the whole point: one call
        // is below every absolute floor the rate arm has.
        expect(readingFor(first, 'PROPOSAL_RATE').state).toBe('STEADY');
        // The novel tool NAME is carried as evidence so the trip is legible —
        // and never as a cause, because every routine grant produces one.
        expect(first.novelToolNames).toEqual(['agent.propose_risk']);

        const second = evaluateCircuitBreaker(
            input({
                now: at(1),
                baseline: [
                    observation({ hour: 0, read: 4, propose: 1, anomalous: true }),
                    ...readOnlyBaseline(),
                ],
                current: observation({ hour: 1, read: 3, propose: 2 }),
                priorStreak: first.streak,
                priorStreakSignals: first.streakSignals,
            }),
        );

        expect(second.code).toBe('TRIP');
        expect(second.streakSignals).toEqual(['TOOL_MIX']);
    });

    it('the anomalous window is not allowed to become the baseline', () => {
        // Left in the history, the first propose call makes `propose` a class
        // this agent has used — so the strongest signal in the module would
        // extinguish itself one window after firing, and the two-window
        // persistence rule could never be satisfied by it.
        const verdict = evaluateCircuitBreaker(
            input({
                baseline: [
                    observation({ hour: -13, propose: 1, anomalous: true }),
                    ...readOnlyBaseline(),
                ],
                current: observation({ hour: 0, read: 4, propose: 1 }),
            }),
        );

        const mix = readingFor(verdict, 'TOOL_MIX');
        expect(mix.state).toBe('ANOMALOUS');
        expect(mix.basis).toBe('NOVEL_CAPABILITY_CLASS');
        expect(verdict.baseline.windows).toBe(12);
    });

    it('a tiny window is NOT_JUDGED on distribution rather than read as a shift', () => {
        // Two calls are 100% of whatever they are. Comparing that shape to a
        // week of history is a coin flip wearing a decimal point.
        const verdict = evaluateCircuitBreaker(
            input({ current: observation({ hour: 0, read: 2, propose: 1 }) }),
        );

        const mix = readingFor(verdict, 'TOOL_MIX');
        expect(mix.state).toBe('NOT_JUDGED');
        expect(mix.basis).toBe('SAMPLE_TOO_SMALL');
        expect(verdict.code).toBe('STEADY');
    });
});

// ─── Rejection rate ─────────────────────────────────────────────────

describe('rejection rate', () => {
    const risen: RejectionCounts = {
        recentReviewed: 10,
        recentRejected: 6,
        baselineReviewed: 40,
        baselineRejected: 4,
    };

    it('a step change in what humans reject fires the signal', () => {
        const verdict = evaluateCircuitBreaker(
            input({
                current: observation({ hour: 0, read: 5, propose: 20 }),
                rejection: risen,
            }),
        );

        expect(verdict.firing).toEqual(['REJECTION_RATE']);
        const reading = readingFor(verdict, 'REJECTION_RATE');
        expect(reading.basis).toBe('REJECTION_SHARE_ROSE');
        expect(reading.observed).toBeCloseTo(0.6, 10);
        expect(reading.expected).toBeCloseTo(0.1, 10);
    });

    it('too few reviews is NOT_JUDGED, never STEADY', () => {
        // "Nobody reviewed anything this window" is not "humans are happy with
        // this agent", and a control that reports the two identically is
        // reporting an absence as an all-clear.
        const verdict = evaluateCircuitBreaker(
            input({
                current: observation({ hour: 0, read: 5, propose: 20 }),
                rejection: { ...risen, recentReviewed: 3, recentRejected: 3 },
            }),
        );

        const reading = readingFor(verdict, 'REJECTION_RATE');
        expect(reading.state).toBe('NOT_JUDGED');
        expect(reading.basis).toBe('TOO_FEW_RECENT_REVIEWS');
        expect(verdict.code).toBe('STEADY');
    });

    it('a thin baseline of reviews is its own refusal', () => {
        const verdict = evaluateCircuitBreaker(
            input({
                current: observation({ hour: 0, read: 5, propose: 20 }),
                rejection: { ...risen, baselineReviewed: 8, baselineRejected: 1 },
            }),
        );

        expect(readingFor(verdict, 'REJECTION_RATE').basis).toBe('TOO_FEW_BASELINE_REVIEWS');
    });
});

// ─── Persistence is per SIGNAL ──────────────────────────────────────

describe('two consecutive anomalies that are not the same anomaly', () => {
    it('do not compound into a trip', () => {
        // Window one: a class this agent has never used. Window two: humans
        // rejecting its work. Both are worth arming on; neither is the claim
        // "the same thing is still true", which is the claim worth stopping an
        // agent for.
        const first = evaluateCircuitBreaker(
            input({
                baseline: readOnlyBaseline(),
                current: observation({ hour: 0, read: 4, propose: 1 }),
            }),
        );
        expect(first.streakSignals).toEqual(['TOOL_MIX']);

        const second = evaluateCircuitBreaker(
            input({
                now: at(1),
                baseline: readOnlyBaseline(),
                current: observation({ hour: 1, read: 5 }),
                rejection: {
                    recentReviewed: 10,
                    recentRejected: 6,
                    baselineReviewed: 40,
                    baselineRejected: 4,
                },
                priorStreak: first.streak,
                priorStreakSignals: first.streakSignals,
            }),
        );

        expect(second.firing).toEqual(['REJECTION_RATE']);
        expect(second.code).toBe('ARMED');
        expect(second.streak).toBe(1);
        expect(second.streakSignals).toEqual(['REJECTION_RATE']);
    });
});

// ─── The clock, and the statistics ──────────────────────────────────

describe('the module is a pure function of its argument', () => {
    it('reads no clock of its own', () => {
        // A source scan rather than a behavioural probe, because a hidden
        // `Date.now()` is invisible from the outside: the verdict would still
        // look deterministic within one run and be irreproducible across days.
        const source = codeOf(
            readFileSync(
                path.resolve(__dirname, '../../src/lib/agentic/circuit-breaker.ts'),
                'utf8',
            ),
        );
        const wallClock = source
            .split('\n')
            .map((text, i) => ({ line: i + 1, text: text.trim() }))
            .filter((l) => /Date\.now\(|new Date\(\s*\)|Math\.random\(/.test(l.text));

        expect(wallClock).toEqual([]);
    });

    it('buckets an instant into a UTC hour, and the bucket is the key', () => {
        expect(windowKeyFor(new Date(Date.parse('2026-09-01T13:59:59.999Z')))).toBe(
            '2026-09-01T13',
        );
        expect(windowStartFor(new Date(Date.parse('2026-09-01T13:59:59.999Z'))).getTime()).toBe(
            Date.parse('2026-09-01T13:00:00.000Z'),
        );
        expect(WINDOW_MS).toBe(HOUR);
    });

    it('the same input always yields the same verdict', () => {
        const fixture = input({ current: observation({ hour: 0, read: 5, propose: 90 }) });
        expect(evaluateCircuitBreaker(fixture)).toEqual(evaluateCircuitBreaker(fixture));
    });

    it('median and MAD are the robust pair, not the mean and the deviation', () => {
        expect(median([1, 2, 3, 4, 100])).toBe(3);
        expect(medianAbsoluteDeviation([1, 2, 3, 4, 100])).toBe(1);
        expect(totalVariationDistance([10, 0, 0], [0, 10, 0])).toBe(1);
        expect(totalVariationDistance([5, 5, 0], [5, 5, 0])).toBe(0);
        // An empty side is not a distance of zero because the distributions
        // match — it is a distance nobody can compute. Reported as 0 so the
        // threshold below cannot be crossed by an absence.
        expect(totalVariationDistance([], [1, 2, 3])).toBe(0);
    });
});
