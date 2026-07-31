/**
 * Executive Dashboard Widget Tests
 *
 * Structural tests for the reusable KPI/chart components.
 * Since the codebase uses SSR (no React Testing Library / jsdom),
 * these tests verify:
 *   1. Modules export correctly
 *   2. Prop contracts are correct (TypeScript-level, verified at compile)
 *   3. Source code handles empty/null/zero states
 *   4. No external chart dependencies are introduced
 *   5. Components are glass-card design-system compatible
 */

import * as fs from 'fs';
import * as path from 'path';

const UI_DIR = path.resolve(__dirname, '../../src/components/ui');

// i18n: StatusBreakdown's "No data" title flows through next-intl now.
const EN_CHART = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../messages/en.json'), 'utf-8'),
).common.chart;

// ─── Module Export Guards ───

describe('Dashboard Widget Exports', () => {
    const widgetFiles = [
        'KpiCard.tsx',
        'DonutChart.tsx',
        'TrendCard.tsx',
        'ProgressCard.tsx',
        'StatusBreakdown.tsx',
    ];

    test.each(widgetFiles)('%s exists and is non-empty', (file) => {
        const filePath = path.join(UI_DIR, file);
        expect(fs.existsSync(filePath)).toBe(true);
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content.length).toBeGreaterThan(100);
    });

    test('KpiCard exports default component and KpiCardProps type', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'KpiCard.tsx'), 'utf-8');
        expect(content).toContain('export default function KpiCard');
        expect(content).toContain('export interface KpiCardProps');
    });

    test('DonutChart exports default component and DonutSegment type', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'DonutChart.tsx'), 'utf-8');
        expect(content).toContain('export default function DonutChart');
        expect(content).toContain('export interface DonutSegment');
    });

    test('TrendCard exports a named component and TrendCardProps type', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'TrendCard.tsx'), 'utf-8');
        expect(content).toContain('export function TrendCard');
        expect(content).toContain('export interface TrendCardProps');
    });

    test('ProgressCard exports default component and ProgressCardProps type', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'ProgressCard.tsx'), 'utf-8');
        expect(content).toContain('export default function ProgressCard');
        expect(content).toContain('export interface ProgressCardProps');
    });

    test('StatusBreakdown exports default component and StatusItem type', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'StatusBreakdown.tsx'), 'utf-8');
        expect(content).toContain('export default function StatusBreakdown');
        expect(content).toContain('export interface StatusItem');
    });
});

// ─── Empty / Zero / Null State Handling ───

describe('Widget Empty State Handling', () => {
    test('KpiCard handles absent/non-finite values gracefully (renders "—")', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'KpiCard.tsx'), 'utf-8');
        // The emptiness test used to be `value === null || value === undefined`.
        // That let `NaN` through to the formatter, which printed "NaN%" — and
        // once the headline gradient swallowed the letters, bare punctuation.
        // `typeof value === 'number' && Number.isFinite(value)` subsumes both
        // original checks AND covers NaN / ±Infinity, so this asserts the
        // stronger contract rather than the shape it replaced.
        expect(content).toContain("typeof value === 'number'");
        expect(content).toContain('Number.isFinite(value)');
        expect(content).toMatch(/['"]—['"]/); // Em dash fallback
    });

    test('DonutChart handles empty segments (total === 0)', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'DonutChart.tsx'), 'utf-8');
        expect(content).toContain('total === 0');
        expect(content).toContain('No data');
    });

    test('TrendCard handles empty points via the chart emptyState prop', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'TrendCard.tsx'), 'utf-8');
        // TimeSeriesChart already empties-out on data.length === 0 and renders
        // the caller-provided emptyState, so TrendCard just needs to pass one.
        expect(content).toContain('emptyState');
        expect(content).toContain('data-trend-empty');
    });

    test('ProgressCard handles max === 0 (no division by zero)', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'ProgressCard.tsx'), 'utf-8');
        expect(content).toContain('max > 0');
    });

    test('StatusBreakdown handles zero total gracefully', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'StatusBreakdown.tsx'), 'utf-8');
        expect(content).toContain('total > 0');
        expect(content).toContain("t('noData')");
        expect(EN_CHART.noData).toBe('No data');
    });

    test('DonutChart avoids division by zero for flat range', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'DonutChart.tsx'), 'utf-8');
        // total is always checked before division
        expect(content).toContain('seg.value / total');
    });

    // TrendLine's flat-data guard moved into the shared chart layout
    // helpers (`buildYScale` / `MiniAreaChart`) — covered by
    // tests/unit/chart-layout-helpers.test.ts and
    // tests/rendered/micro-visuals.test.tsx.
});

// ─── Design System Compatibility ───

