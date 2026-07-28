/**
 * Risk Heatmap & Evidence Expiry Calendar Widget Tests
 *
 * Structural tests verifying the ExpiryCalendar component (still shipped on
 * the risk pages):
 *   1. Component exports & structure
 *   2. Empty state handling
 *   3. Color/urgency logic correctness
 *   4. Date formatting safety
 */

import * as fs from 'fs';
import * as path from 'path';
import { urgencyFromDaysUntil, URGENCY_DAYS } from '@/lib/urgency';

const UI_DIR = path.resolve(__dirname, '../../src/components/ui');
// The dashboard DTO / usecase / page-integration describes were retired when
// the Risk Matrix + Evidence Expiry widgets were removed from the dashboard
// (the heatmap/expiry-list aggregates left the executive payload; the
// exception + treatment KPIs moved to the on-demand swappable-KPI slot). Only
// the ExpiryCalendar COMPONENT tests remain here — it still ships on the risk
// pages.

// ─── Widget Exports ────────────────────────────────────────────────

// (RiskHeatmap Widget tests removed in PR-K — the legacy client
//  <RiskHeatmap> component was deleted, superseded by the config-driven
//  <RiskMatrix>. The server-side heatmap DTO + getRiskHeatmap were later
//  removed entirely when the Risk Matrix left the dashboard.)

describe('ExpiryCalendar Widget', () => {
    const content = fs.readFileSync(path.join(UI_DIR, 'ExpiryCalendar.tsx'), 'utf-8');

    test('file exists and is substantial', () => {
        expect(content.length).toBeGreaterThan(1000);
    });

    test('exports default component and ExpiryItem type', () => {
        expect(content).toContain('export default function ExpiryCalendar');
        expect(content).toContain('export interface ExpiryItem');
    });

    test('handles empty state (no items)', () => {
        expect(content).toContain('items.length === 0');
        expect(content).toContain('No upcoming evidence expirations');
    });

    test('groups by urgency levels', () => {
        expect(content).toContain("'overdue'");
        expect(content).toContain("'urgent'");
        expect(content).toContain("'upcoming'");
        expect(content).toContain("'normal'");
    });

    test('urgency color coding', () => {
        expect(content).toContain('text-red-400');
        expect(content).toContain('text-amber-400');
        expect(content).toContain('text-yellow-400');
    });

    test('formats days until correctly', () => {
        expect(content).toContain("'Today'");
        expect(content).toContain("'Tomorrow'");
        expect(content).toContain('overdue');
    });

    test('date formatting uses UTC to avoid timezone shifts', () => {
        // Epic 58 — the inline UTC formatter was replaced by the
        // canonical `formatDateCompact` helper, which declares
        // `timeZone: 'UTC'` on its shared `Intl.DateTimeFormat` in
        // `src/lib/format-date.ts`. The UTC guarantee still holds;
        // the call site just delegates instead of hardcoding the
        // option bag.
        expect(content).toContain('formatDateCompact');
    });

    test('truncates long titles', () => {
        expect(content).toContain('truncate');
    });

    test('has scrollable overflow for long lists', () => {
        expect(content).toContain('overflow-y-auto');
    });

    test('supports className and id props', () => {
        expect(content).toContain("className?: string");
        expect(content).toContain("id?: string");
    });

    test('uses the canonical Card primitive surface', () => {
        // Roadmap-5 PR-1 — the glass-card literal moved into the
        // Card primitive. Components now compose cardVariants()
        // (or render `<Card>`) instead of referencing the legacy
        // class string directly.
        expect(content).toMatch(/cardVariants\(|<Card\b/);
    });
});

// ─── Urgency Logic Unit Tests ───────────────────────────────────────

describe('ExpiryCalendar Urgency Logic', () => {
    const content = fs.readFileSync(path.join(UI_DIR, 'ExpiryCalendar.tsx'), 'utf-8');

    // These used to grep the widget's source for `daysUntil <= 7` /
    // `<= 14` literals. The thresholds now live in the shared
    // `@/lib/urgency` scale (the widget's private ≤14 tier was the only
    // place 14 appeared anywhere, and it made "upcoming" mean something
    // different here than on the calendar or the evidence KPI). Assert
    // the BEHAVIOUR of the shared classifier instead of the text of a
    // component that no longer owns the numbers.

    test('the widget consumes the shared scale rather than its own literals', () => {
        expect(content).toContain('urgencyFromDaysUntil');
        expect(content).not.toContain('daysUntil <= 14');
    });

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

    test('ordered groups: overdue first, normal last', () => {
        const overdueIdx = content.indexOf("'overdue'");
        const normalIdx = content.lastIndexOf("'normal'");
        expect(overdueIdx).toBeLessThan(normalIdx);
    });
});

// ─── Risk Heatmap Score Logic Unit Tests ─────────────────────────────

// (RiskHeatmap Score Logic tests removed in PR-K alongside the deleted
//  client <RiskHeatmap> component — <RiskMatrix> is the config-driven
//  successor with its own coverage.)
