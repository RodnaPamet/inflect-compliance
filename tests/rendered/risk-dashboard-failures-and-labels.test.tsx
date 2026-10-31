/**
 * #4768 — the risk dashboard says when it could not load, names the
 * sections the server could not compute, shows statuses as the register
 * does, and caps the overdue list like the stale list beside it.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantName: 'Acme',
        tenantSlug: 'acme',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
        appPermissions: require('@/lib/permissions').getPermissionsForRole('ADMIN'),
    }),
    useMoneyFormatter: () => (v: number | null | undefined) =>
        jest.requireActual('@/lib/risk-coherence').formatCompactCurrency(v),
}));
jest.mock('@visx/responsive', () => ({
    ParentSize: ({ children }: { children: (s: { width: number }) => React.ReactNode }) =>
        children({ width: 600 }),
}));

import { SWRConfig } from 'swr';
import { TooltipProvider } from '@/components/ui/tooltip';
import RiskDashboardPage from '@/app/t/[tenantSlug]/(app)/risks/dashboard/page';

const EN = jest.requireActual('../../messages/en.json') as {
    riskManager: { dash: Record<string, string> };
    risks: { bulkStatus: Record<string, string> };
};
const D = EN.riskManager.dash;

const MATRIX = {
    likelihoodLevels: 5, impactLevels: 5,
    axisLikelihoodLabel: 'Likelihood', axisImpactLabel: 'Impact',
    levelLabels: { likelihood: ['1', '2', '3', '4', '5'], impact: ['1', '2', '3', '4', '5'] },
    bands: [{ name: 'Low', minScore: 1, maxScore: 25, color: '#22c55e' }],
};

const risk = (i: number, extra: Record<string, unknown> = {}) => ({
    id: `r${i}`, title: `Risk ${i}`, likelihood: 2, impact: 2, score: 4, inherentScore: 4,
    status: 'OPEN', category: null, treatmentOwner: null, nextReviewAt: null, ...extra,
});

const reply = (status: number, body: unknown) => ({
    ok: status < 400, status, headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body, text: async () => JSON.stringify(body),
}) as unknown as Response;

function mockFetch(dashboard: Record<string, unknown> | 'fail') {
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.endsWith('/risks/dashboard')) {
            if (dashboard === 'fail') return reply(500, { error: { code: 'INTERNAL', message: 'boom' } });
            return reply(200, {
                risks: [risk(1)], analytics: null, coherence: null, staleness: null,
                appetite: null, simulation: null, matrix: MATRIX, failed: [], ...dashboard,
            });
        }
        return reply(500, { error: { code: 'INTERNAL', message: 'boom' } });
    }) as unknown as typeof fetch;
}

const renderPage = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TooltipProvider delayDuration={0}><RiskDashboardPage /></TooltipProvider>
        </SWRConfig>,
    );

describe('Risk dashboard — #4768', () => {
    it('a failed read shows an error with a retry, not a skeleton for ever', async () => {
        mockFetch('fail');
        renderPage();
        expect(await screen.findByTestId('risk-dashboard-error')).toHaveTextContent(D.loadErrorTitle);
        expect(screen.getByRole('button', { name: D.retry })).toBeInTheDocument();
    });

    it('names the sections the server could not compute', async () => {
        mockFetch({ failed: ['analytics', 'simulation'] });
        renderPage();
        const banner = await screen.findByTestId('risk-dashboard-partial');
        expect(banner).toHaveTextContent(D.slot_analytics);
        expect(banner).toHaveTextContent(D.slot_simulation);
        // The simulation card says it could not be read, not "no simulation yet".
        expect(screen.getByTestId('mc-run-unavailable')).toBeInTheDocument();
    });

    it('shows no banner when nothing failed', async () => {
        mockFetch({});
        renderPage();
        await screen.findByText(EN.risks.bulkStatus.open);
        expect(screen.queryByTestId('risk-dashboard-partial')).toBeNull();
    });

    it('labels statuses as the register does', async () => {
        mockFetch({ risks: [risk(1), risk(2, { status: 'MITIGATING' })] });
        renderPage();
        expect(await screen.findByText(EN.risks.bulkStatus.mitigating)).toBeInTheDocument();
        expect(screen.queryByText('MITIGATING')).toBeNull();
    });

    it('caps the overdue list at ten and counts the rest', async () => {
        const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
        mockFetch({ risks: Array.from({ length: 12 }, (_, i) => risk(i, { nextReviewAt: past })) });
        renderPage();
        expect(await screen.findByTestId('risk-overdue-more')).toHaveTextContent('2 more');
    });
});
