/**
 * #2461 — how OLD is the evidence a verdict judged against?
 *
 * The investigation behind this file: `BASELINE_WINDOW_LIMIT` bounds the
 * baseline by COUNT, and the count is of ACTIVE windows — hours in which the
 * agent was observed at all. That is the right rate to judge (a missing hour is
 * ambiguous, and reading it as a hard zero drifts the baseline toward zero), but
 * it means the count says nothing about AGE.
 *
 * 168 active windows is seven days for an agent that calls every hour and about
 * 84 days for one that calls twice a day. So a verdict could read "STEADY
 * against 168 windows" while the history it compared against began three months
 * earlier, and nothing in the verdict said so. The only other bound is
 * `baselineEpoch`, which a HUMAN advances — it constrains age only when somebody
 * acts.
 *
 * These tests pin the two fields that make that legible. They change no
 * judgement: every assertion here is about what the verdict REPORTS, not about
 * what it decides.
 */
import {
    evaluateCircuitBreaker,
    windowKeyFor,
    type BreakerInput,
    type BreakerObservation,
    type RejectionCounts,
} from '@/lib/agentic/circuit-breaker';

const HOUR = 3_600_000;
/** A fixed instant. Nothing in this file asks the machine what time it is. */
const EPOCH = Date.parse('2026-09-01T00:00:00.000Z');
const at = (hour: number): Date => new Date(EPOCH + hour * HOUR);

const NO_REVIEWS: RejectionCounts = {
    recentReviewed: 0,
    recentRejected: 0,
    baselineReviewed: 0,
    baselineRejected: 0,
};

function observation(hour: number, propose = 20): BreakerObservation {
    return {
        windowKey: windowKeyFor(at(hour)),
        readCalls: 5,
        proposeCalls: propose,
        orchestrateCalls: 0,
        toolNames: ['agent.propose_risk'],
        anomalous: false,
    };
}

function input(baseline: BreakerObservation[]): BreakerInput {
    return {
        now: at(0),
        baseline,
        current: observation(0),
        rejection: NO_REVIEWS,
        priorStreak: 0,
        priorStreakSignals: [],
    };
}

/** Twelve CONSECUTIVE hours — the continuously-busy agent. */
const CONSECUTIVE = Array.from({ length: 12 }, (_u, i) => observation(-1 - i));

/**
 * Twelve windows spread TWO PER DAY across twelve days — the same COUNT, the
 * same figures, twelve times the age. This pair is the whole point of the file.
 */
const INTERMITTENT = Array.from({ length: 12 }, (_u, i) =>
    observation(-24 * Math.floor(i / 2) - (i % 2) - 1),
);

describe('the baseline reports how far back it reaches', () => {
    it('a continuously busy agent: 12 windows spanning 12 hours', () => {
        const v = evaluateCircuitBreaker(input(CONSECUTIVE));
        expect(v.baseline.windows).toBe(12);
        expect(v.baseline.oldestWindowKey).toBe(windowKeyFor(at(-12)));
        expect(v.baseline.spanHours).toBe(12);
    });

    it('an intermittent agent: THE SAME 12 windows, spanning 12 DAYS', () => {
        const v = evaluateCircuitBreaker(input(INTERMITTENT));
        // Identical by every figure the verdict reported before #2461 …
        expect(v.baseline.windows).toBe(12);
        expect(v.baseline.observations).toBe(
            evaluateCircuitBreaker(input(CONSECUTIVE)).baseline.observations,
        );
        // … and the evidence is an order of magnitude older.
        expect(v.baseline.spanHours).toBeGreaterThan(24 * 5);
        expect(v.baseline.oldestWindowKey).toBe(windowKeyFor(at(-24 * 5 - 1 - 1)));
    });

    it('the two are indistinguishable by count and distinguishable by span', () => {
        // Stated as one assertion because it is the finding: the count cannot
        // separate them, and that was the whole bug.
        const busy = evaluateCircuitBreaker(input(CONSECUTIVE)).baseline;
        const sparse = evaluateCircuitBreaker(input(INTERMITTENT)).baseline;
        expect(sparse.windows).toBe(busy.windows);
        expect(sparse.spanHours).toBeGreaterThan(busy.spanHours!);
    });
});

