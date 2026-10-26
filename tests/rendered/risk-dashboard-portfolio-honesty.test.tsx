/**
 * RQ3-3 — the risk dashboard's quant headline is a distribution.
 *
 * Locks: with a completed simulation the KPI tiles are the simulated
 * P50/P80/P95 (Σ demoted to the subordinate line with the gap
 * tooltip); without a run the Σ tiles survive but carry the
 * run-a-simulation nudge.
 */
import { render, screen, waitFor } from '@testing-library/react';
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
// next-intl is ESM — mock it, resolving real en.json values with {param}
// interpolation so the sum-line / nudge copy renders (not the raw key).
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en[ns],
            );
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});
jest.mock('@visx/responsive', () => ({
    ParentSize: ({ children }: { children: (s: { width: number }) => React.ReactNode }) =>
        children({ width: 600 }),
}));

import { SWRConfig } from 'swr';
import { TooltipProvider } from '@/components/ui/tooltip';
import RiskDashboardPage from '@/app/t/[tenantSlug]/(app)/risks/dashboard/page';

const renderPage = () =>
    render(
        // RQ3-9 — wrap in SWRConfig with a fresh Map provider so the
        // dashboard SWR cache doesn't leak between tests (the second
        // test would otherwise see the first test's simulation run).
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider delayDuration={0}>
                <RiskDashboardPage />
            </TooltipProvider>
        </SWRConfig>,
    );

const ANALYTICS = {
    totals: { totalCount: 3, quantifiedCount: 2, totalAle: 300_000, avgAle: 150_000, maxAle: 200_000 },
    topByAle: [
        { id: 'r1', title: 'Data breach', category: 'Technical', sleAmount: 0, aroAmount: 0, ale: 200_000 },
    ],
    byCategory: [{ category: 'Technical', count: 2, totalAle: 300_000 }],
};

const RUN = {
    portfolioMean: 400_000, portfolioP50: 380_000, portfolioP80: 520_000,
    portfolioP90: 600_000, portfolioP95: 700_000, portfolioP99: 900_000,
    portfolioStdDev: 120_000, iterations: 10_000, executionMs: 42,
    completedAt: '2026-06-12T00:00:00.000Z',
    lecPointsJson: [{ threshold: 380_000, probability: 0.5 }],
    perRiskResultsJson: [
        { riskId: 'r1', title: 'Data breach', aleMean: 200_000, aleP90: 950_000, contribution: 0.6 },
    ],
};

const MATRIX = {
    likelihoodLevels: 5,
    impactLevels: 5,
    axisLikelihoodLabel: 'Likelihood',
    axisImpactLabel: 'Impact',
    levelLabels: { likelihood: ['1', '2', '3', '4', '5'], impact: ['1', '2', '3', '4', '5'] },
    bands: [
        { name: 'Low', minScore: 1, maxScore: 6, color: '#22c55e' },
        { name: 'Medium', minScore: 7, maxScore: 14, color: '#eab308' },
        { name: 'High', minScore: 15, maxScore: 19, color: '#f97316' },
        { name: 'Critical', minScore: 20, maxScore: 25, color: '#ef4444' },
    ],
};

function mockFetch(run: typeof RUN | null) {
    // RQ3-9 — the dashboard now fires ONE batched call to
    // `/risks/dashboard`. The orchestrator returns every slot in
    // one payload, so the rendered test mocks the orchestrator
    // shape rather than five legacy endpoints.
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.endsWith('/risks/dashboard')) {
            return {
                ok: true,
                json: async () => ({
                    risks: [],
                    analytics: ANALYTICS,
                    coherence: null,
                    staleness: null,
                    appetite: null,
                    simulation: run,
                    matrix: MATRIX,
                }),
            } as Response;
        }
        return { ok: false, json: async () => null } as Response;
    }) as unknown as typeof fetch;
}

describe('Risk dashboard — portfolio honesty (RQ3-3)', () => {
    it('headlines the simulated P50/P80/P95 and demotes Σ to the tooltip line', async () => {
        mockFetch(RUN);
        renderPage();
        await waitFor(() => expect(screen.getByTestId('risk-quant-tile-p80')).toBeInTheDocument());
        expect(screen.getByTestId('risk-quant-tile-p50').textContent).toContain('€380K');
        expect(screen.getByTestId('risk-quant-tile-p95').textContent).toContain('€700K');
        // Σ survives only as the subordinate line.
        expect(screen.queryByTestId('risk-quant-tile-total')).toBeNull();
        expect(screen.getByTestId('risk-quant-sum-line').textContent).toContain('€300K');
        expect(screen.queryByTestId('risk-quant-sum-nudge')).toBeNull();
        // RQ3-4 — the top-10 row speaks the compact tail register.
        expect(screen.getByTestId('risk-quant-top-row-r1').textContent).toContain('€200K · bad yr €950K');
    });

    it('without a run, Σ tiles survive with the run-a-simulation nudge', async () => {
        mockFetch(null);
        renderPage();
        await waitFor(() => expect(screen.getByTestId('risk-quant-tile-total')).toBeInTheDocument());
        expect(screen.queryByTestId('risk-quant-tile-p80')).toBeNull();
        expect(screen.getByTestId('risk-quant-sum-nudge').textContent).toMatch(/Run a simulation/);
    });
});
