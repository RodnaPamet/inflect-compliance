/**
 * Epic 41 page rewire — widget dispatcher behavioural tests.
 *
 * Verifies the dispatcher resolves each (type, chartType) pair to
 * the right rendered surface using a fixture portfolio dataset.
 * No drag, no edit mode — the dispatcher is the unit under test.
 *
 * Coverage:
 *   - KPI variants (coverage / critical-risks / overdue-evidence /
 *     tenants) render with the right value pulled from PortfolioData
 *   - DONUT (rag-distribution) renders the four legend bands
 *   - TENANT_LIST renders rows with drill-down links
 *   - DRILLDOWN_CTAS renders the three navigation cards
 */

import { render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/org/acme-org',
    useSearchParams: () => new URLSearchParams(),
}));

import {
    DispatchedWidget,
    type PortfolioData,
} from '@/app/org/[orgSlug]/(app)/widget-dispatcher';
import type { OrgDashboardWidgetDto } from '@/app-layer/schemas/org-dashboard-widget.schemas';

// ─── Fixture portfolio data ────────────────────────────────────────

function makeData(): PortfolioData {
    return {
        orgSlug: 'acme-org',
        threatLevel: {
            level: 'GUARDED',
            summary: 'No active threat assessment',
            detail: null,
            setAt: null,
            setByUserId: null,
            setByName: null,
            isDefault: true,
        },
        canSetThreatLevel: false,
        maturity: {
            domains: [
                { domain: 'GOVERN', level: null, levelNum: 0, rationale: null, ratedAt: null, ratedByName: null },
                { domain: 'IDENTIFY', level: null, levelNum: 0, rationale: null, ratedAt: null, ratedByName: null },
                { domain: 'PROTECT', level: null, levelNum: 0, rationale: null, ratedAt: null, ratedByName: null },
                { domain: 'DETECT', level: null, levelNum: 0, rationale: null, ratedAt: null, ratedByName: null },
                { domain: 'RESPOND', level: null, levelNum: 0, rationale: null, ratedAt: null, ratedByName: null },
                { domain: 'RECOVER', level: null, levelNum: 0, rationale: null, ratedAt: null, ratedByName: null },
            ],
            overall: 0,
            overallLabel: null,
            lastRatedAt: null,
            isDefault: true,
            coverageHint: null,
        },
        canSetMaturity: false,
        initiatives: { rows: [], inFlight: 0, atRisk: 0 },
        canManageInitiatives: false,
        summary: {
            organizationId: 'org-1',
            organizationSlug: 'acme-org',
            generatedAt: new Date().toISOString(),
            tenants: { total: 12, snapshotted: 10, pending: 2 },
            controls: { applicable: 100, implemented: 75, coveragePercent: 75 },
            risks: { total: 50, open: 12, critical: 3, high: 4 },
            evidence: { total: 200, overdue: 8, dueSoon7d: 5 },
            policies: { total: 20, overdueReview: 2 },
            tasks: { open: 30, overdue: 4 },
            findings: { open: 5 },
            rag: { green: 6, amber: 3, red: 1, pending: 2 },
        },
        tenantHealth: [
            {
                tenantId: 't-1',
                slug: 'alpha',
                name: 'Alpha Co',
                drillDownUrl: '/t/alpha/dashboard',
                hasSnapshot: true,
                snapshotDate: '2026-04-29',
                coveragePercent: 75,
                openRisks: 5,
                criticalRisks: 1,
                overdueEvidence: 2,
                rag: 'AMBER',
            },
            {
                tenantId: 't-2',
                slug: 'beta',
                name: 'Beta Co',
                drillDownUrl: '/t/beta/dashboard',
                hasSnapshot: true,
                snapshotDate: '2026-04-29',
                coveragePercent: 90,
                openRisks: 1,
                criticalRisks: 0,
                overdueEvidence: 0,
                rag: 'GREEN',
            },
        ],
        trends: {
            organizationId: 'org-1',
            daysRequested: 90,
            daysAvailable: 1,
            rangeStart: new Date().toISOString(),
            rangeEnd: new Date().toISOString(),
            tenantsAggregated: 2,
            dataPoints: [],
        },
    };
}

