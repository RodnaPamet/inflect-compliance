/**
 * Shared urgency-scale behaviour (`@/lib/urgency`).
 *
 * This file used to be `risk-heatmap-expiry.test.ts` and carried three
 * layers: structural greps over the client `<RiskHeatmap>` widget, the same
 * over the dashboard `<ExpiryCalendar>` widget, and behavioural tests for the
 * threshold scale both consumed. Both widgets are gone — `<RiskHeatmap>` was
 * superseded by the config-driven `<RiskMatrix>` (PR-K), and `<ExpiryCalendar>`
 * was deleted when the Evidence Expiry card left the dashboard, which left it
 * with no consumer anywhere.
 *
 * The threshold scale outlived both, and it is the part that was ever worth
 * guarding: the server shapes KPI date-range queries from these numbers and
 * the client renders tone/labels from them, so a silent change to either
 * boundary desynchronises the compliance calendar, the evidence KPI buckets,
 * and every "due soon" label in the product. These are behavioural assertions
 * against the classifier, not greps of a component that happens to call it.
 */

import { urgencyFromDaysUntil, URGENCY_DAYS } from '@/lib/urgency';

describe('urgency scale — threshold classification', () => {
    test('overdue: any negative distance', () => {
        expect(urgencyFromDaysUntil(-1)).toBe('overdue');
        expect(urgencyFromDaysUntil(-90)).toBe('overdue');
    });

    test('urgent: today through the 7-day boundary', () => {
        expect(urgencyFromDaysUntil(0)).toBe('urgent');
        expect(urgencyFromDaysUntil(URGENCY_DAYS.URGENT)).toBe('urgent');
    });

    test('upcoming: just past urgent, through the 30-day boundary', () => {
        expect(urgencyFromDaysUntil(URGENCY_DAYS.URGENT + 1)).toBe('upcoming');
        expect(urgencyFromDaysUntil(URGENCY_DAYS.UPCOMING)).toBe('upcoming');
    });

    test('normal: beyond the upcoming boundary', () => {
        expect(urgencyFromDaysUntil(URGENCY_DAYS.UPCOMING + 1)).toBe('normal');
    });

    test('the boundaries are the shared numbers, not re-declared literals', () => {
        // Pins the scale itself: 7/30 are load-bearing for the evidence KPI's
        // dueSoon7d / dueSoon30d buckets and the calendar's "due_soon" window.
        expect(URGENCY_DAYS.URGENT).toBe(7);
        expect(URGENCY_DAYS.UPCOMING).toBe(30);
    });
});
