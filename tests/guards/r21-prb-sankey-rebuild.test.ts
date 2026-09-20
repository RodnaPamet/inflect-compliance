/**
 * Sankey design ratchet.
 *
 * History: Epic 47.3 shipped flat hex per-kind colours; R21-PR-B
 * (#536) swapped them for washed `<ChartLinearGradient>` fills + a
 * gradient `<ChartLegend>`. That was reverted (2026-05-30, user
 * request) back to the flat high-contrast look — but kept theme-aware
 * via the R16 `--chart-series-{N}-start` tokens (solid, not gradient,
 * and NOT raw hex). This ratchet locks the restored design:
 *
 *   1. KIND_SERIES maps each kind to a chart-series index, consumed by
 *      a `kindColor()` helper that returns a solid `--chart-series-N`
 *      token (theme-aware, no raw hex).
 *   2. Node + link fills use that flat token colour — NOT `url(#…)`
 *      gradients, and the gradient `<ChartLinearGradient>`/`<defs>`
 *      machinery + the swatch `<ChartLegend>` are gone.
 *   3. A plain column header (kind label + count) replaces the
 *      gradient legend.
 *   4. Retained from PR-B: click-isolate (pin/ESC/empty-canvas-unpin),
 *      hover-pop, inline weight annotation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const SANKEY = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/ui/SankeyChart.tsx'),
    'utf8',
));
const STRIPPED = SANKEY.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
);

describe('Sankey — flat theme-token design (restored, theme-aware)', () => {
    describe('KIND_SERIES → flat chart-series token colour', () => {
        it('the KIND_SERIES mapping const exists', () => {
            expect(SANKEY).toMatch(
                /const\s+KIND_SERIES:\s*Record<TraceabilityNodeKind,\s*ChartSeriesIndex>/,
            );
        });

        it('maps every kind to a 1-6 chart-series index', () => {
            for (const kind of [
                'asset',
                'risk',
                'control',
                'requirement',
                'policy',
            ]) {
                expect(SANKEY).toMatch(new RegExp(`${kind}:\\s*[1-6]`));
            }
        });

        it('kindColor() returns a solid --chart-series token (theme-aware, not hex)', () => {
            expect(STRIPPED).toMatch(/function kindColor\(/);
            expect(STRIPPED).toMatch(
                /var\(--chart-series-\$\{KIND_SERIES\[kind\]\}-(?:start|end)\)/,
            );
        });
    });

    describe('flat fills, NOT gradients', () => {
        it('node rects + link strokes paint via kindColor(), not url(#…)', () => {
            expect(STRIPPED).toMatch(/fill=\{kindColor\(node\.kind\)\}/);
            expect(STRIPPED).toMatch(/stroke=\{kindColor\(link\.sourceKind\)\}/);
            expect(STRIPPED).not.toMatch(/url\(#/);
        });

        it('the gradient machinery (ChartLinearGradient / <defs>) is gone', () => {
            expect(STRIPPED).not.toMatch(/ChartLinearGradient/);
            expect(STRIPPED).not.toMatch(/<defs>/);
        });

        it('no hardcoded hex colour palette per kind', () => {
            expect(STRIPPED).not.toMatch(/KIND_COLOR/);
            expect(STRIPPED).not.toMatch(/#[0-9a-fA-F]{6}/);
        });
    });

    describe('plain column header replaces the gradient ChartLegend', () => {
        it('renders a data-sankey-legend column header over layout.columns', () => {
            expect(STRIPPED).not.toMatch(/<ChartLegend/);
            expect(SANKEY).toMatch(/data-sankey-legend="true"/);
            expect(SANKEY).toMatch(/layout\.columns\.map\(/);
        });

        it('shows each column kind label + node count', () => {
            expect(SANKEY).toMatch(/\{c\.label\}/);
            expect(SANKEY).toMatch(/\(\{c\.count\}\)/);
        });
    });

    describe('retained interactions: click-isolate + hover-pop + inline weight', () => {
        it('carries a pinnedId state separate from hoveredId', () => {
            expect(SANKEY).toMatch(/pinnedId/);
            expect(SANKEY).toMatch(/hoveredId/);
            expect(SANKEY).toMatch(
                /activeId\s*=\s*hoveredId\s*\?\?\s*pinnedId/,
            );
        });

        it('clicking a node toggles its pinnedId', () => {
            expect(SANKEY).toMatch(
                /setPinnedId\(\(prev\)\s*=>\s*\(prev === nodeId \? null : nodeId\)\)/,
            );
        });

        it('ESC unpins via the shared useKeyboardShortcut registry', () => {
            expect(SANKEY).toMatch(/useKeyboardShortcut/);
            expect(SANKEY).toMatch(/['"]Escape['"]/);
            expect(SANKEY).toMatch(/setPinnedId\(null\)/);
        });

        it('clicking the empty SVG canvas unpins', () => {
            expect(SANKEY).toMatch(/e\.target\s*===\s*e\.currentTarget/);
        });

        it('emits data-sankey-pinned-id for E2E hooks', () => {
            expect(SANKEY).toMatch(/data-sankey-pinned-id/);
        });

        it('highlighted links thicken via strokeWidth × 1.5', () => {
            expect(SANKEY).toMatch(
                /isHighlighted\s*\?\s*link\.strokeWidth\s*\*\s*1\.5/,
            );
        });

        it('inline weight annotation renders next to the label', () => {
            expect(SANKEY).toMatch(/font-mono tabular-nums/);
            expect(SANKEY).toMatch(/\{node\.weight\}/);
        });
    });
});
