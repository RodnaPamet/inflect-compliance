/**
 * PR-G — Reports catalog behavioural tests.
 *
 * Covers the two load-bearing invariants: the SoA catalog entry is ISO-family
 * ONLY (hidden entirely for a non-ISO selection), and switching the framework
 * selector re-fetches + re-renders the on-screen readiness report.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// Permission/entitlement/export seams pull tenant context — passthrough them.
jest.mock('@/components/require-permission', () => ({
    RequirePermission: ({ children }: any) => <>{children}</>,
}));
jest.mock('@/components/UpgradeGate', () => ({
    UpgradeGate: ({ children }: any) => <>{children}</>,
}));
jest.mock('@/components/PdfExportButton', () => ({
    PdfExportButton: ({ label }: any) => <button>{label}</button>,
}));
jest.mock('@/components/ui/tooltip', () => ({
    Tooltip: ({ children }: any) => <>{children}</>,
}));

import { ReportsClient } from '@/app/t/[tenantSlug]/(app)/reports/ReportsClient';

const ISO = { key: 'ISO27001', name: 'ISO 27001:2022', isIsoFamily: true };
const SOC2 = { key: 'SOC2', name: 'SOC 2', isIsoFamily: false };
const NIS2 = { key: 'NIS2', name: 'NIS2', isIsoFamily: false };

function readiness(key: string, coveragePercent: number): any {
    return {
        framework: { key, name: key, version: null },
        generatedAt: '2026-07-16T00:00:00.000Z',
        coverage: { total: 10, mapped: coveragePercent / 10, unmapped: 0, coveragePercent },
        bySection: [],
        unmappedRequirements: [],
        controlsMissingEvidence: [],
        overdueTasks: [],
        summary: {
            totalRequirements: 10,
            mappedRequirements: coveragePercent / 10,
            coveragePercent,
            implementedRequirements: 4,
            gapRequirements: 6,
            exceptedRequirements: 1,
            notApplicableCount: 0,
            missingEvidenceCount: 0,
            overdueTaskCount: 0,
            readinessScore: 50,
        },
    };
}

function renderClient(frameworks: any[], defaultKey: string) {
    return render(
        <ReportsClient
            installedFrameworks={frameworks}
            defaultFrameworkKey={defaultKey}
            initialReadiness={readiness(defaultKey, 80)}
            tenantSlug="acme"
            canEdit
        />,
    );
}

describe('ReportsClient — SoA is ISO-family-only', () => {
    it('shows the SoA catalog card when an ISO framework is selected', () => {
        renderClient([ISO, SOC2], 'ISO27001');
        expect(screen.getByTestId('report-card-soa')).toBeInTheDocument();
        // The universal default report renders on-screen.
        expect(screen.getByTestId('readiness-report-body')).toBeInTheDocument();
        expect(screen.getByTestId('report-card-coverage')).toBeInTheDocument();
    });

    it('HIDES the SoA card entirely for a non-ISO selection', () => {
        renderClient([SOC2, NIS2], 'SOC2');
        expect(screen.queryByTestId('report-card-soa')).not.toBeInTheDocument();
        // The rest of the catalog still renders.
        expect(screen.getByTestId('report-card-coverage')).toBeInTheDocument();
        expect(screen.getByTestId('report-card-risk')).toBeInTheDocument();
        expect(screen.getByTestId('readiness-report-body')).toBeInTheDocument();
    });
});

describe('ReportsClient — honest metrics + unified risk reporting (PR-I)', () => {
    it('shows Mapped % distinct from Implemented % in the readiness view', () => {
        renderClient([ISO, SOC2], 'ISO27001');
        // next-intl is mocked to echo keys, so the metric labels appear as keys.
        expect(screen.getByText('mappedPct')).toBeInTheDocument();
        expect(screen.getByText('implementedPct')).toBeInTheDocument();
        expect(screen.getByText('readinessScore')).toBeInTheDocument();
    });

    it('surfaces the mature risk-report engine (templates + link), no thin duplicate', () => {
        renderClient([ISO, SOC2], 'ISO27001');
        // The Risk Register card lists the engine's templates and links into it.
        expect(screen.getByTestId('risk-report-templates')).toBeInTheDocument();
        expect(document.querySelector('#report-card-risk-link')).toBeInTheDocument();
        // The retired thin hub CSV/PDF export button is gone.
        expect(document.querySelector('#export-risks-btn')).toBeNull();
    });

    it('lists the tenant\'s REAL templates, not three hardcoded i18n strings', () => {
        // The card used to render `riskTplPortfolio` / `riskTplDeepDive` /
        // `riskTplBia` as static <li>s, duplicating SYSTEM_TEMPLATES — so a
        // tenant's CUSTOM template never appeared here, and because the hub
        // TRANSLATED those names while /risks/reports renders the raw English DB
        // value, the same template had two different names one click apart.
        renderClient([ISO, SOC2], 'ISO27001');
        const list = screen.getByTestId('risk-report-templates');
        // next-intl is mocked to echo keys, so any surviving hardcoded key would
        // still be visible in the DOM.
        expect(list.textContent).not.toMatch(/riskTpl(Portfolio|DeepDive|Bia)/);
    });
});

describe('ReportsClient — framework selector switches the rendered report', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
        jest.clearAllMocks();
    });

    it('re-fetches readiness for the newly-selected framework', async () => {
        const fetchMock = jest.fn(async () =>
            new Response(JSON.stringify(readiness('SOC2', 25)), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        global.fetch = fetchMock as any;

        const { container } = renderClient([ISO, SOC2], 'ISO27001');
        // Open the framework selector and pick the non-default framework.
        const trigger = container.querySelector('#reports-framework-select button');
        fireEvent.click(trigger as Element);
        // The option label comes from the framework name (not i18n).
        const soc2Option = await screen.findByText('SOC 2');
        fireEvent.click(soc2Option);

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/reports/readiness?framework=SOC2'),
            );
        });
        // Switching to a non-ISO framework also removes the SoA card.
        await waitFor(() => {
            expect(screen.queryByTestId('report-card-soa')).not.toBeInTheDocument();
        });
    });
});
