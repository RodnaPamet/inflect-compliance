/**
 * RQ3-5 — "from heatmaps to histograms" ratchet.
 *
 * Regression classes guarded:
 *
 *   - the histogram view quietly dropping from the risks page (the
 *     three-view ToggleGroup, the persisted choice, the band-stacked
 *     chart, the appetite line);
 *   - the cell-collision flags vanishing from EITHER view (the
 *     heatmap's marker pass-through, or the histogram's callout
 *     list);
 *   - the chart losing its a11y contract (generated aria summary,
 *     keyboard-focusable buckets);
 *   - the heatmap being deleted instead of demoted-to-peer.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const client = read('src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx');
const chart = read('src/components/ui/charts/ale-histogram.tsx');
const barrel = read('src/components/ui/charts/index.ts');
const lib = read('src/lib/risk-collisions.ts');
const matrix = read('src/components/ui/RiskMatrix.tsx');
const cell = read('src/components/ui/RiskMatrixCell.tsx');

describe('RQ3-5 — the histogram is a peer view', () => {
    test('three views, persisted per tenant (polish #13 pattern)', () => {
        expect(client).toMatch(/useLocalStorage<'register' \| 'heatmap' \| 'histogram'>/);
        expect(client).toMatch(/inflect:risks-view:\$\{tenantSlug\}/);
        // Item 30 (2026-06-14) — register + heatmap collapsed to a
        // single 2-way ToggleGroup; histogram was promoted OUT of the
        // toggle into its own standalone button so the distribution
        // view reads as a distinct analytical mode rather than a
        // register layout. The histogram value still drives the same
        // `view` state and renders the same chart — only the toggle
        // mechanism moved.
        expect(client).toMatch(/<ToggleGroup/);
        expect(client).toMatch(/aria-pressed=\{view === 'histogram'\}/);
        // The heatmap stays for the ritual.
        expect(client).toMatch(/view === 'heatmap' \? \(/);
        expect(client).toMatch(/<RiskMatrix/);
    });

    test('the chart is the shared primitive, band-stacked, with the appetite line', () => {
        expect(barrel).toMatch(/export \{ AleHistogram, bucketByDecade \}/);
        expect(client).toMatch(/<AleHistogram/);
        expect(client).toMatch(/referenceLine=\{/);
        expect(client).toMatch(/appetiteCap/);
        // Bars stack by the tenant matrix band colours.
        expect(client).toMatch(/resolveBandForScore\(r\.inherentScore, matrixConfig\.bands\)/);
        expect(chart).toMatch(/data-band=\{s\.bandName\}/);
    });

    test('chart a11y: generated summary + keyboard-focusable buckets', () => {
        expect(chart).toMatch(/role="img"/);
        expect(chart).toMatch(/aria-label=\{ariaLabel \?\? summary\}/);
        expect(chart).toMatch(/tallest bucket/);
        expect(chart).toMatch(/tabIndex=\{b\.total > 0 \? 0 : -1\}/);
    });
});

describe('RQ3-5 — cell collisions flag on BOTH views', () => {
    test('the detector is pure and threshold-documented', () => {
        expect(lib).toMatch(/export function detectCellCollisions/);
        expect(lib).toMatch(/export const COLLISION_RATIO_THRESHOLD = 10/);
        expect(lib).not.toMatch(/prisma|RequestContext|@\/lib\/db/);
    });

    test('the heatmap path: client computes → matrix threads → cell marks', () => {
        expect(client).toMatch(/detectCellCollisions\(/);
        expect(client).toMatch(/collisionRatio = c\.ratio/);
        expect(matrix).toMatch(/collisionRatio=\{cell\.collisionRatio\}/);
        expect(cell).toMatch(/risk-matrix-cell-collision/);
        // The marker is decorative; the words live in aria + tooltip.
        expect(cell).toMatch(/same-cell loss estimates differ/);
        expect(cell).toMatch(/check the histogram view/);
    });

    test('the histogram path: the callout list with the drill-down', () => {
        expect(client).toMatch(/risk-collision-callouts/);
        // "Cell collisions" heading migrated to next-intl; resolve via en.json.
        const en = JSON.parse(read('messages/en.json')) as { risks: { collisions: { title: string } } };
        expect(client).toMatch(/tx\('collisions\.title'\)/);
        expect(en.risks.collisions.title).toBe('Cell collisions');
        // Clicking a callout drills into the cell's risks, matching
        // the heatmap's onCellClick contract.
        //
        // The drill filters by the EXACT (likelihood, impact) cell, NOT by
        // the score product. `score` is likelihood × impact, so a
        // `score=12` drill also matched 2×6, 3×4, 4×3 and 6×2 — every other
        // cell sharing the product — and the register showed rows the user
        // never clicked on. The `cell` filter (`L{l}xI{i}` tokens) is the
        // only shape that can express one cell.
        const callout = client.slice(
            client.indexOf('risk-collision-callouts'),
            client.indexOf('view === \'heatmap\''),
        );
        expect(callout).toMatch(/filterCtx\.set\('cell'/);
        expect(callout).not.toMatch(/filterCtx\.set\('score'/);
    });
});
