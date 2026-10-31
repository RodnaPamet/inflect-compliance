/** @jest-environment jsdom */

/**
 * The coverage map counts its gaps, says when there is nothing to cover, and
 * words what it shows (#4739).
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

// A stable translator per namespace, as next-intl gives.
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));
jest.mock('@/lib/nav/use-guarded-push', () => ({ useGuardedPush: () => jest.fn() }));
jest.mock('@/lib/hooks/use-risk-matrix-config', () => {
    const { DEFAULT_BANDS } = jest.requireActual('@/lib/risk-matrix/defaults');
    return { useRiskMatrixConfig: () => ({ config: { bands: DEFAULT_BANDS } }) };
});
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/coverage',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { CoverageClient } from '@/app/t/[tenantSlug]/(app)/coverage/CoverageClient';

const EN = jest.requireActual('../../messages/en.json') as {
    coverage: Record<string, string> & Record<'riskStatus' | 'assetType' | 'criticality', Record<string, string>>;
};
const C = EN.coverage;

type Data = React.ComponentProps<typeof CoverageClient>['data'];
const base: Data = {
    totalRisks: 50,
    totalControls: 20,
    totalAssets: 15,
    risksWithControlsCount: 10,
    risksWithControlsPct: 20,
    controlsWithRisksCount: 5,
    controlsWithRisksPct: 25,
    assetsWithControlsCount: 3,
    assetsWithControlsPct: 20,
    controlsWithProcessCount: 0,
    controlsWithProcessPct: 0,
    unmappedRisks: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, title: `Risk ${i}`, score: 12, status: 'OPEN' as const })),
    unmappedRisksTotal: 40,
    uncoveredCriticalAssets: [{ id: 'a1', name: 'Payroll DB', type: 'DATA_STORE' as const, criticality: 'CRITICAL' as const }],
    uncoveredCriticalAssetsTotal: 1,
    totalCriticalAssets: 4,
    hotControls: [],
};

describe('coverage map', () => {
    it('counts every unmapped risk, says the list is the first ten, and links to the rest', () => {
        render(<CoverageClient data={base} tenantSlug="acme" />);
        expect(document.getElementById('unmapped-risks-count')).toHaveTextContent('40');
        const more = document.getElementById('unmapped-risks-more')!;
        expect(more).toHaveTextContent(C.showingOf.replace('{shown}', '10').replace('{total}', '40'));
        expect(screen.getByRole('link', { name: C.viewAllRisks })).toHaveAttribute('href', '/t/acme/risks');
        // Every row fits: no "showing" line for the assets.
        expect(document.getElementById('uncovered-assets-more')).toBeNull();
    });

    it('words status, type and criticality, and badges a critical asset as critical', () => {
        render(<CoverageClient data={base} tenantSlug="acme" />);
        expect(screen.getAllByText(C.riskStatus.OPEN).length).toBeGreaterThan(0);
        expect(screen.getByText(C.assetType.DATA_STORE)).toBeInTheDocument();
        expect(screen.getByText(C.criticality.CRITICAL)).toBeInTheDocument();
        for (const raw of ['OPEN', 'DATA STORE', 'CRITICAL']) expect(screen.queryByText(raw)).toBeNull();
    });

    it('says there is nothing to cover rather than that everything is covered', () => {
        render(
            <CoverageClient
                data={{
                    ...base,
                    totalRisks: 0, risksWithControlsCount: 0, risksWithControlsPct: 0,
                    unmappedRisks: [], unmappedRisksTotal: 0,
                    uncoveredCriticalAssets: [], uncoveredCriticalAssetsTotal: 0, totalCriticalAssets: 0,
                }}
                tenantSlug="acme"
            />,
        );
        expect(screen.getByText(C.emptyRisksNone)).toBeInTheDocument();
        expect(screen.getByText(C.emptyAssetsNone)).toBeInTheDocument();
        expect(screen.queryByText(C.emptyRisks)).toBeNull();
        expect(screen.queryByText(C.emptyAssets)).toBeNull();
        // The risk KPI shows no percentage over an empty register.
        expect(document.getElementById('kpi-risks-mitigated')).toHaveTextContent(C.nothingToCover);
    });
});
