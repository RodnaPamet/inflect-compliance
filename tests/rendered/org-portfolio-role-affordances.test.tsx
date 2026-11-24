/**
 * THE PORTFOLIO OFFERS ONLY WHAT THE VIEWER'S ORG ROLE CAN OPEN (#5313).
 *
 *   1. The empty-portfolio onboarding sends only an organization owner
 *      (`canManageTenants`) to the workspaces page. An ORG_ADMIN, who cannot
 *      create a workspace, is told to ask an owner and offered no link.
 *   2. Without `canDrillDown` (ORG_READER) the tenant rows, the drill-down
 *      cards and the workspaces list's names are text, not links to a page
 *      that refuses the reader.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.setTimeout(60_000);

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/org/acme-org',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ orgSlug: 'acme-org' }),
}));

// The dashboard imports the grid and the (lazily loaded) picker from their
// own modules, not the barrel.
jest.mock('@/components/ui/dashboard-widgets/DashboardGrid', () => ({
    DashboardGrid: () => <div data-testid="grid" />,
}));
jest.mock('@/components/ui/dashboard-widgets/WidgetPicker', () => ({
    WidgetPicker: () => null,
}));

let orgPerms = { canManageTenants: false, canDrillDown: false, canManageMembers: false };
jest.mock('@/lib/org-context-provider', () => ({
    useOrgPermissions: () => orgPerms,
}));

import { PortfolioDashboard } from '@/app/org/[orgSlug]/(app)/PortfolioDashboard';
import { DrillDownCtas, TenantCoverageList } from '@/app/org/[orgSlug]/(app)/dashboard-sections';
import { TenantsTable } from '@/app/org/[orgSlug]/(app)/tenants/TenantsTable';
import type { PortfolioData } from '@/app/org/[orgSlug]/(app)/widget-dispatcher';

const EN = (require('../../messages/en.json') as {
    org: { dashboard: Record<string, string> };
}).org.dashboard;

const widget = {
    id: 'w1',
    organizationId: 'org_1',
    type: 'KPI',
    chartType: 'coverage',
    title: 'Coverage',
    config: {},
    position: { x: 0, y: 0 },
    size: { w: 3, h: 2 },
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
};

const emptyPortfolio = {
    orgSlug: 'acme-org',
    summary: { generatedAt: '2026-05-03T00:00:00Z', tenants: { total: 0, snapshotted: 0, pending: 0 } },
    canDrillDown: true,
} as unknown as PortfolioData;

const summary = {
    controls: { applicable: 10, implemented: 7 },
    risks: { critical: 2 },
    evidence: { overdue: 1 },
} as never;

const tenantRow = {
    tenantId: 't-1',
    slug: 'eu',
    name: 'Acme EU',
    drillDownUrl: '/t/eu/dashboard',
    hasSnapshot: true,
    snapshotDate: '2026-10-31',
    rag: 'GREEN',
    coveragePercent: 80,
    openRisks: 3,
    criticalRisks: 0,
    overdueEvidence: 0,
} as never;

describe('empty-portfolio onboarding', () => {
    it('sends an owner to the workspaces page', () => {
        render(<PortfolioDashboard initialWidgets={[widget] as never} data={emptyPortfolio} canEdit canManageTenants />);
        const empty = screen.getByTestId('dashboard-onboarding-empty-state');
        expect(empty).toHaveTextContent(EN.onboardingTitle);
        expect(within(empty).getByRole('link', { name: EN.manageTenants })).toHaveAttribute('href', '/org/acme-org/tenants');
    });

    it('tells an ORG_ADMIN, who cannot create one, to ask an owner — with no link', () => {
        render(<PortfolioDashboard initialWidgets={[widget] as never} data={emptyPortfolio} canEdit canManageTenants={false} />);
        const empty = screen.getByTestId('dashboard-onboarding-empty-state');
        expect(empty).toHaveTextContent(EN.onboardingTitleAskOwner);
        expect(empty).toHaveTextContent(EN.onboardingDescAskOwner);
        expect(empty).not.toHaveTextContent(EN.onboardingTitle);
        expect(within(empty).queryByRole('link')).toBeNull();
    });
});

describe('a viewer without drill-down', () => {
    it('sees the drill-down cards as counts, not links', () => {
        render(<DrillDownCtas summary={summary} orgSlug="acme-org" canDrillDown={false} />);
        const ctas = screen.getByTestId('org-drilldown-ctas');
        expect(within(ctas).queryByRole('link')).toBeNull();
        expect(screen.getByTestId('org-drilldown-risks')).toHaveTextContent('2');
    });

    it('still gets links when it can drill down', () => {
        render(<DrillDownCtas summary={summary} orgSlug="acme-org" canDrillDown />);
        expect(within(screen.getByTestId('org-drilldown-ctas')).getAllByRole('link')).toHaveLength(3);
    });

    it('sees the tenant coverage rows as text', () => {
        render(<TenantCoverageList rows={[tenantRow]} canDrillDown={false} />);
        const list = screen.getByTestId('org-tenant-coverage-list');
        expect(within(list).getByText('Acme EU')).toBeInTheDocument();
        expect(within(list).queryByRole('link')).toBeNull();
    });

    it('sees workspace names in the workspaces list as text, not links to /no-tenant', () => {
        orgPerms = { canManageTenants: false, canDrillDown: false, canManageMembers: false };
        render(<TenantsTable rows={[tenantRow]} orgSlug="acme-org" />);
        expect(screen.getByTestId('org-tenant-name-eu')).toHaveTextContent('Acme EU');
        expect(screen.queryByTestId('org-tenant-link-eu')).toBeNull();
    });

    it('an admin who can drill down keeps the workspace link', () => {
        orgPerms = { canManageTenants: false, canDrillDown: true, canManageMembers: true };
        render(<TenantsTable rows={[tenantRow]} orgSlug="acme-org" />);
        expect(screen.getByTestId('org-tenant-link-eu')).toHaveAttribute('href', '/t/eu/dashboard');
    });
});
