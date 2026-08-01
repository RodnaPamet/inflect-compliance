/**
 * Roadmap-16 PR-9 — `<RadarChart>` primitive.
 *
 * Multi-axis profile visualisation. Polygon mesh inside a
 * circular grid; each axis runs from centre to the outer ring;
 * the data polygon connects the value-scaled points.
 *
 * Seven load-bearing invariants:
 *
 *   1. RadarChart + RadarAxisDatum exported; barrel re-exports.
 *
 *   2. Renders inside `<ChartFrame>` for state-driven branches.
 *
 *   3. Polygon fill via `<ChartRadialGradient>` resolving through
 *      the R16-PR1 series palette. The gradient is centred at
 *      the chart centre with `r="60%"` so the brighter start-
 *      stop concentrates inside the polygon.
 *
 *   4. GRID_RINGS = 4 concentric grid circles (25%, 50%, 75%,
 *      100% of outer radius). Muted via `--border-subtle` at
 *      0.6 opacity.
 *
 *   5. Per-axis radial lines from centre to outer ring. Same
 *      muted tone as the grid.
 *
 *   6. Axis labels rendered via `<Text>` from `@visx/text` for
 *      kerning + auto-wrapping.
 *
 *   7. Vertex circles at each (axis, value) point — solid fill
 *      in the series start-stop with a `--bg-default` stroke so
 *      they read against the gradient polygon.
 *
 *   8. Angle math: -PI/2 starts axis 0 at 12 o'clock, then
 *      clockwise via 2π/N stepping.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const RADAR_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/charts/radar-chart.tsx'),
    'utf8',
);
const BARREL_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/charts/index.ts'),
    'utf8',
);

describe('Roadmap-16 PR-9 — RadarChart primitive', () => {
    describe('exports + barrel', () => {
        it('exports RadarChart function', () => {
            expect(RADAR_SRC).toMatch(/export\s+function\s+RadarChart\s*\(/);
        });

        it('exports RadarAxisDatum interface', () => {
            expect(RADAR_SRC).toMatch(/export\s+interface\s+RadarAxisDatum\s*\{/);
        });

        it('barrel re-exports RadarChart + RadarAxisDatum', () => {
            expect(BARREL_SRC).toMatch(
                /export\s*\{\s*RadarChart\s*\}\s*from\s*['"]\.\/radar-chart['"]/,
            );
            expect(BARREL_SRC).toMatch(
                /export\s+type\s*\{\s*RadarAxisDatum\s*\}\s*from\s*['"]\.\/radar-chart['"]/,
            );
        });
    });

    describe('imports', () => {
        it('imports Group from @visx/group', () => {
            expect(RADAR_SRC).toMatch(
                /import\s*\{\s*Group\s*\}\s*from\s*['"]@visx\/group['"]/,
            );
        });

        it('imports Line from @visx/shape', () => {
            expect(RADAR_SRC).toMatch(
                /import\s*\{\s*Line\s*\}\s*from\s*['"]@visx\/shape['"]/,
            );
        });

        it('imports Text from @visx/text (for axis labels)', () => {
            // visx Text handles kerning and auto-anchor — better
            // than raw <text> elements for radar labels which sit
            // at arbitrary angles around the chart.
            expect(RADAR_SRC).toMatch(
                /import\s*\{\s*Text\s*\}\s*from\s*['"]@visx\/text['"]/,
            );
        });

        it('imports ChartFrame + ChartRadialGradient + chartGradientId', () => {
            expect(RADAR_SRC).toMatch(/import\s*\{[\s\S]*?ChartFrame[\s\S]*?\}/);
            expect(RADAR_SRC).toMatch(
                /import\s*\{[\s\S]*?ChartRadialGradient[\s\S]*?\}/,
            );
            expect(RADAR_SRC).toMatch(/chartGradientId/);
        });
    });

    describe('frame + render-prop body lifted into inner component', () => {
        it('renders <ChartFrame state={state}>', () => {
            expect(RADAR_SRC).toMatch(/<ChartFrame\s+state=\{state\}/);
        });

        it('lifts the body into RadarChartInner so hooks can run', () => {
            expect(RADAR_SRC).toMatch(/function\s+RadarChartInner\s*\(/);
        });
    });

    describe('grid + axes layout', () => {
        it('defaults to GRID_RINGS = 4 concentric grid circles', () => {
            // Four rings = 25%, 50%, 75%, 100%. Clear read for
            // 0-100% style profiles without crowding.
            expect(RADAR_SRC).toMatch(/GRID_RINGS\s*=\s*4/);
        });

        it('lets a caller set the ring count to match its scale', () => {
            // A chart whose scale IS a ladder wants one ring per rung, so
            // a vertex on the third ring means level 3 (the dashboard
            // posture radar passes 5). The default is unchanged for every
            // other consumer.
            expect(RADAR_SRC).toMatch(/rings\?:\s*number/);
            expect(RADAR_SRC).toMatch(/rings\s*=\s*GRID_RINGS/);
            expect(RADAR_SRC).toMatch(/length:\s*ringCount/);
        });

        it('grid lines + axis lines muted via --border-subtle at 0.6 opacity', () => {
            expect(RADAR_SRC).toMatch(/stroke="var\(--border-subtle\)"/);
            expect(RADAR_SRC).toMatch(/opacity=\{0\.6\}/);
        });

        it('renders one radial axis Line per data point', () => {
            expect(RADAR_SRC).toMatch(/<Line\b[\s\S]*?key=\{`axis-/);
        });
    });

    describe('angle math', () => {
        it('starts axis 0 at 12 o\'clock (-PI/2)', () => {
            // -PI/2 puts the first axis at the top of the chart.
            // The angle then increments clockwise.
            expect(RADAR_SRC).toMatch(/-Math\.PI\s*\/\s*2/);
        });

        it('uses 2π / N angleStep for symmetric N-axis layout', () => {
            expect(RADAR_SRC).toMatch(
                /angleStep\s*=\s*\(\s*Math\.PI\s*\*\s*2\s*\)\s*\/\s*data\.length/,
            );
        });
    });

    describe('polygon mesh + fill', () => {
        it('builds the data polygon path via M/L commands', () => {
            // The polygon connects each value-scaled point with
            // M to start + L for subsequent + Z to close.
            expect(RADAR_SRC).toMatch(/'M'\s*:\s*'L'/);
            expect(RADAR_SRC).toMatch(/' Z'/);
        });

        it('paints polygon via url(#fillGradId) referencing ChartRadialGradient', () => {
            expect(RADAR_SRC).toMatch(/fill=\{`url\(#\$\{fillGradId\}\)`\}/);
            expect(RADAR_SRC).toMatch(/<ChartRadialGradient/);
        });

        it('polygon fillOpacity is 0.45 — lighter than the stroke for visual hierarchy', () => {
            // Fill light, stroke crisp — the eye reads the
            // polygon's shape without the fill overpowering.
            expect(RADAR_SRC).toMatch(/fillOpacity=\{0\.45\}/);
        });

        it('polygon stroke uses series-end CSS var for crisp outline', () => {
            expect(RADAR_SRC).toMatch(
                /stroke=\{`var\(--chart-series-\$\{seriesIndex\}-end\)`\}/,
            );
        });
    });

    describe('vertex circles + axis labels', () => {
        it('renders a vertex circle at each value-scaled point', () => {
            // Vertices are the data tells — without them the
            // polygon reads as a shape but individual axis
            // values are hard to pinpoint.
            expect(RADAR_SRC).toMatch(/key=\{`vertex-/);
        });

        it('vertex fill uses series-start CSS var', () => {
            expect(RADAR_SRC).toMatch(
                /fill=\{`var\(--chart-series-\$\{seriesIndex\}-start\)`\}/,
            );
        });

        it('renders axis labels via <Text> from @visx/text', () => {
            // R16-PR10 wraps each <Text> in a <g> for the hover
            // affordances; the `key=` moved to the <g>. We just
            // assert that a <Text> element exists in the file —
            // the per-axis iteration is structurally locked by
            // the `points.map((p) =>` pattern.
            expect(RADAR_SRC).toMatch(/<Text\b/);
            expect(RADAR_SRC).toMatch(/key=\{`label-\$\{p\.key\}`\}/);
        });

        it('labels sit past the outer ring AND anchor away from the plot', () => {
            // Two halves of one fix. The gap alone is not enough: with a
            // centred anchor, half of a side label reaches back over the
            // ring and lands on the vertex dot (the overlap reported on
            // the dashboard hero). Anchoring by side makes the text grow
            // outward, and the inset reserves margin for a WHOLE label
            // rather than half of one.
            expect(RADAR_SRC).toMatch(/outerRadius\s*\+\s*LABEL_GAP/);
            // The label margin scales with the chart (18% of width,
            // clamped) rather than being one number for every consumer: a
            // fixed inset either starves a wide chart's long domain names
            // or shrinks a small dial to nothing.
            expect(RADAR_SRC).toMatch(/function\s+horizontalInset/);
            expect(RADAR_SRC).toMatch(/width=\{hInset\s*-\s*LABEL_GAP\}/);
            expect(RADAR_SRC).toMatch(/function\s+labelAnchorFor/);
            expect(RADAR_SRC).toMatch(/textAnchor:\s*'start'/);
            expect(RADAR_SRC).toMatch(/textAnchor:\s*'end'/);
            expect(RADAR_SRC).toMatch(/textAnchor=\{p\.textAnchor\}/);
            // A centred anchor on a side axis is the bug — it must not
            // come back as a hardcoded prop.
            expect(RADAR_SRC).not.toMatch(/textAnchor="middle"/);
        });
    });
});
