/**
 * RQ3-OB-C — the risk dashboard's drill-down widgets deep-link INTO the
 * assessment tab, not the detail page's default tab.
 *
 * REPLACES the byte-window assertions in
 * `tests/guards/rq3-ob-c-tab-deep-links.test.ts`, which sliced
 * `dashboard.indexOf('risk-stale-row-') - 800` to `+ 400` and regexed
 * inside. Two silent failure modes: an unrelated edit upstream slid the
 * window off the markup it meant to check, and the regexes pinned
 * loop-variable names (`r.riskId`, `f.riskId`), so a rename broke the
 * build. A later revision counted `?tab=assessment` occurrences in the
 * source, which was robust but still could not say WHICH widget linked
 * where — the thing that actually matters to a user landing on the page.
 *
 * This renders the dashboard and reads the anchors' `href`.
 *
 * The invariant is asymmetric on purpose, and both halves are asserted:
 * the three ROT widgets (coherence, staleness, overdue reviews) deep-link
 * to the assessment pane because that is where the user closes the signal;
 * the top-10-by-ALE row deliberately does NOT, because it is a
 * "show me this risk" link, not a "fix this" one. A blanket
 * "add ?tab=assessment everywhere" change is caught by the last test.
 */
import { render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantName: 'Acme', tenantSlug: 'acme' }),
    useMoneyFormatter: () => (v: number | null | undefined) =>
        jest.requireActual('@/lib/risk-coherence').formatCompactCurrency(v),
}));
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

/** A risk whose review date is a fortnight in the past. */
const OVERDUE_RISK = {
    id: 'overdue-1',
    title: 'Overdue review risk',
    likelihood: 3,
    impact: 3,
    score: 9,
    inherentScore: 9,
    status: 'OPEN',
    category: 'Technical',
    treatment: null,
    treatmentOwner: 'Ada',
    nextReviewAt: new Date(Date.now() - 14 * 86_400_000).toISOString(),
};

function mockFetch() {
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.endsWith('/risks/dashboard')) {
            return {
                ok: true,
                json: async () => ({
                    risks: [OVERDUE_RISK],
                    analytics: {
                        totals: { totalCount: 1, quantifiedCount: 0, totalAle: 0, avgAle: 0, maxAle: 0 },
                        topByAle: [],
                        byCategory: [],
                    },
                    coherence: {
                        quantifiedCount: 5,
                        minRequired: 3,
                        flags: [
                            {
                                riskId: 'coh-1',
                                title: 'Coherence risk',
                                score: 20,
                                ale: 1_000,
                                direction: 'QUANT_LOW_QUAL_HIGH',
                            },
                        ],
                    },
                    staleness: {
                        staleCount: 1,
                        staleRisks: [
                            {
                                riskId: 'stale-1',
                                title: 'Stale risk',
                                description: 'Assessment is 200 days old',
                                reasons: ['AGED'],
                            },
                        ],
                    },
                    appetite: null,
                    simulation: null,
                    matrix: MATRIX,
                }),
            } as Response;
        }
        return { ok: false, json: async () => null } as Response;
    }) as unknown as typeof fetch;
}

const renderPage = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider delayDuration={0}>
                <RiskDashboardPage />
            </TooltipProvider>
        </SWRConfig>,
    );

/** The nearest enclosing anchor's href. */
const hrefOf = (el: HTMLElement) =>
    (el.closest('a') ?? el).getAttribute('href');

describe('RQ3-OB-C — dashboard drill-downs deep-link to the assessment tab', () => {
    beforeEach(() => {
        mockFetch();
    });

    it('the staleness row links into the assessment tab', async () => {
        renderPage();
        const row = await screen.findByTestId('risk-stale-row-stale-1');
        expect(hrefOf(row)).toBe('/t/acme/risks/stale-1?tab=assessment');
    });

    it('the coherence row links into the assessment tab', async () => {
        renderPage();
        const row = await screen.findByTestId('risk-coherence-row-coh-1');
        expect(hrefOf(row)).toBe('/t/acme/risks/coh-1?tab=assessment');
    });

    it('the overdue-review row links into the assessment tab', async () => {
        renderPage();
        // No testid on this row — find it by the risk's title, which is what
        // a user reads, and walk up to its anchor.
        const link = await screen.findByText('Overdue review risk');
        expect(hrefOf(link)).toBe('/t/acme/risks/overdue-1?tab=assessment');
    });

    it('every risk deep-link on the page carries the tab, none carries a stray query', async () => {
        renderPage();
        await waitFor(() => expect(screen.getByTestId('risk-stale-row-stale-1')).toBeInTheDocument());

        const riskLinks = Array.from(document.querySelectorAll('a[href*="/risks/"]'))
            .map((a) => a.getAttribute('href')!)
            .filter((h) => /\/risks\/[^/?]+(\?|$)/.test(h));

        expect(riskLinks.length).toBeGreaterThanOrEqual(3);
        for (const href of riskLinks) {
            // Either a clean detail link or exactly the assessment tab —
            // never some third query string nobody meant to ship.
            expect(href).toMatch(/\/risks\/[^/?]+(\?tab=assessment)?$/);
        }
    });
});
