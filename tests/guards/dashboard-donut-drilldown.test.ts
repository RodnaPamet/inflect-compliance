/**
 * Dashboard donut segment drill-through ratchet.
 *
 * Clicking a pie/donut slice (or its legend row) on the executive
 * dashboard opens the entity list filtered to that slice — Risk
 * Distribution by inherent-score range, Task/Policy Status by status.
 * Locks the wiring so a refactor can't quietly turn the donuts back
 * into display-only charts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const DONUT = read('src/components/ui/DonutChart.tsx');
const CLIENT = read('src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx');

describe('DonutChart — clickable slices', () => {
    it('accepts an onSegmentClick handler + a per-segment href', () => {
        expect(DONUT).toMatch(/onSegmentClick\?:\s*\(segment: DonutSegment\) => void/);
        expect(DONUT).toMatch(/href\?:\s*string/);
    });
    it('makes the arc mouse-clickable WITHOUT an interactive role (a11y)', () => {
        expect(DONUT).toMatch(/onSegmentClick && seg\.href/);
        expect(DONUT).toMatch(/onSegmentClick\(seg\)/);
        // The arc must NOT be a role="link" — an interactive role on an SVG
        // arc inside the chart's role="img" trips axe `nested-interactive`.
        // The keyboard-accessible drill-through is the legend <Link> row.
        expect(DONUT).not.toMatch(/role=\{[\s\S]{0,40}'link'/);
    });
});

describe('DashboardClient — donuts drill through to filtered lists', () => {
    it('passes onSegmentClick that navigates to the slice href', () => {
        expect(CLIENT).toMatch(/onSegmentClick=\{\(s\) => s\.href && router\.push\(s\.href\)\}/);
    });
    it('renders a clickable legend row per slice', () => {
        expect(CLIENT).toMatch(/function DonutLegendRow/);
        expect(CLIENT).toMatch(/<DonutLegendRow/);
    });

    it('risk severity slices target the risks score-range filter', () => {
        expect(CLIENT).toMatch(/\/risks\?score=15\|25/); // Critical
        expect(CLIENT).toMatch(/\/risks\?score=10\|14/); // High
        expect(CLIENT).toMatch(/\/risks\?score=5\|9/);   // Medium
        expect(CLIENT).toMatch(/\/risks\?score=1\|4/);   // Low
    });

    it('task + policy slices target their status filters', () => {
        expect(CLIENT).toMatch(/\/tasks\?status=OPEN,TRIAGED/);
        expect(CLIENT).toMatch(/\/tasks\?status=IN_PROGRESS/);
        expect(CLIENT).toMatch(/\/policies\?status=DRAFT/);
        expect(CLIENT).toMatch(/\/policies\?status=PUBLISHED/);
    });
});
