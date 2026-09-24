/**
 * Org widget "wire the reachable, prune the dead" ratchet.
 *
 * Locks the six remediations that closed the gap between the org
 * dashboard's built-but-unreachable widget capabilities and what the
 * operator can actually configure/see:
 *
 *   1. Target lines are wired end-to-end (dispatcher forwards
 *      config.target; the picker can set it).
 *   2. Widgets are editable post-create (picker edit mode + PATCH).
 *   3. KPI trend arrows render from real previous-period data.
 *   4. The unreachable tenant "cards" view is deleted.
 *   5. ChartType reflects only producible shapes (kpi/donut/area).
 *   6. Cleanup: dead ChartContentSurface export gone, presets naming
 *      is honest, and the omitted config knobs are surfaced.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf, commentsOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// Masked at the READ seam (#2246 Class A): comments blanked, string
// literals kept, offsets preserved — so a token that survives only in
// a comment can no longer satisfy an assertion below.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
// The INVERSE mask (#2246), for the one assertion whose subject IS a comment
// (`the presets module documents its single-default scope`). `codeOf` would
// blank that comment; `commentsOf` keeps it and blanks the code instead, which
// is a narrower reach for the same assertion — `/NOT a multi-preset/` counts 1
// raw, 1 masked, 0 through `codeOf`.
const readRaw = (rel: string) => commentsOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const DISPATCHER = read('src/app/org/[orgSlug]/(app)/widget-dispatcher.tsx');
const PICKER = read('src/components/ui/dashboard-widgets/WidgetPicker.tsx');
const PORTFOLIO = read('src/app/org/[orgSlug]/(app)/PortfolioDashboard.tsx');
const SECTIONS = read('src/app/org/[orgSlug]/(app)/dashboard-sections.tsx');
const TYPES = read('src/components/ui/dashboard-widgets/types.ts');
const RENDERER = read('src/components/ui/dashboard-widgets/ChartRenderer.tsx');
const INDEX = read('src/components/ui/dashboard-widgets/index.ts');
const PRESETS = readRaw('src/app-layer/usecases/org-dashboard-presets.ts');

describe('1. target lines wired end-to-end', () => {
    it('the dispatcher forwards config.target to the area chart', () => {
        expect(DISPATCHER).toMatch(/target:\s*cfg\.target/);
    });
    it('the picker can set a TREND target line', () => {
        expect(PICKER).toMatch(/widget-picker-target-enabled/);
        expect(PICKER).toMatch(/widget-picker-target-value/);
        // buildConfig threads the target into the persisted config.
        expect(PICKER).toMatch(/cfg\.target\s*=\s*target/);
    });
});

describe('2. widgets are editable post-create', () => {
    it('the picker accepts editWidget + onUpdate and PATCHes on submit', () => {
        expect(PICKER).toMatch(/editWidget\?:/);
        expect(PICKER).toMatch(/onUpdate\?:/);
        expect(PICKER).toMatch(/await onUpdate\(/);
    });
    it('PortfolioDashboard wires an edit trigger + update handler', () => {
        expect(PORTFOLIO).toMatch(/const handleUpdate/);
        expect(PORTFOLIO).toMatch(/dashboard-edit-widget-/);
        expect(PORTFOLIO).toMatch(/editWidget=\{editWidget\}/);
    });
});

describe('3. KPI trend arrows render from real previous-period data', () => {
    it('resolveKpiContent supplies previousValue + sparkline from the trend series', () => {
        expect(DISPATCHER).toMatch(/function resolveKpiTrend\b/);
        expect(DISPATCHER).toMatch(/previousValue/);
        // the resolved trend bundle is spread into the KPI configs
        expect(DISPATCHER).toMatch(/\.\.\.trend,/);
    });
});

describe('4. the unreachable tenant cards view is deleted', () => {
    it('dashboard-sections no longer exports TenantCoverageCards', () => {
        expect(SECTIONS).not.toMatch(/TenantCoverageCards/);
    });
    it('the dispatcher no longer branches on display: cards', () => {
        expect(DISPATCHER).not.toMatch(/display\s*===\s*'cards'/);
        expect(DISPATCHER).not.toMatch(/TenantCoverageCards/);
    });
});

describe('5. ChartType reflects only producible shapes', () => {
    it('the union is exactly kpi | donut | area', () => {
        expect(TYPES).toMatch(/export type ChartType\s*=\s*'kpi'\s*\|\s*'donut'\s*\|\s*'area'/);
        expect(TYPES).not.toMatch(/'gauge'/);
        expect(TYPES).not.toMatch(/'sparkline'/);
    });
    it('the renderer has no gauge/sparkline/line/bar arms', () => {
        expect(RENDERER).not.toMatch(/case 'gauge'/);
        expect(RENDERER).not.toMatch(/case 'sparkline'/);
        expect(RENDERER).not.toMatch(/case 'bar'/);
    });
});

describe('6. cleanup — dead export gone, honest naming, knobs surfaced', () => {
    it('the orphaned ChartContentSurface export is removed', () => {
        expect(RENDERER).not.toMatch(/ChartContentSurface/);
        expect(INDEX).not.toMatch(/ChartContentSurface/);
    });
    it('the presets module documents its single-default scope', () => {
        expect(PRESETS).toMatch(/NOT a multi-preset/);
    });
    it('the picker surfaces the previously-omitted config knobs', () => {
        expect(PICKER).toMatch(/widget-picker-donut-max-segments/);
        expect(PICKER).toMatch(/widget-picker-tenant-limit/);
        expect(PICKER).toMatch(/widget-picker-initiatives-status/);
    });
});
