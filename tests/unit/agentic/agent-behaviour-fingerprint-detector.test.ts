/**
 * The behaviour fingerprint's detector, on synthetic series (Morpheus roadmap
 * Phase 1). Pure: no database, no clock.
 *
 * The properties, each named for the invariant it holds:
 *   - a seeded anomaly (an agent tripling its reads) is caught, and NONE of the
 *     baseline days around it is flagged — precision on baseline days is the
 *     roadmap's eval;
 *   - no verdict without a baseline (LEARNING, never a finding);
 *   - a flat history cannot make every deviation infinite (σ floor);
 *   - a quiet agent's tripling is not an anomaly (absolute delta);
 *   - only upward departures score;
 *   - the detector does not learn from the anomaly (inBaseline=false);
 *   - only the most recent BASELINE_MAX_DAYS judge, whatever order they arrive in;
 *   - a change a person ACCEPTED on the breaker re-baselines the fingerprint, and
 *     only a person's epoch does — a latch's row-creation default does not.
 */
import {
    BASELINE_MAX_DAYS,
    BASELINE_MIN_DAYS,
    baselineDaysSinceEpoch,
    buildFeatures,
    FINGERPRINT_FEATURES,
    personSetBaselineEpoch,
    previousUtcDay,
    scoreDay,
    Z_FINDING,
    Z_LATCH,
    type FingerprintFeatures,
} from '@/lib/agentic/behaviour-fingerprint';

/** Deterministic noise: a small LCG, so every run sees the same series. */
function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

/** A realistic daily agent: ~120 reads, a few proposals, ~40 model calls. */
function normalDay(rand: () => number): FingerprintFeatures {
    const jitter = (centre: number, spread: number) => Math.max(0, Math.round(centre + (rand() - 0.5) * 2 * spread));
    return buildFeatures({
        readCalls: jitter(120, 25),
        proposeCalls: jitter(6, 3),
        orchestrateCalls: jitter(2, 2),
        activeHours: jitter(8, 2),
        proposals: jitter(5, 3),
        guardFlags: rand() < 0.1 ? 1 : 0,
        modelCalls: jitter(40, 10),
        tokensIn: jitter(30_000, 6_000),
        tokensOut: jitter(8_000, 2_000),
    });
}

const dayKey = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 86_400_000).toISOString().slice(0, 10);

/**
 * Walk a series day by day exactly as the nightly job does: each day is judged
 * against the in-baseline days before it, and stored with its own inBaseline.
 */
function walk(series: FingerprintFeatures[]) {
    const stored: { day: string; features: FingerprintFeatures; inBaseline: boolean }[] = [];
    return series.map((today, i) => {
        const r = scoreDay({ today, baseline: stored.filter((s) => s.inBaseline) });
        stored.push({ day: dayKey(i), features: today, inBaseline: r.inBaseline });
        return r;
    });
}

describe('the seeded anomaly is caught and the baseline days are not flagged', () => {
    const rand = lcg(42);
    const series = Array.from({ length: 30 }, () => normalDay(rand));
    const tripled = { ...normalDay(rand) };
    tripled.readCalls = series.slice(-BASELINE_MAX_DAYS).reduce((s, d) => s + d.readCalls, 0) / BASELINE_MAX_DAYS * 3;
    const verdicts = walk([...series, buildFeatures(tripled)]);

    it('no baseline day is ever ANOMALOUS', () => {
        const flagged = verdicts.slice(0, 30).filter((v) => v.verdict === 'ANOMALOUS');
        expect(flagged).toEqual([]);
    });

    it('the first BASELINE_MIN_DAYS days are LEARNING and raise nothing', () => {
        expect(verdicts.slice(0, BASELINE_MIN_DAYS).every((v) => v.verdict === 'LEARNING' && v.tier === null)).toBe(true);
        expect(verdicts[BASELINE_MIN_DAYS].verdict).toBe('STEADY');
    });

    it('the tripled-reads day is ANOMALOUS, driven by readCalls', () => {
        const last = verdicts[30];
        expect(last.verdict).toBe('ANOMALOUS');
        expect(last.drivers.map((d) => d.feature)).toEqual(['readCalls']);
        expect(last.score).toBeGreaterThanOrEqual(Z_FINDING);
        expect(last.inBaseline).toBe(false);
    });
});

