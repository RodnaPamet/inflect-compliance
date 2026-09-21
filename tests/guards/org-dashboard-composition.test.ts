/**
 * GUARD — org Portfolio dashboard composition (enterprise IA + polish).
 *
 * Prompts 1-3 fixed the dashboard's BUGS (blank radar, duplicate
 * widgets, untitled tiles, inconsistent metrics, bolt-on maturity).
 * This guard locks the COMPOSITION so it can't drift back into a
 * scattered widget-dump:
 *
 *   - the preset follows the deliberate 4-band IA (glance → posture →
 *     investigate → per-tenant) with equal-height tiles per band and
 *     no overlapping rectangles;
 *   - no two widgets are duplicate representations of the same metric;
 *   - the dashboard declares a top-level empty state, a NO-DATA
 *     onboarding state, a banded loading skeleton, and a SINGLE
 *     dashboard-level "last refreshed" indicator (not per-card);
 *   - the dashboard surfaces use the semantic spacing scale + semantic
 *     border tones (not raw numerics / raw tailwind colour scales).
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_ORG_DASHBOARD_PRESET } from '@/app-layer/usecases/org-dashboard-presets';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

type Widget = (typeof DEFAULT_ORG_DASHBOARD_PRESET)[number];
const byType = (t: string) => DEFAULT_ORG_DASHBOARD_PRESET.filter((w) => w.type === t);
const first = (t: string): Widget | undefined => byType(t)[0];

describe('GUARD: org dashboard composition', () => {
    describe('4-band information architecture', () => {
        it('Band 1 — GLANCE: four equal KPI tiles, contiguous across the 12-col grid', () => {
            const kpis = byType('KPI');
            expect(kpis).toHaveLength(4);
            // All on one row, all the same size.
            const y = kpis[0].position.y;
            for (const k of kpis) {
                expect(k.position.y).toBe(y);
                expect(k.size.w).toBe(kpis[0].size.w);
                expect(k.size.h).toBe(kpis[0].size.h);
            }
            // Tiled left-to-right with no gaps and no overlap, spanning 12.
            const xs = kpis.map((k) => k.position.x).sort((a, b) => a - b);
            expect(xs).toEqual([0, 3, 6, 9]);
            expect(kpis[0].size.w * 4).toBe(12);
        });

        it('Band 2 — POSTURE: maturity radar + a trend share a row at equal height', () => {
            const maturity = first('ORG_MATURITY');
            const trend = first('TREND');
            expect(maturity).toBeDefined();
            expect(trend).toBeDefined();
            expect(maturity!.position.y).toBe(trend!.position.y);
            expect(maturity!.size.h).toBe(trend!.size.h);
            // Together they span the full width.
            expect(maturity!.size.w + trend!.size.w).toBe(12);
        });

        it('Band 4 — PER-TENANT: health donut + tenant list share a row at equal height', () => {
            const donut = first('DONUT');
            const list = first('TENANT_LIST');
            expect(donut).toBeDefined();
            expect(list).toBeDefined();
            expect(donut!.position.y).toBe(list!.position.y);
            expect(donut!.size.h).toBe(list!.size.h);
            expect(donut!.size.w + list!.size.w).toBe(12);
            // The tenant list gets the dominant width (the breakdown is the
            // point; the donut is the summary).
            expect(list!.size.w).toBeGreaterThan(donut!.size.w);
        });

        it('reads glance → posture → investigate → per-tenant top-to-bottom', () => {
            const kpiY = Math.max(...byType('KPI').map((k) => k.position.y));
            const posture = first('ORG_MATURITY')!.position.y;
            const investigate = first('DRILLDOWN_CTAS')!.position.y;
            const perTenant = first('TENANT_LIST')!.position.y;
            // Strictly increasing band order.
            expect(kpiY).toBeLessThan(posture);
            expect(posture).toBeLessThan(investigate);
            // Drill-down sits ABOVE the per-tenant detail (investigate, then
            // drill in) — the pre-IA layout had this backwards.
            expect(investigate).toBeLessThan(perTenant);
        });

        it('has no overlapping (x..x+w, y..y+h) rectangles', () => {
            const rect = (w: Widget) => ({
                x0: w.position.x,
                x1: w.position.x + w.size.w,
                y0: w.position.y,
                y1: w.position.y + w.size.h,
            });
            const overlaps = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
                a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
            const rects = DEFAULT_ORG_DASHBOARD_PRESET.map(rect);
            for (let i = 0; i < rects.length; i++) {
                for (let j = i + 1; j < rects.length; j++) {
                    expect(overlaps(rects[i], rects[j])).toBe(false);
                }
            }
        });
    });

    describe('no duplicate metric representations', () => {
        it('no two preset widgets share a (type, chartType)', () => {
            const keys = DEFAULT_ORG_DASHBOARD_PRESET.map((w) => `${w.type}/${w.chartType}`);
            expect(new Set(keys).size).toBe(keys.length);
        });

        it('each KPI metric appears exactly once', () => {
            const kpiCharts = byType('KPI').map((k) => k.chartType);
            expect(new Set(kpiCharts).size).toBe(kpiCharts.length);
        });
    });

    describe('whole-dashboard states', () => {
        const DASH = read('src/app/org/[orgSlug]/(app)/PortfolioDashboard.tsx');

        it('declares a top-level empty state (no widgets)', () => {
            expect(DASH).toMatch(/data-testid="dashboard-empty-state"/);
        });

        it('declares a purposeful no-data onboarding state (no tenants)', () => {
            expect(DASH).toMatch(/data-testid="dashboard-onboarding-empty-state"/);
            // Gated on zero tenants, not zero widgets.
            expect(DASH).toMatch(/data\.summary\.tenants\.total === 0/);
        });

        it('declares a banded loading skeleton at the route segment', () => {
            const loading = read('src/app/org/[orgSlug]/(app)/loading.tsx');
            expect(loading).toMatch(/DashboardSkeleton/);
            const skel = read('src/app/org/[orgSlug]/(app)/DashboardSkeleton.tsx');
            expect(skel).toMatch(/Skeleton/);
            // Banded — the skeleton mirrors the IA, not a single spinner.
            expect(skel).toMatch(/space-y-section/);
        });

        it('surfaces "last refreshed" ONCE at the dashboard level', () => {
            // The dashboard-level refresh indicator exists...
            expect(DASH).toMatch(/data-testid="portfolio-refreshed-at"/);
            expect(DASH).toMatch(/data\.summary\.generatedAt/);
            // ...and it appears exactly once (not duplicated per-card).
            const occurrences = DASH.split('portfolio-refreshed-at').length - 1;
            expect(occurrences).toBe(1);
        });
    });

    describe('design-system discipline on the dashboard surfaces', () => {
        const FILES = [
            'src/app/org/[orgSlug]/(app)/PortfolioDashboard.tsx',
            'src/app/org/[orgSlug]/(app)/DashboardSkeleton.tsx',
        ];

        it('uses the semantic spacing scale, not raw numeric rhythm', () => {
            for (const f of FILES) {
                const src = read(f);
                // No raw numeric vertical rhythm (space-y-4 / gap-6 / …) — the
                // semantic scale (space-y-section/default/tight, gap-default)
                // is the only allowed vocabulary at the band level. Micro 1-2
                // steps stay permitted by the spacing-scale guard, so allow
                // only those if present.
                const rawRhythm = src.match(/\b(?:space-y|gap)-(\d+)\b/g) ?? [];
                const offenders = rawRhythm.filter((c) => {
                    const n = Number(c.match(/-(\d+)$/)![1]);
                    return n >= 3; // 1-2 (micro) allowed; 3+ must be semantic
                });
                expect(offenders).toEqual([]);
            }
        });

        it('uses semantic border tones, not raw tailwind colour scales', () => {
            for (const f of FILES) {
                const src = read(f);
                // No raw `border-slate-400` / `border-gray-200` etc.
                expect(src).not.toMatch(/border-(?:slate|gray|zinc|neutral|stone)-\d{2,3}/);
            }
        });
    });
});