function makeWidget(
    overrides: Partial<OrgDashboardWidgetDto> & {
        type: OrgDashboardWidgetDto['type'];
        chartType: string;
    },
): OrgDashboardWidgetDto {
    return {
        id: 'w-1',
        organizationId: 'org-1',
        title: null,
        config: {},
        position: { x: 0, y: 0 },
        size: { w: 3, h: 2 },
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    } as OrgDashboardWidgetDto;
}

describe('Epic 41 — DispatchedWidget per (type, chartType)', () => {
    // ─── KPI ──────────────────────────────────────────────────────

    it('KPI/coverage renders the coverage percent + implemented/applicable subtitle', () => {
        const widget = makeWidget({
            type: 'KPI',
            chartType: 'coverage',
            config: { format: 'percent' },
            title: 'Coverage',
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(screen.getByText('Coverage')).toBeInTheDocument();
        expect(screen.getByText('75.0%')).toBeInTheDocument();
        expect(
            screen.getByText(/75 of 100 controls implemented/),
        ).toBeInTheDocument();
    });

    it('a KPI carries the edit-mode actions, which it used to drop (#5270)', () => {
        // KPI, threat level, maturity and initiatives own their surface and
        // render without DashboardWidget's header — and used to render without
        // its actions too, so edit mode gave them no edit or delete control.
        const widget = makeWidget({ type: 'KPI', chartType: 'coverage', config: { format: 'percent' } });
        const { container, rerender } = render(
            <DispatchedWidget
                widget={widget}
                data={makeData()}
                actionsSlot={<button type="button">Edit widget</button>}
            />,
        );
        expect(screen.getByRole('button', { name: 'Edit widget' })).toBeInTheDocument();
        expect(container.querySelector('[data-widget-resize-handle]')).not.toBeNull();

        // Outside edit mode there is no slot, so no actions and no handle.
        rerender(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(container.querySelector('[data-widget-actions]')).toBeNull();
        expect(container.querySelector('[data-widget-resize-handle]')).toBeNull();
    });

    it('KPI/critical-risks renders the critical count + open/high subtitle', () => {
        const widget = makeWidget({
            type: 'KPI',
            chartType: 'critical-risks',
            config: { format: 'number' },
            title: 'Critical Risks',
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(screen.getByText('Critical Risks')).toBeInTheDocument();
        expect(screen.getByText('3')).toBeInTheDocument();
        expect(screen.getByText(/12 open · 4 high/)).toBeInTheDocument();
    });

    it('KPI/overdue-evidence renders the overdue count + due-soon subtitle', () => {
        const widget = makeWidget({
            type: 'KPI',
            chartType: 'overdue-evidence',
            config: { format: 'number' },
            title: 'Overdue Evidence',
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(screen.getByText('Overdue Evidence')).toBeInTheDocument();
        expect(screen.getByText('8')).toBeInTheDocument();
        expect(
            screen.getByText(/5 due within 7 days/),
        ).toBeInTheDocument();
    });

    it('KPI/tenants renders the total + snapshotted subtitle', () => {
        const widget = makeWidget({
            type: 'KPI',
            chartType: 'tenants',
            config: { format: 'number' },
            title: 'Tenants',
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(screen.getByText('Tenants')).toBeInTheDocument();
        expect(screen.getByText('12')).toBeInTheDocument();
        expect(screen.getByText(/10 snapshotted/)).toBeInTheDocument();
    });

    // ─── DONUT ───────────────────────────────────────────────────

    it('DONUT/rag-distribution renders the four RAG bands', () => {
        const widget = makeWidget({
            type: 'DONUT',
            chartType: 'rag-distribution',
            config: { showLegend: true },
            title: 'Tenant Health Distribution',
            size: { w: 6, h: 4 },
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        // The wrapper renders the title.
        expect(
            screen.getByText('Tenant Health Distribution'),
        ).toBeInTheDocument();
        // The donut renders the three positive segments + one PENDING.
        // (RAG_COLORS includes PENDING, but only segments with value>0
        // pass the filter — green=6, amber=3, red=1, pending=2 → 4)
        expect(screen.getByText('Healthy')).toBeInTheDocument();
        expect(screen.getByText('At risk')).toBeInTheDocument();
        // Disambiguated from the "Critical Risks" metric — this is a
        // tenant-health band, not a risk count.
        expect(screen.getByText('Critical health')).toBeInTheDocument();
        expect(screen.getByText('Pending snapshot')).toBeInTheDocument();
    });

    // ─── TENANT_LIST ─────────────────────────────────────────────

    it('TENANT_LIST renders tenant rows with drill-down hrefs', () => {
        const widget = makeWidget({
            type: 'TENANT_LIST',
            chartType: 'coverage',
            config: { sortBy: 'rag' },
            title: 'Coverage by Tenant',
            size: { w: 12, h: 6 },
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(screen.getByText('Coverage by Tenant')).toBeInTheDocument();
        // Both fixture tenants appear; sort 'rag' puts AMBER (Alpha)
        // before GREEN (Beta).
        const links = screen.getAllByRole('link');
        const alpha = links.find((a) => a.textContent?.includes('Alpha Co'));
        const beta = links.find((a) => a.textContent?.includes('Beta Co'));
        expect(alpha?.getAttribute('href')).toBe('/t/alpha/dashboard');
        expect(beta?.getAttribute('href')).toBe('/t/beta/dashboard');
    });

    // ─── DRILLDOWN_CTAS ──────────────────────────────────────────

    it('DRILLDOWN_CTAS renders three nav cards pointing at /org/<slug>/{controls,risks,evidence}', () => {
        const widget = makeWidget({
            type: 'DRILLDOWN_CTAS',
            chartType: 'default',
            config: {},
            title: 'Drill-down',
            size: { w: 12, h: 2 },
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(screen.getByText('Drill-down')).toBeInTheDocument();
        expect(
            screen.getByTestId('org-drilldown-controls').getAttribute('href'),
        ).toBe('/org/acme-org/controls');
        expect(
            screen.getByTestId('org-drilldown-risks').getAttribute('href'),
        ).toBe('/org/acme-org/risks');
        expect(
            screen.getByTestId('org-drilldown-evidence').getAttribute('href'),
        ).toBe('/org/acme-org/evidence');
    });

    it('DRILLDOWN_CTAS respects entries config (subset rendering)', () => {
        const widget = makeWidget({
            type: 'DRILLDOWN_CTAS',
            chartType: 'default',
            config: { entries: ['controls', 'risks'] },
            title: 'Drill-down',
            size: { w: 12, h: 2 },
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(
            screen.getByTestId('org-drilldown-controls'),
        ).toBeInTheDocument();
        expect(
            screen.getByTestId('org-drilldown-risks'),
        ).toBeInTheDocument();
        expect(
            screen.queryByTestId('org-drilldown-evidence'),
        ).toBeNull();
    });

    // ─── Metric consistency ──────────────────────────────────────
    //
    // "Critical risks" is ONE number, sourced from summary.risks.critical,
    // and must read identically wherever it appears (the KPI tile + the
    // drill-down card). The donut's "Critical health" band is a DIFFERENT
    // metric (summary.rag.red — tenant health), which is exactly why it is
    // labelled distinctly and must never be conflated with the risk count.
    it('"critical risks" is the same number in the KPI and the drill-down (single source)', () => {
        const data = makeData(); // summary.risks.critical = 3, rag.red = 1
        const critical = data.summary.risks.critical;

        const kpi = render(
            <DispatchedWidget
                widget={makeWidget({
                    type: 'KPI',
                    chartType: 'critical-risks',
                    config: { format: 'number' },
                    title: 'Critical Risks',
                })}
                data={data}
            />,
        );
        expect(kpi.getByText(String(critical))).toBeInTheDocument();
        kpi.unmount();

        const drill = render(
            <DispatchedWidget
                widget={makeWidget({
                    type: 'DRILLDOWN_CTAS',
                    chartType: 'default',
                    config: {},
                    title: 'Drill-down',
                })}
                data={data}
            />,
        );
        expect(
            drill.getByTestId('org-drilldown-risks').textContent,
        ).toContain(String(critical));

        // The tenant-health "Critical health" band is a genuinely different
        // number — proving the two must stay labelled apart.
        expect(data.summary.rag.red).not.toBe(critical);
    });
});