describe('the edges', () => {
    it('an EMPTY baseline reports null, not a span of zero', () => {
        // "No oldest window" and "the oldest window is the current one" are
        // different facts; zero would read as the second.
        const v = evaluateCircuitBreaker(input([]));
        expect(v.baseline.windows).toBe(0);
        expect(v.baseline.oldestWindowKey).toBeNull();
        expect(v.baseline.spanHours).toBeNull();
        expect(v.code).toBe('NO_BASELINE');
    });

    it('reports the span even when the baseline is TOO THIN to judge', () => {
        // NO_BASELINE is the verdict that most needs its age visible: "wait for
        // more history" reads differently when the history you have is stale.
        const v = evaluateCircuitBreaker(input(CONSECUTIVE.slice(0, 3)));
        expect(v.code).toBe('NO_BASELINE');
        expect(v.baseline.spanHours).toBe(3);
        expect(v.baseline.oldestWindowKey).toBe(windowKeyFor(at(-3)));
    });

    it('the ANOMALOUS windows dropped from the baseline are dropped from the span too', () => {
        // The detector must not learn from the anomaly, and it must not date
        // itself from one either — an excluded window is not evidence.
        const withOldAnomaly: BreakerObservation[] = [
            ...CONSECUTIVE,
            { ...observation(-500), anomalous: true },
        ];
        const v = evaluateCircuitBreaker(input(withOldAnomaly));
        expect(v.baseline.windows).toBe(12);
        expect(v.baseline.spanHours).toBe(12);
        expect(v.baseline.oldestWindowKey).toBe(windowKeyFor(at(-12)));
    });

    it('does not depend on the caller ordering the baseline newest-first', () => {
        // The store hands them back `orderBy windowStart desc`. Taking the
        // minimum rather than the last element means a caller that sorts
        // differently still gets a true answer.
        const shuffled = [...CONSECUTIVE].reverse();
        const v = evaluateCircuitBreaker(input(shuffled));
        expect(v.baseline.oldestWindowKey).toBe(windowKeyFor(at(-12)));
        expect(v.baseline.spanHours).toBe(12);
    });

    it('the oldest key keeps the detector bucket shape, `YYYY-MM-DDTHH`', () => {
        // THIS TEST WAS CALLED "the span is UTC, not the reader local time" and
        // it could not prove that. Recorded rather than quietly renamed, because
        // the reasoning is the reusable part.
        //
        // `spanHours` is a DIFFERENCE between two instants that BOTH come out of
        // `windowStartFromKey`. Parse the keys as local time instead of UTC and
        // each moves by the reader's offset, so the offset cancels and the span
        // is unchanged. Rebuilding the implementation without its `Z` — the real
        // bug the old name named — left this file 8/8 GREEN under TZ=UTC and
        // under TZ=Asia/Kolkata alike. Only a pair straddling a DST transition
        // would discriminate, and only in a DST-observing zone, which CI is not.
        //
        // So the honest claim is the one left: the key's SHAPE. That half IS
        // live — rebuilding `windowKeyFor` as `slice(0, 16)` reddens this and
        // six of its siblings — and it is worth pinning, because the key is what
        // `windowStartFromKey` appends `:00:00.000Z` to. A key carrying minutes
        // would make that string unparseable rather than merely wrong.
        //
        // What guards the UTC-ness itself is `windowKeyFor` being built from
        // `toISOString()`, one assertion away in this same file, plus the
        // docstring on `windowStartFromKey`. Not this test.
        const v = evaluateCircuitBreaker(input(CONSECUTIVE));
        expect(v.baseline.oldestWindowKey).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
        expect(v.baseline.spanHours).toBe(12);
    });
});
