/**
 * Epic 41 — KPI trend math.
 *
 * Locks every documented edge case so a future refactor that
 * loses the polarity flip or the zero-baseline guard fails the
 * suite immediately.
 */

import {
    computeKpiTrend,
    formatTrendAbsolute,
    formatTrendPercent,
    trendDirectionIcon,
} from '@/lib/kpi-trend';

describe('Epic 41 — computeKpiTrend', () => {
    // ─── Unavailable paths ─────────────────────────────────────────

    it('returns unavailable when current is null', () => {
        expect(computeKpiTrend({ current: null, previous: 100 })).toEqual({
            kind: 'unavailable',
            reason: 'no_current',
        });
    });

    it('returns unavailable when current is undefined', () => {
        expect(computeKpiTrend({ current: undefined, previous: 100 })).toEqual({
            kind: 'unavailable',
            reason: 'no_current',
        });
    });

    it('returns unavailable when previous is null', () => {
        expect(computeKpiTrend({ current: 50, previous: null })).toEqual({
            kind: 'unavailable',
            reason: 'no_baseline',
        });
    });

    it('returns unavailable when previous is undefined', () => {
        expect(
            computeKpiTrend({ current: 50, previous: undefined }),
        ).toEqual({ kind: 'unavailable', reason: 'no_baseline' });
    });

    // ─── Zero-baseline edge case ───────────────────────────────────

    it('returns flat when both current and previous are zero', () => {
        const r = computeKpiTrend({ current: 0, previous: 0 });
        expect(r.kind).toBe('flat');
        if (r.kind === 'flat') {
            expect(r.direction).toBe('flat');
            expect(r.deltaPercent).toBe(0);
            expect(r.semantic).toBe('neutral');
        }
    });

    it('returns unavailable: baseline_zero when previous=0 and current>0', () => {
        expect(computeKpiTrend({ current: 5, previous: 0 })).toEqual({
            kind: 'unavailable',
            reason: 'baseline_zero',
        });
    });

    it('returns unavailable: baseline_zero when previous=0 and current<0', () => {
        expect(computeKpiTrend({ current: -5, previous: 0 })).toEqual({
            kind: 'unavailable',
            reason: 'baseline_zero',
        });
    });

    // ─── Flat (no change) ──────────────────────────────────────────

    it('returns flat when current === previous', () => {
        const r = computeKpiTrend({ current: 42, previous: 42 });
        expect(r.kind).toBe('flat');
    });

    // ─── Up-good polarity (default) ────────────────────────────────

    it('positive delta with up-good polarity → semantic=good direction=up', () => {
        const r = computeKpiTrend({
            current: 80,
            previous: 60,
            polarity: 'up-good',
        });
        expect(r.kind).toBe('computed');
        if (r.kind === 'computed') {
            expect(r.direction).toBe('up');
            expect(r.semantic).toBe('good');
            expect(r.deltaAbsolute).toBe(20);
            expect(r.deltaPercent).toBeCloseTo(33.333, 2);
        }
    });

    it('negative delta with up-good polarity → semantic=bad direction=down', () => {
        const r = computeKpiTrend({
            current: 60,
            previous: 80,
            polarity: 'up-good',
        });
        expect(r.kind).toBe('computed');
        if (r.kind === 'computed') {
            expect(r.direction).toBe('down');
            expect(r.semantic).toBe('bad');
            expect(r.deltaAbsolute).toBe(-20);
            expect(r.deltaPercent).toBeCloseTo(-25, 2);
        }
    });

    // ─── Down-good polarity (e.g. overdue evidence) ────────────────

    it('negative delta with down-good polarity → semantic=good (improvement)', () => {
        // overdue-evidence dropped from 12 to 5 → green
        const r = computeKpiTrend({
            current: 5,
            previous: 12,
            polarity: 'down-good',
        });
        expect(r.kind).toBe('computed');
        if (r.kind === 'computed') {
            expect(r.direction).toBe('down');
            expect(r.semantic).toBe('good');
        }
    });

    it('positive delta with down-good polarity → semantic=bad (regression)', () => {
        // critical-risks rose from 1 to 4 → red
        const r = computeKpiTrend({
            current: 4,
            previous: 1,
            polarity: 'down-good',
        });
        expect(r.kind).toBe('computed');
        if (r.kind === 'computed') {
            expect(r.direction).toBe('up');
            expect(r.semantic).toBe('bad');
        }
    });

    // ─── Neutral polarity (e.g. tenant count) ──────────────────────

    it('any delta with neutral polarity → semantic=neutral', () => {
        const up = computeKpiTrend({
            current: 12,
            previous: 8,
            polarity: 'neutral',
        });
        const down = computeKpiTrend({
            current: 8,
            previous: 12,
            polarity: 'neutral',
        });
        expect(up.kind === 'computed' && up.semantic).toBe('neutral');
        expect(down.kind === 'computed' && down.semantic).toBe('neutral');
    });

    // ─── Negative-baseline corner ──────────────────────────────────

    it('uses |previous| in the denominator (delta from -10 to -5 is +50%, not -50%)', () => {
        const r = computeKpiTrend({
            current: -5,
            previous: -10,
            polarity: 'up-good',
        });
        expect(r.kind).toBe('computed');
        if (r.kind === 'computed') {
            // current - previous = +5; |previous| = 10 → +50%
            expect(r.deltaPercent).toBeCloseTo(50, 2);
            expect(r.direction).toBe('up');
            expect(r.semantic).toBe('good');
        }
    });

    // ─── Default polarity ──────────────────────────────────────────

    it('omitted polarity defaults to up-good', () => {
        const r = computeKpiTrend({ current: 80, previous: 60 });
        expect(r.kind === 'computed' && r.semantic).toBe('good');
    });
});

