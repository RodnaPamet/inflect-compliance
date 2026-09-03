/**
 * GUARDRAIL — ORG_MATURITY is a first-class engine widget + dashboard
 * metric consistency.
 *
 * The Security Maturity radar is dispatched THROUGH the Epic-41 widget
 * engine (enum → dispatcher → preset → picker → title → strict config),
 * not as a bolt-on rendered outside the engine's sizing/title/config
 * plumbing. This ratchet locks that integration so a refactor can't
 * silently regress it back to a bolt-on, and locks the single-source
 * rule for the "critical risks" metric so the donut's tenant-health
 * bands can never be re-conflated with the risk count.
 *
 * Companion to `org-widget-integrity.test.ts` (titles + de-dup).
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_ORG_DASHBOARD_PRESET } from '@/app-layer/usecases/org-dashboard-presets';
import {
    WIDGET_TITLES,
    widgetTitleKey,
    resolveWidgetTitle,
} from '@/app-layer/usecases/org-dashboard-widget-titles';
import { assertWidgetTypedShape } from '@/app-layer/schemas/org-dashboard-widget.schemas';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// SOURCE reads are comment-masked at the seam, so the render-site assertions
// below are about the real JSX, not about the comments that name the same
// component. The en catalog is JSON and stays raw so it still parses.
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|prisma)$/;
const read = (rel: string) => {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return CODE_FILE.test(rel) ? codeOf(raw) : raw;
};

// i18n-aware: the DrillDownCtas label + donut band labels now route
// through next-intl. Resolve the keys against the English catalog so
// the original visible-text intent still holds.
const EN = JSON.parse(read('messages/en.json'));
const enOrg = (key: string): unknown =>
    key.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        EN.org,
    );

describe('GUARDRAIL: ORG_MATURITY engine integration', () => {
    describe('enum + schema', () => {
        it('ORG_MATURITY is a member of OrgDashboardWidgetType', () => {
            const enums = read('prisma/schema/enums.prisma');
            const block = enums.slice(
                enums.indexOf('enum OrgDashboardWidgetType'),
            );
            const body = block.slice(0, block.indexOf('}'));
            expect(body).toMatch(/\bORG_MATURITY\b/);
        });

        it('assertWidgetTypedShape accepts a valid ORG_MATURITY config', () => {
            const shape = assertWidgetTypedShape({
                type: 'ORG_MATURITY',
                chartType: 'radar',
                config: { view: 'radar', showCoverageHint: false },
            });
            expect(shape.type).toBe('ORG_MATURITY');
        });

        it('assertWidgetTypedShape rejects an unknown ORG_MATURITY config key (strict)', () => {
            expect(() =>
                assertWidgetTypedShape({
                    type: 'ORG_MATURITY',
                    chartType: 'radar',
                    // Extra key rejected at runtime by zod .strict() (the
                    // config param is typed `unknown`, so this is not a
                    // compile error — the strictness is the contract).
                    config: { view: 'radar', bogus: true },
                }),
            ).toThrow();
        });
    });

    describe('rendered through the engine (no bolt-on)', () => {
        const DISPATCHER = read(
            'src/app/org/[orgSlug]/(app)/widget-dispatcher.tsx',
        );

        it('the dispatcher has an ORG_MATURITY arm', () => {
            expect(DISPATCHER).toMatch(/case 'ORG_MATURITY':/);
        });

        it('the maturity radar renders inside the engine dispatcher, not a page-level bolt-on', () => {
            // The ONLY render site of <OrgMaturityWidget> is the dispatcher.
            // page.tsx fetches the data and threads it through PortfolioData —
            // it must NOT render the widget itself (that would be the bolt-on
            // path the engine migration removed).
            const page = read('src/app/org/[orgSlug]/(app)/page.tsx');
            expect(page).not.toMatch(/<OrgMaturityWidget\b/);
            expect(DISPATCHER).toMatch(/<OrgMaturityWidget\b/);
        });

        it('the maturity radar uses the shared chart primitive with an empty state', () => {
            const widget = read(
                'src/app/org/[orgSlug]/(app)/OrgMaturityWidget.tsx',
            );
            // Epic-59 RadarChart primitive (never raw <svg>), gated on a real
            // empty state for a no-rating org.
            expect(widget).toMatch(/RadarChart/);
            expect(widget).not.toMatch(/<svg\b/);
            expect(widget).toMatch(/chartEmpty\(\)/);
            expect(widget).toMatch(/emptyFallback/);
        });
    });

    describe('preset + picker', () => {
        it('the preset includes the ORG_MATURITY widget', () => {
            const maturity = DEFAULT_ORG_DASHBOARD_PRESET.filter(
                (w) => w.type === 'ORG_MATURITY',
            );
            expect(maturity).toHaveLength(1);
            expect(maturity[0].chartType).toBe('radar');
        });

        it('ORG_MATURITY is addable from the WidgetPicker', () => {
            const picker = read(
                'src/components/ui/dashboard-widgets/WidgetPicker.tsx',
            );
            // The picker's type list is i18n-driven: labels/descriptions now
            // resolve from the `widgets.types.*` catalog via a
            // `buildWidgetTypes(t)` factory, so the type is no longer an
            // inline `type: 'ORG_MATURITY'` object literal. It lives in the
            // `WIDGET_TYPE_ORDER` array (source of truth for the radio group)
            // as the quoted key. Assert that instead.
            expect(picker).toMatch(/'ORG_MATURITY'/);
        });
    });

    describe('title', () => {
        it('the maturity widget has a canonical human title', () => {
            const key = widgetTitleKey('ORG_MATURITY', 'radar');
            expect(WIDGET_TITLES[key]).toBe('Security Maturity');
            // resolveWidgetTitle never leaks the slug.
            expect(resolveWidgetTitle('ORG_MATURITY', 'radar', null)).toBe(
                'Security Maturity',
            );
        });
    });

    describe('metric consistency — single source for "critical risks"', () => {
        const DISPATCHER = read(
            'src/app/org/[orgSlug]/(app)/widget-dispatcher.tsx',
        );
        const SECTIONS = read(
            'src/app/org/[orgSlug]/(app)/dashboard-sections.tsx',
        );

        it('the KPI tile sources "critical risks" from summary.risks.critical', () => {
            // Inside the critical-risks KPI arm.
            const arm = DISPATCHER.slice(
                DISPATCHER.indexOf("case 'critical-risks':"),
                DISPATCHER.indexOf("case 'overdue-evidence':"),
            );
            expect(arm).toMatch(/value:\s*data\.summary\.risks\.critical/);
        });

        it('the drill-down sources "Critical Risks" from summary.risks.critical', () => {
            // The DrillDownCtas "Critical Risks" entry must bind to the SAME
            // field as the KPI — one source per metric.
            expect(SECTIONS).toMatch(
                /label:\s*t\('nav\.criticalRisks'\),\s*\n\s*count:\s*summary\.risks\.critical/,
            );
            expect(enOrg('nav.criticalRisks')).toBe('Critical Risks');
        });

        it('the donut\'s tenant-health bands are NOT labelled like the risk metric', () => {
            // The RAG donut shows TENANT HEALTH, not risks. A bare "Critical"
            // band (== summary.rag.red) reads like the "Critical Risks" count
            // (== summary.risks.critical) — a different number. It must be
            // disambiguated ("Critical health"), and the center must not be a
            // bare "Active".
            const arm = DISPATCHER.slice(
                DISPATCHER.indexOf("widget.chartType === 'rag-distribution'"),
            );
            const donut = arm.slice(0, arm.indexOf('return { chartType'));
            expect(donut).toMatch(/label:\s*t\('widgets\.criticalHealth'\)/);
            expect(enOrg('widgets.criticalHealth')).toBe('Critical health');
            expect(donut).not.toMatch(/label:\s*'Critical'\s*,/);
            expect(donut).not.toMatch(/centerSub:\s*'Active'/);
        });
    });
});
