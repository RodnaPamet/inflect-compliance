/**
 * GUARDRAIL — org-dashboard widget integrity.
 *
 * The deployed org dashboard drifted into a mess (duplicated widgets,
 * untitled charts, raw-slug labels) with no way to self-correct. This
 * ratchet locks the integrity guarantees:
 *
 *   - the preset has no duplicate (type, chartType) entries;
 *   - WIDGET_TITLES covers every (type, chartType) the preset uses, and
 *     `resolveWidgetTitle` NEVER returns a raw slug;
 *   - the dispatcher resolves titles through `resolveWidgetTitle` (no
 *     `widget.title ?? widget.chartType` slug fallback);
 *   - the reset/reconciliation action exists + is permission-gated;
 *   - the de-dup reconcile script exists + documents idempotency.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_ORG_DASHBOARD_PRESET } from '@/app-layer/usecases/org-dashboard-presets';
import {
    WIDGET_TITLES,
    widgetTitleKey,
    resolveWidgetTitle,
} from '@/app-layer/usecases/org-dashboard-widget-titles';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('GUARDRAIL: org dashboard widget integrity', () => {
    describe('preset', () => {
        it('has no duplicate (type, chartType) entries', () => {
            const seen = new Set<string>();
            const dups: string[] = [];
            for (const w of DEFAULT_ORG_DASHBOARD_PRESET) {
                const key = widgetTitleKey(w.type, w.chartType);
                if (seen.has(key)) dups.push(key);
                seen.add(key);
            }
            expect(dups).toEqual([]);
        });

        it('every preset widget carries a non-empty title', () => {
            for (const w of DEFAULT_ORG_DASHBOARD_PRESET) {
                expect(w.title?.trim()).toBeTruthy();
            }
        });
    });

    describe('canonical titles', () => {
        it('WIDGET_TITLES covers every (type, chartType) the preset uses', () => {
            const missing = DEFAULT_ORG_DASHBOARD_PRESET.map((w) =>
                widgetTitleKey(w.type, w.chartType),
            ).filter((k) => !WIDGET_TITLES[k]);
            expect(missing).toEqual([]);
        });

        it('the canonical title matches the preset title for every entry', () => {
            for (const w of DEFAULT_ORG_DASHBOARD_PRESET) {
                expect(WIDGET_TITLES[widgetTitleKey(w.type, w.chartType)]).toBe(
                    w.title,
                );
            }
        });

        it('resolveWidgetTitle never returns a raw slug', () => {
            // A null-title widget must resolve to a human title, never the
            // hyphenated slug verbatim.
            for (const w of DEFAULT_ORG_DASHBOARD_PRESET) {
                const resolved = resolveWidgetTitle(w.type, w.chartType, null);
                // Never the chartType verbatim (the slug-leak bug). Human
                // titles MAY contain hyphens ("Drill-down"), so we compare
                // against the slug exactly rather than banning "-".
                expect(resolved).not.toBe(w.chartType);
                expect(resolved).toBe(
                    WIDGET_TITLES[widgetTitleKey(w.type, w.chartType)],
                );
            }
            // An unmapped (type, chartType) still sentence-cases — never a slug.
            expect(resolveWidgetTitle('KPI', 'risks-open', null)).toBe(
                'Risks Open',
            );
            // The widget's own title always wins.
            expect(resolveWidgetTitle('KPI', 'coverage', 'My Title')).toBe(
                'My Title',
            );
        });
    });

    describe('dispatcher', () => {
        const SRC = read('src/app/org/[orgSlug]/(app)/widget-dispatcher.tsx');

        it('resolves titles through resolveWidgetTitle', () => {
            expect(SRC).toMatch(/resolveWidgetTitle\(/);
        });

        it('never falls back a title to the raw chartType slug', () => {
            expect(SRC).not.toMatch(/title\s*\?\?\s*widget\.chartType/);
            expect(SRC).not.toMatch(/label:\s*widget\.title\s*\?\?\s*widget\.chartType/);
            expect(SRC).not.toMatch(/seriesLabel:\s*widget\.title\s*\?\?\s*widget\.chartType/);
        });
    });

    describe('create-time integrity', () => {
        const SRC = read('src/app-layer/usecases/org-dashboard-widgets.ts');
        it('createOrgDashboardWidget defaults the title (never persists a null/slug)', () => {
            expect(SRC).toMatch(/resolveWidgetTitle\(/);
        });
    });

    describe('reconciliation path', () => {
        const USECASE = read('src/app-layer/usecases/org-dashboard-widgets.ts');

        it('a reset-to-preset reconciliation action exists', () => {
            expect(USECASE).toMatch(/export\s+(async\s+)?function\s+resetOrgDashboardToPreset/);
        });

        it('the reset action is permission-gated (canConfigureDashboard)', () => {
            // resetOrgDashboardToPreset must assert write permission, like the
            // other widget mutations.
            //
            // The assert is `assertCanWriteOrgWidgets`, NOT the `assertCanWrite`
            // exported by policies/common.ts. They are different functions over
            // different context types — this one takes an OrgContext and reads
            // `permissions.canConfigureDashboard`. It was renamed when a guard
            // started refusing file-local redeclarations of the shared policy
            // names, because a name-keyed census cannot tell the two apart and
            // had already mis-attributed org routes as tenant-gated.
            const fn = USECASE.slice(USECASE.indexOf('resetOrgDashboardToPreset'));
            expect(fn).toMatch(/assertCanWriteOrgWidgets\(/);
        });

        it('the reset API route exists', () => {
            expect(
                fs.existsSync(
                    path.join(
                        ROOT,
                        'src/app/api/org/[orgSlug]/dashboard/widgets/reset/route.ts',
                    ),
                ),
            ).toBe(true);
        });

        it('the de-dup reconcile script exists + documents idempotency', () => {
            const script = read('scripts/reconcile-org-dashboard-widgets.ts');
            expect(script).toMatch(/idempotent/i);
            // De-dup keyed on (type, chartType); backfills via the canonical map.
            expect(script).toMatch(/resolveWidgetTitle\(/);
            expect(script).toMatch(/--execute/);
        });
    });
});
