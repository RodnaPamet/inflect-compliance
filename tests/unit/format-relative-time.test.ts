/**
 * Epic 63 — `formatRelativeTime` helper.
 *
 * Pure helper, node project. The component-level tests live in
 * `tests/rendered/timestamp-tooltip.test.tsx`; this file pins the
 * underlying helper's null/invalid handling and addSuffix toggle so
 * those contracts are covered without needing jsdom.
 */
import { formatRelativeTime } from '@/lib/format-date';

const NOW = new Date('2026-05-03T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
    it('renders past dates with the "ago" suffix by default', () => {
        const past = new Date(NOW.getTime() - 2 * HOUR);
        expect(formatRelativeTime(past, NOW)).toMatch(/ago$/);
    });

    it('renders future dates with the "in" prefix by default', () => {
        const future = new Date(NOW.getTime() + 3 * DAY);
        expect(formatRelativeTime(future, NOW)).toMatch(/^in /);
    });

    it('omits suffix when addSuffix=false', () => {
        const past = new Date(NOW.getTime() - 2 * HOUR);
        const out = formatRelativeTime(past, NOW, { addSuffix: false });
        expect(out).not.toMatch(/ago/);
        expect(out).not.toMatch(/^in /);
    });

    it('returns the fallback when value is null', () => {
        expect(formatRelativeTime(null, NOW)).toBe('—');
    });

    it('returns the fallback when value is undefined', () => {
        expect(formatRelativeTime(undefined, NOW)).toBe('—');
    });

    it('returns the fallback when value is unparseable', () => {
        expect(formatRelativeTime('not-a-date', NOW)).toBe('—');
    });

    it('returns the fallback when now is null (hydration-safe)', () => {
        const past = new Date(NOW.getTime() - 2 * HOUR);
        expect(formatRelativeTime(past, null)).toBe('—');
    });

    it('honours a custom fallback string', () => {
        expect(formatRelativeTime(null, NOW, {}, 'unknown')).toBe('unknown');
    });

    it('formats sub-minute deltas via includeSeconds default', () => {
        const just = new Date(NOW.getTime() - 5_000);
        expect(formatRelativeTime(just, NOW)).toMatch(/less than/);
    });

    it('parses ISO strings as well as Date inputs', () => {
        const past = new Date(NOW.getTime() - 2 * HOUR).toISOString();
        const out = formatRelativeTime(past, NOW);
        expect(out).toMatch(/2 hours ago/);
    });
    // ── includeSeconds: the explicit-false branch ──────────────────
    //
    // `includeSeconds` defaults to true (`options.includeSeconds ?? true`).
    // Nothing exercised the caller-supplied side of that `??`, so a
    // refactor that ignored the option — or inverted the default — would
    // not have failed a test. A 25-second delta is the cheapest input
    // that separates the two: date-fns reports "half a minute" only when
    // seconds are included, and "less than a minute" when they are not.
    it('reports sub-minute deltas in seconds granularity when includeSeconds is left default', () => {
        const just = new Date(NOW.getTime() - 25_000);
        expect(formatRelativeTime(just, NOW)).toBe('half a minute ago');
    });

    it('collapses the same delta to minute granularity when includeSeconds=false', () => {
        const just = new Date(NOW.getTime() - 25_000);
        expect(formatRelativeTime(just, NOW, { includeSeconds: false })).toBe(
            'less than a minute ago',
        );
    });

    it('composes includeSeconds=false with addSuffix=false', () => {
        const just = new Date(NOW.getTime() - 25_000);
        expect(
            formatRelativeTime(just, NOW, {
                includeSeconds: false,
                addSuffix: false,
            }),
        ).toBe('less than a minute');
    });
});