describe('Widget Design System Compliance', () => {
    test('all widgets use the canonical Card surface', () => {
        // Roadmap-5 PR-1 — the glass-card literal moved into the
        // Card primitive. Widgets now compose cardVariants(),
        // render `<Card>` directly, or delegate to a higher-order
        // wrapper (`<MetricCard>` for KpiCard) that composes the
        // primitive on their behalf.
        for (const file of ['KpiCard.tsx', 'ProgressCard.tsx', 'StatusBreakdown.tsx']) {
            const content = fs.readFileSync(path.join(UI_DIR, file), 'utf-8');
            expect(content).toMatch(/cardVariants\(|<Card\b|<MetricCard\b/);
        }
    });

    test('DonutChart and TrendCard do NOT carry the canonical Card surface (embeddable)', () => {
        // These are embeddable in other cards — no outer card wrapper.
        for (const file of ['DonutChart.tsx', 'TrendCard.tsx']) {
            const content = fs.readFileSync(path.join(UI_DIR, file), 'utf-8');
            expect(content).not.toContain('glass-card');
            expect(content).not.toMatch(/cardVariants\(/);
        }
    });

    test('chart-embeddable widgets carry an accessible aria-label', () => {
        for (const file of ['DonutChart.tsx', 'TrendCard.tsx']) {
            const content = fs.readFileSync(path.join(UI_DIR, file), 'utf-8');
            expect(content).toContain('aria-label');
        }
    });

    test('card-style widgets support className prop for customization', () => {
        for (const file of ['KpiCard.tsx', 'DonutChart.tsx', 'ProgressCard.tsx', 'StatusBreakdown.tsx']) {
            const content = fs.readFileSync(path.join(UI_DIR, file), 'utf-8');
            expect(content).toContain("className?: string");
            expect(content).toContain("className = ''");
        }
    });

    test('card-style widgets support id prop for testing', () => {
        for (const file of ['KpiCard.tsx', 'DonutChart.tsx', 'ProgressCard.tsx', 'StatusBreakdown.tsx']) {
            const content = fs.readFileSync(path.join(UI_DIR, file), 'utf-8');
            expect(content).toContain("id?: string");
        }
    });
});

// ─── Zero External Dependencies ───

describe('Widget Dependency Guard', () => {
    test('no third-party chart libraries leak into zero-dep widgets', () => {
        // DonutChart is still a zero-dep SVG widget — no chart libs.
        // TrendCard deliberately consumes the shared Epic 59 chart
        // platform (`@/components/ui/charts`) which wraps visx; the
        // boundary for new chart libraries is that shared module.
        const banned = ['recharts', 'chart.js', 'nivo', 'victory', 'tremor'];
        for (const file of ['DonutChart.tsx']) {
            const content = fs.readFileSync(path.join(UI_DIR, file), 'utf-8');
            for (const lib of banned) {
                expect(content).not.toContain(`from '${lib}`);
                expect(content).not.toContain(`from "${lib}`);
            }
        }
    });

    test('KpiCard only imports approved primitives', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'KpiCard.tsx'), 'utf-8');
        const importLines = content.split('\n').filter(l => l.trim().startsWith('import'));
        // Allowed externals:
        //   - lucide-react (icons)
        //   - @/components/ui/mini-area-chart (Epic 59 sparkline)
        //   - @/components/ui/animated-number (Epic 61 number-flow)
        //   - @/components/ui/shimmer-dots (Epic 64 ShimmerDots primitive)
        //   - @/lib/kpi-trend (Epic 41.5 — pure trend math: computeKpiTrend,
        //     formatTrendAbsolute, formatTrendPercent, trendDirectionIcon,
        //     and the TrendPolarity type. Lives outside the component so
        //     the math is reusable + tested + server-renderable.)
        // Cap raised 3 → 5 with Epic 61 + Epic 64 (animated-number,
        // shimmer-dots). Then 5 → 6 with v2-PR-8 (MetricCard chassis
        // — KpiCard now composes via the layout primitive instead of
        // hand-rolling the glass-card frame). Each addition is a
        // deliberate KpiCard polish pass on a shared primitive — kept
        // tight so new chart/state libraries don't leak in uninvited.
        const externalImports = importLines.filter(l => !l.includes('./') && !l.includes('../'));
        expect(externalImports.length).toBeLessThanOrEqual(6);
        for (const line of externalImports) {
            const allowed =
                line.includes('lucide-react') ||
                line.includes('@/components/ui/mini-area-chart') ||
                line.includes('@/components/ui/animated-number') ||
                line.includes('@/components/ui/shimmer-dots') ||
                line.includes('@/components/ui/MetricCard') ||
                line.includes('@/lib/kpi-trend');
            expect(allowed).toBe(true);
        }
    });
});

// ─── Prop Contract / Data Shape ───

describe('Widget Prop Contracts', () => {
    test('KpiCard format supports number, percent, and compact', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'KpiCard.tsx'), 'utf-8');
        expect(content).toContain("'number'");
        expect(content).toContain("'percent'");
        expect(content).toContain("'compact'");
    });

    test('DonutChart segments have label, value, color', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'DonutChart.tsx'), 'utf-8');
        expect(content).toContain('label: string');
        expect(content).toContain('value: number');
        expect(content).toContain('color: string');
    });

    test('TrendCard points is an ordered {date,value} series', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'TrendCard.tsx'), 'utf-8');
        expect(content).toContain('points: ReadonlyArray<{ date: Date; value: number }>');
    });

    test('ProgressCard supports segments for stacked bar', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'ProgressCard.tsx'), 'utf-8');
        expect(content).toContain('segments?: ProgressSegment[]');
        expect(content).toContain('export interface ProgressSegment');
    });

    test('StatusBreakdown items have label, value, color', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'StatusBreakdown.tsx'), 'utf-8');
        expect(content).toContain('label: string');
        expect(content).toContain('value: number');
        expect(content).toContain('color: string');
    });

    test('KpiCard has delta indicator support', () => {
        const content = fs.readFileSync(path.join(UI_DIR, 'KpiCard.tsx'), 'utf-8');
        expect(content).toContain('delta?: number');
        expect(content).toContain('deltaLabel?: string');
        expect(content).toMatch(/▲|▼/); // Trend arrows
    });
});