describe('thresholds A and B', () => {
    const rand = lcg(7);
    const baseline = Array.from({ length: 20 }, (_, i) => ({ day: dayKey(i), features: normalDay(rand) }));
    const mean = baseline.reduce((s, b) => s + b.features.readCalls, 0) / baseline.length;

    it('a large departure is tier LATCH, a moderate one tier FINDING', () => {
        const huge = scoreDay({ today: { ...baseline[0].features, readCalls: Math.round(mean * 10) }, baseline });
        expect(huge.tier).toBe('LATCH');
        expect(huge.score).toBeGreaterThanOrEqual(Z_LATCH);

        // Find the smallest read count that crosses A; it must be below B.
        let reads = Math.round(mean);
        let r = scoreDay({ today: { ...baseline[0].features, readCalls: reads }, baseline });
        while (r.verdict !== 'ANOMALOUS') {
            reads += 1;
            r = scoreDay({ today: { ...baseline[0].features, readCalls: reads }, baseline });
        }
        expect(r.tier).toBe('FINDING');
        expect(r.score).toBeLessThan(Z_LATCH);
    });
});

describe('false-positive suppressions', () => {
    const flat = (overrides: Partial<Record<keyof FingerprintFeatures, number>>) =>
        buildFeatures({ readCalls: 10, modelCalls: 5, activeHours: 2, ...overrides });
    const flatBaseline = Array.from({ length: 20 }, (_, i) => ({ day: dayKey(i), features: flat({}) }));

    it('a flat history does not make a one-unit change infinite (σ floor)', () => {
        const r = scoreDay({ today: flat({ readCalls: 11 }), baseline: flatBaseline });
        expect(r.verdict).toBe('STEADY');
        for (const reading of r.readings) expect(Number.isFinite(reading.z)).toBe(true);
    });

    it('a quiet agent tripling 2 → 6 proposals is not an anomaly (absolute delta)', () => {
        const quiet = Array.from({ length: 20 }, (_, i) => ({ day: dayKey(i), features: flat({ proposals: 2 }) }));
        const r = scoreDay({ today: flat({ proposals: 6 }), baseline: quiet });
        expect(r.verdict).toBe('STEADY');
        expect(r.readings.find((x) => x.feature === 'proposals')!.z).toBeGreaterThanOrEqual(Z_FINDING);
    });

    it('a day far BELOW the baseline is never anomalous', () => {
        const busy = Array.from({ length: 20 }, (_, i) => ({ day: dayKey(i), features: flat({ readCalls: 500 }) }));
        const r = scoreDay({ today: flat({ readCalls: 1 }), baseline: busy });
        expect(r.verdict).toBe('STEADY');
        expect(r.readings.every((x) => x.z >= 0)).toBe(true);
    });
});

describe('the detector does not learn from the anomaly', () => {
    it('a run of spiked days stays anomalous because no spike ever entered the baseline', () => {
        const rand = lcg(99);
        const series = Array.from({ length: 20 }, () => normalDay(rand));
        const spike = { ...series[0], readCalls: 600 };
        const v = walk([...series, spike, spike, spike, spike, spike]);
        expect(v.slice(20).map((x) => x.verdict)).toEqual(Array(5).fill('ANOMALOUS'));
        expect(v.slice(20).every((x) => x.inBaseline === false)).toBe(true);
    });
});

describe('the baseline window', () => {
    it('uses only the most recent BASELINE_MAX_DAYS, whatever order they arrive in', () => {
        const old = Array.from({ length: 40 }, (_, i) => ({
            day: dayKey(i),
            features: buildFeatures({ readCalls: 1000, activeHours: 1 }),
        }));
        const recent = Array.from({ length: BASELINE_MAX_DAYS }, (_, i) => ({
            day: dayKey(100 + i),
            features: buildFeatures({ readCalls: 100, activeHours: 1 }),
        }));
        const shuffled = [...recent, ...old].reverse();
        const r = scoreDay({ today: buildFeatures({ readCalls: 1000, activeHours: 1 }), baseline: shuffled });
        expect(r.baselineDays).toBe(BASELINE_MAX_DAYS);
        expect(r.verdict).toBe('ANOMALOUS');
    });
});

describe('features are counts', () => {
    it('buildFeatures yields exactly the fingerprint, non-negative integers, hours capped at 24', () => {
        const f = buildFeatures({ readCalls: -3, activeHours: 99, tokensIn: 5.7, tokensOut: null });
        expect(Object.keys(f).sort()).toEqual([...FINGERPRINT_FEATURES].sort());
        expect(f.readCalls).toBe(0);
        expect(f.activeHours).toBe(24);
        expect(f.tokens).toBe(5);
    });

    it('a nightly run scores the UTC day that just closed', () => {
        const d = previousUtcDay(new Date('2026-11-12T01:53:00.000Z'));
        expect(d.day).toBe('2026-11-11');
        expect(d.start.toISOString()).toBe('2026-11-11T00:00:00.000Z');
        expect(d.end.toISOString()).toBe('2026-11-12T00:00:00.000Z');
    });
});

