/**
 * Epic 59 — chart platform foundation guardrails.
 *
 * These are contract checks that fire on every CI run. They keep
 * the chart platform's foundation durable as later Epic 59 prompts
 * build on top of it:
 *
 *   1. Required `@visx/*` dependencies are pinned in `package.json`.
 *   2. No competing chart library (recharts, chart.js, victory,
 *      react-vis, react-chartjs-2) sneaks in — one chart system.
 *   3. The canonical barrel at `src/components/ui/charts/index.ts`
 *      exports the expected public surface. A refactor that silently
 *      drops `Areas` / `Bars` / `TimeSeriesChart` / `FunnelChart` /
 *      `ChartTooltipSync` / `ChartContext` / type aliases would
 *      break every downstream consumer; the guardrail catches it.
 *   4. Every canonical sub-module lives where the barrel expects it.
 *   5. The module's private helpers (`use-tooltip.ts`, `utils.ts`)
 *      stay private — never re-exported via `index.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

import { codeOf, commentsOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// The chart platform now spans TWO roots (#3046): the neutral primitives live
// in `packages/ui`, while ChartFrame, the four charts that wrap it and the two
// quantitative-risk widgets stayed in `src`. A module is resolved in whichever
// root holds it, so this guard keeps asserting the canonical layout without
// caring which side of the extraction a given file is on — and still fails if a
// module exists in NEITHER.
const CHART_ROOTS = [
    path.join(ROOT, 'packages/ui/src/components/ui/charts'),
    path.join(ROOT, 'src/components/ui/charts'),
];
const chartPath = (rel: string): string =>
    CHART_ROOTS.find((d) => fs.existsSync(path.join(d, rel))) !== undefined
        ? path.join(CHART_ROOTS.find((d) => fs.existsSync(path.join(d, rel)))!, rel)
        : path.join(CHART_ROOTS[1], rel);
const CHARTS_DIR = CHART_ROOTS[1];
const PKG = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function hasDep(name: string): boolean {
    return (
        (PKG.dependencies && name in PKG.dependencies) ||
        (PKG.devDependencies && name in PKG.devDependencies) ||
        false
    );
}

function read(rel: string): string {
    return codeOf(fs.readFileSync(chartPath(rel), 'utf-8'));
}

function readRaw(rel: string): string {
    return fs.readFileSync(chartPath(rel), 'utf-8');
}

/**
 * COMMENTS ONLY — the inverse of `read()`. Used by the header-contract
 * assertion below, which is deliberately ABOUT a comment: `codeOf` would
 * delete its subject, and a RAW read would let the same words appearing
 * anywhere in the module's code satisfy a check that the contract is
 * documented (#2246).
 */
const readComments = (rel: string) => commentsOf(readRaw(rel));

describe('Epic 59 — chart platform foundation', () => {
    it('required @visx/* packages are present', () => {
        const required = [
            '@visx/group',
            '@visx/responsive',
            '@visx/scale',
            '@visx/shape',
        ];
        const missing = required.filter((d) => !hasDep(d));
        expect(missing).toEqual([]);
    });

    it('no competing chart libraries are installed', () => {
        const banned = [
            'recharts',
            'chart.js',
            'victory',
            'react-vis',
            'react-chartjs-2',
            'apexcharts',
            'nivo',
            '@nivo/core',
        ];
        const present = banned.filter((d) => hasDep(d));
        expect(present).toEqual([]);
    });

    it.each([
        'areas.tsx',
        'bars.tsx',
        'chart-context.ts',
        'funnel-chart.tsx',
        'time-series-chart.tsx',
        'tooltip-sync.tsx',
        'x-axis.tsx',
        'y-axis.tsx',
        'types.ts',
        'use-tooltip.ts',
        'utils.ts',
        'index.ts',
    ])('%s exists in the canonical module layout', (file) => {
        expect(fs.existsSync(chartPath(file))).toBe(true);
    });

    describe('barrel', () => {
        const barrel = read('index.ts');

        it.each([
            './areas',
            './bars',
            './x-axis',
            './y-axis',
            './time-series-chart',
            './funnel-chart',
            './chart-context',
            './tooltip-sync',
        ])('re-exports from %s', (mod) => {
            // Either a star re-export or a named re-export is fine.
            const pattern = new RegExp(
                `export\\s*(?:\\*|\\{[^}]+\\})\\s*from\\s*['"]${mod.replace(
                    /\./g,
                    '\\.',
                )}['"]`,
            );
            // Two barrels since #3046: the package's, and the app-side façade
            // that re-exports it and declares what stayed. A module must be
            // re-exported by the barrel on ITS OWN side, so both are read —
            // asserting against just one would pass or fail purely on which
            // side of the extraction a given file happens to sit.
            const barrels = CHART_ROOTS.map((d) => path.join(d, 'index.ts'))
                .filter((f) => fs.existsSync(f))
                .map((f) => fs.readFileSync(f, 'utf-8'));
            expect(barrels).not.toEqual([]);
            expect(barrels.some((b) => pattern.test(b))).toBe(true);
        });

        it.each([
            // Visx-tied internals
            'Datum',
            'TimeSeriesDatum',
            'Series',
            'ChartProps',
            'Data',
            'AccessorFn',
            // Epic 59 consumer contracts
            'CategoryPoint',
            'ChartDimensions',
            'ChartMargin',
            'ChartPadding',
            'ChartState',
            'KpiMetric',
            'LabeledSeries',
            'ProgressMetric',
            'ProgressSegment',
            'SparklineData',
            'TimeSeriesPoint',
            'TooltipPayload',
        ])('surfaces the %s type from ./types', (typeName) => {
            const pattern = new RegExp(
                `export\\s+type\\s*\\{[^}]*\\b${typeName}\\b[^}]*\\}\\s*from\\s*['"]\\./types['"]`,
            );
            expect(barrel).toMatch(pattern);
        });

        it.each([
            'chartEmpty',
            'chartError',
            'chartLoading',
            'chartReady',
            'isChartReady',
        ])('surfaces the %s runtime helper from ./types', (name) => {
            // Value-level re-export: `export { … } from './types'`
            const pattern = new RegExp(
                `export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]\\./types['"]`,
            );
            expect(barrel).toMatch(pattern);
        });

        it('keeps internal helpers private (no re-export of use-tooltip or utils)', () => {
            expect(barrel).not.toMatch(/from\s*['"]\.\/use-tooltip['"]/);
            expect(barrel).not.toMatch(/from\s*['"]\.\/utils['"]/);
        });

        it('documents the module contract in a header comment', () => {
            // Bound to the COMMENTS — the assertion's whole subject.
            expect(readComments('index.ts')).toMatch(/Epic 59 — chart platform/);
        });
    });
});
