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

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const CHARTS_DIR = path.join(ROOT, 'src/components/ui/charts');
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
    return codeOf(fs.readFileSync(path.join(CHARTS_DIR, rel), 'utf-8'));
}

/**
 * Raw text, comments INCLUDED. Only the header-contract assertion below uses
 * it — that one is deliberately ABOUT a comment, so masking would break a
 * correct test. Every other assertion in this file reads through `read()`.
 */
function readRaw(rel: string): string {
    return fs.readFileSync(path.join(CHARTS_DIR, rel), 'utf-8');
}

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
        expect(fs.existsSync(path.join(CHARTS_DIR, file))).toBe(true);
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
            expect(barrel).toMatch(pattern);
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
            // Deliberately about the COMMENT — reads the unmasked text.
            expect(readRaw('index.ts')).toMatch(/Epic 59 — chart platform/);
        });
    });
});