describe('a re-baseline a person accepted on the breaker', () => {
    /**
     * Walk the nightly job with a breaker beside it: a night that scores LATCH
     * opens the breaker (when it is closed), and `closeOn[i]` closes it on the
     * morning of day i with the given reason, as `closeAgentCircuitBreaker`
     * would — ACCEPTED_NEW_BASELINE moves the epoch to that instant.
     */
    function walkWithBreaker(series: FingerprintFeatures[], closeOn: Record<number, 'ACCEPTED_NEW_BASELINE' | 'RESOLVED'>) {
        const createdAt = new Date(Date.parse(`${dayKey(0)}T00:00:00.000Z`));
        const breaker = { state: 'CLOSED' as 'CLOSED' | 'OPEN', baselineEpoch: createdAt, createdAt };
        const stored: { day: string; features: FingerprintFeatures; inBaseline: boolean }[] = [];
        const latchedOn: number[] = [];
        const verdicts = series.map((today, i) => {
            const reason = closeOn[i];
            if (reason && breaker.state === 'OPEN') {
                breaker.state = 'CLOSED';
                if (reason === 'ACCEPTED_NEW_BASELINE') {
                    breaker.baselineEpoch = new Date(Date.parse(`${dayKey(i)}T10:00:00.000Z`));
                }
            }
            const r = scoreDay({
                today,
                baseline: baselineDaysSinceEpoch(stored.filter((s) => s.inBaseline), personSetBaselineEpoch(breaker)),
            });
            stored.push({ day: dayKey(i), features: today, inBaseline: r.inBaseline });
            if (r.tier === 'LATCH' && breaker.state === 'CLOSED') {
                breaker.state = 'OPEN';
                latchedOn.push(i);
            }
            return r;
        });
        return { verdicts, latchedOn };
    }

    const rand = lcg(2026);
    const before = Array.from({ length: 30 }, () => normalDay(rand));
    // A deliberate, lasting step change: reads go from ~120 to ~400 a day.
    const after = Array.from({ length: 40 }, () => ({ ...normalDay(rand), readCalls: 400 + Math.round(rand() * 20) }));
    const series = [...before, ...after];

    it('ACCEPTED_NEW_BASELINE stops the nightly re-latch: the agent re-learns, then judges against its new normal', () => {
        const { verdicts, latchedOn } = walkWithBreaker(series, { 31: 'ACCEPTED_NEW_BASELINE' });
        expect(latchedOn).toEqual([30]);
        // Day 31 began before the epoch (10:00), so it is scored on nothing and
        // later discarded; from day 31 the agent is LEARNING, never ANOMALOUS.
        expect(verdicts.slice(31, 31 + BASELINE_MIN_DAYS + 1).every((v) => v.verdict === 'LEARNING')).toBe(true);
        expect(verdicts.slice(31).filter((v) => v.verdict === 'ANOMALOUS')).toEqual([]);
        expect(verdicts[31 + BASELINE_MIN_DAYS + 1].verdict).toBe('STEADY');
    });

    it('RESOLVED keeps the old baseline: the same behaviour latches again the next night', () => {
        const { latchedOn } = walkWithBreaker(series, { 31: 'RESOLVED' });
        expect(latchedOn).toEqual([30, 31]);
    });

    it('a breaker row whose epoch is still its creation default re-baselines nothing', () => {
        const created = new Date('2026-10-20T03:00:00.000Z');
        expect(personSetBaselineEpoch({ baselineEpoch: created, createdAt: created })).toBeNull();
        expect(personSetBaselineEpoch(null)).toBeNull();
        const moved = new Date('2026-10-21T09:30:00.000Z');
        expect(personSetBaselineEpoch({ baselineEpoch: moved, createdAt: created })).toBe(moved);
    });

    it('a day that began before the epoch is discarded whole; a day beginning at it is kept', () => {
        const days = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'].map((day) => ({ day }));
        expect(baselineDaysSinceEpoch(days, new Date('2026-10-20T10:00:00.000Z')).map((d) => d.day))
            .toEqual(['2026-10-21', '2026-10-22']);
        expect(baselineDaysSinceEpoch(days, new Date('2026-10-21T00:00:00.000Z')).map((d) => d.day))
            .toEqual(['2026-10-21', '2026-10-22']);
        expect(baselineDaysSinceEpoch(days, null)).toHaveLength(4);
    });
});
