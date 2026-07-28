/**
 * R17-PR9 — Extend chart-filter awareness to coverage + evidence.
 *
 * PR-8 made the Risk Distribution donut react to `selectedKpi`.
 * PR-9 extracts the focus-or-dim behaviour into a reusable
 * `ChartFocusWrapper` and applies it to two more sections:
 *
 *   • Control Coverage (ProgressCard) — focused when
 *     `selectedKpi === 'coverage'`.
 *   • Evidence Status (StatusBreakdown) — focused when
 *     `selectedKpi === 'evidence'`.
 *
 * Three of the six KPI tiles now visually connect to a chart:
 * Risks ↔ donut (PR-8), Coverage ↔ ProgressCard (PR-9), Evidence
 * ↔ StatusBreakdown (PR-9). Tasks / Policies / Findings still
 * dim everything else; their charts arrive in PR-10+ if needed.
 *
 * Six load-bearing invariants:
 *
 *   1. The reusable wrapper exists and reads `selectedKpi` via
 *      `useDashboardChartFocus`. Future chart consumers wire
 *      with one prop (`kpiKey`) — no per-section duplication of
 *      the focus / dim logic.
 *
 *   2. The wrapper computes focus + dim with the same boolean
 *      pattern PR-8 established (`isFocused = selectedKpi ===
 *      kpiKey`, `isDimmed = selectedKpi !== null && !isFocused`).
 *      Drift here desyncs the wrapped sections from
 *      RiskDistributionSection.
 *
 *   3. The wrapper exposes the canonical contract DOM attributes
 *      `data-chart-focus`, `data-chart-dimmed`, AND a new
 *      `data-chart-focus-key=<kpiKey>` so future telemetry / E2E
 *      can identify WHICH chart any DOM node belongs to.
 *
 *   4. The wrapper applies the visual recipe:
 *      `ring-2 ring-brand-default ring-offset-2` on focus, and
 *      `opacity-60` on dim. Same recipe PR-8 used inline.
 *
 *   5. ProgressCard (control-coverage) is wrapped with
 *      `kpiKey="coverage"`.
 *
 *   6. EvidenceStatusSection is wrapped with `kpiKey="evidence"`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(
    path.join(
        ROOT,
        'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx',
    ),
    'utf8',
);

describe('R17-PR9 — charts subscribe via ChartFocusWrapper', () => {
    it('defines ChartFocusWrapper component', () => {
        expect(SRC).toMatch(/function\s+ChartFocusWrapper\s*\(\s*\{/);
    });

    it('wrapper reads selectedKpi from the chart-filter hook', () => {
        expect(SRC).toMatch(
            /function\s+ChartFocusWrapper[\s\S]*?const\s+\{\s*selectedKpi\s*\}\s*=\s*useDashboardChartFocus\(\)/,
        );
    });

    it('wrapper focus + dim booleans match the PR-8 pattern', () => {
        expect(SRC).toMatch(
            /const\s+isFocused\s*=\s*selectedKpi\s*===\s*kpiKey/,
        );
        expect(SRC).toMatch(
            /const\s+isDimmed\s*=\s*selectedKpi\s*!==\s*null\s*&&\s*!isFocused/,
        );
    });

    it('wrapper exposes the contract DOM attributes', () => {
        expect(SRC).toMatch(
            /data-chart-focus=\{isFocused\s*\?\s*['"]true['"]\s*:\s*undefined\}/,
        );
        expect(SRC).toMatch(
            /data-chart-dimmed=\{isDimmed\s*\?\s*['"]true['"]\s*:\s*undefined\}/,
        );
        // NEW in PR-9: tag the rendered DOM with WHICH kpi key
        // this chart belongs to. Future telemetry / E2E reads
        // the attribute directly rather than parsing className.
        expect(SRC).toMatch(/data-chart-focus-key=\{kpiKey\}/);
    });

    it('wrapper applies the focus + dim visual recipe', () => {
        expect(SRC).toMatch(
            /isFocused\s*&&[\s\S]*?ring-2\s+ring-brand-default\s+ring-offset-2/,
        );
        expect(SRC).toMatch(/isDimmed\s*&&\s*['"]opacity-60['"]/);
    });

    it('ProgressCard (control coverage) is wrapped with kpiKey="coverage"', () => {
        // Look for the wrapper wrapping ProgressCard whose
        // id is `control-coverage`.
        expect(SRC).toMatch(
            /<ChartFocusWrapper\s+kpiKey="coverage"[\s\S]*?<ProgressCard[\s\S]*?id="control-coverage"/,
        );
    });
    // (The Evidence Status section was folded into the on-demand swappable-KPI
    // slot; its `kpiKey="evidence"` focus wrapper went with it. The evidence
    // TREND tile keeps its own `kpiKey="evidence"` wrapper in the Trend section.)
});