describe('Epic 41 — formatTrendPercent', () => {
    it('formats a positive delta with leading + and one decimal', () => {
        expect(formatTrendPercent(33.333)).toBe('+33.3%');
    });

    it('formats a negative delta with the proper minus glyph', () => {
        // Uses the typographic minus (U+2212), not the ASCII hyphen.
        expect(formatTrendPercent(-12.5)).toBe('−12.5%');
    });

    it('formats zero without a sign', () => {
        expect(formatTrendPercent(0)).toBe('0.0%');
    });
});

describe('Epic 41 — formatTrendAbsolute', () => {
    it('uses pp suffix for percent-format metrics', () => {
        expect(formatTrendAbsolute(2.4, 'percent')).toBe('+2.4pp');
        expect(formatTrendAbsolute(-3.1, 'percent')).toBe('−3.1pp');
    });

    it('locale-formats integers for number-format metrics', () => {
        expect(formatTrendAbsolute(1234, 'number')).toBe('+1,234');
    });

    it('compacts large numbers for compact-format metrics', () => {
        expect(formatTrendAbsolute(2_500, 'compact')).toBe('+2.5K');
        expect(formatTrendAbsolute(-1_500_000, 'compact')).toBe('−1.5M');
    });

    // ── The two branches nothing above reaches ─────────────────────
    //
    // `sign` is a NESTED ternary: `> 0 ? '+' : < 0 ? '−' : ''`. Every
    // case above is non-zero, so the innermost alternate (the empty
    // sign) was never taken — a refactor that emitted '+0' or '−0' for
    // a zero delta would have shipped green. A zero delta is not
    // hypothetical: `computeKpiTrend` returns `deltaAbsolute: 0` on its
    // `flat` shape, and the renderer formats whatever it is handed.
    it('emits NO sign glyph for a zero delta, in every format', () => {
        expect(formatTrendAbsolute(0, 'number')).toBe('0');
        expect(formatTrendAbsolute(0, 'percent')).toBe('0.0pp');
        expect(formatTrendAbsolute(0, 'compact')).toBe('0');
    });

    // The compact ladder had its ≥1M and ≥1K rungs covered but never
    // fell THROUGH both. A sub-thousand compact delta must render
    // verbatim — not as "0.3K".
    it('leaves sub-thousand compact deltas un-abbreviated', () => {
        expect(formatTrendAbsolute(250, 'compact')).toBe('+250');
        expect(formatTrendAbsolute(-999, 'compact')).toBe('−999');
    });

    // The 1_000 / 1_000_000 rungs are `>=`, not `>`. Pinned because an
    // off-by-one to `>` would push exactly-1K through to the bare
    // branch and render "+1,000" where the UI expects "+1.0K".
    it('treats the rung thresholds as inclusive', () => {
        expect(formatTrendAbsolute(1_000, 'compact')).toBe('+1.0K');
        expect(formatTrendAbsolute(1_000_000, 'compact')).toBe('+1.0M');
    });
});

describe('Epic 41 — trendDirectionIcon', () => {
    it.each([
        ['up', '▲'],
        ['down', '▼'],
        ['flat', '—'],
    ] as const)('%s → %s', (direction, expected) => {
        expect(trendDirectionIcon(direction)).toBe(expected);
    });
});
