/**
 * B1-5 — the dashboard heatmap honours the tenant's risk-matrix config.
 *
 * Two defects, both of which rendered a heatmap that looked fine and was
 * wrong:
 *
 * 1. `heatmapClassForBand` switched on `band.name` against the literal
 *    strings 'Low' / 'Medium' / 'High' / 'Critical', while its own comment
 *    claimed it "consults the tenant's CANONICAL band … so a tenant who
 *    customises thresholds gets the right tone without code changes".
 *    `RiskMatrixConfig` lets a tenant RENAME bands, so any tenant who did
 *    fell through to `default:` and got a uniformly grey grid.
 *
 * 2. The grid was hardcoded 5×5 — `[5,4,3,2,1]` rows, `[1,2,3,4,5]` columns,
 *    `grid-cols-[auto_repeat(5,1fr)]` — ignoring `likelihoodLevels` /
 *    `impactLevels`. A 6×6 tenant got a SILENTLY TRUNCATED heatmap: the
 *    level-6 row and column were never drawn, so risks sitting there
 *    vanished from the picture with nothing to indicate an omission. A 3×3
 *    tenant got phantom cells for levels that do not exist.
 *
 * Neither is visible to a source-text assertion — both produce a grid that
 * renders without error. Counting cells and reading their tone classes is
 * the only way to see them.
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

/** A matrix config with arbitrary dimensions and band names. */
function matrixConfig(opts: {
    likelihoodLevels: number;
    impactLevels: number;
    bandNames: string[];
}) {
    const { likelihoodLevels, impactLevels, bandNames } = opts;
    const max = likelihoodLevels * impactLevels;
    const step = Math.ceil(max / bandNames.length);
    return {
        likelihoodLevels,
        impactLevels,
        axisLikelihoodLabel: 'Likelihood',
        axisImpactLabel: 'Impact',
        levelLabels: {
            likelihood: Array.from({ length: likelihoodLevels }, (_, i) => String(i + 1)),
            impact: Array.from({ length: impactLevels }, (_, i) => String(i + 1)),
        },
        bands: bandNames.map((name, i) => ({
            name,
            minScore: i * step + 1,
            maxScore: i === bandNames.length - 1 ? max : (i + 1) * step,
            color: '#888888',
        })),
    };
}

function mockFetch(matrix: ReturnType<typeof matrixConfig>, risks: unknown[] = []) {
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
        if (String(url).endsWith('/risks/dashboard')) {
            return {
                ok: true,
                json: async () => ({
                    risks,
                    analytics: {
                        totals: { totalCount: risks.length, quantifiedCount: 0, totalAle: 0, avgAle: 0, maxAle: 0 },
                        topByAle: [],
                        byCategory: [],
                    },
                    coherence: null,
                    staleness: null,
                    appetite: null,
                    simulation: null,
                    matrix,
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

/** Every heatmap cell — they are the only elements carrying `data-band`. */
const cells = () => Array.from(document.querySelectorAll('[data-band]'));

describe('risk dashboard heatmap — honours the matrix config (B1-5)', () => {
    it('draws a 6×6 grid for a 6×6 tenant, not a truncated 5×5', async () => {
        mockFetch(matrixConfig({
            likelihoodLevels: 6,
            impactLevels: 6,
            bandNames: ['Low', 'Medium', 'High', 'Critical'],
        }));
        renderPage();

        await waitFor(() => expect(cells().length).toBeGreaterThan(0));
        expect(cells()).toHaveLength(36);
    });

    it('includes the level-6 cell that the hardcoded grid silently dropped', async () => {
        // A risk at likelihood 6 / impact 6 was invisible before: its cell
        // was never drawn, so the count never appeared anywhere.
        mockFetch(
            matrixConfig({ likelihoodLevels: 6, impactLevels: 6, bandNames: ['Low', 'High'] }),
            [{ id: 'r1', title: 'Extreme', likelihood: 6, impact: 6, score: 36, inherentScore: 36, status: 'OPEN', treatment: null }],
        );
        renderPage();

        await waitFor(() => expect(cells().length).toBe(36));
        // The 6×6 cell carries the count of 1.
        const withCounts = cells().filter((c) => c.textContent?.trim() === '1');
        expect(withCounts).toHaveLength(1);
    });

    it('draws a 3×3 grid for a 3×3 tenant, without phantom cells', async () => {
        mockFetch(matrixConfig({
            likelihoodLevels: 3,
            impactLevels: 3,
            bandNames: ['Minor', 'Major'],
        }));
        renderPage();

        await waitFor(() => expect(cells().length).toBeGreaterThan(0));
        expect(cells()).toHaveLength(9);
    });

    it('tones RENAMED bands instead of falling through to grey', async () => {
        // The regression: none of these names is Low/Medium/High/Critical,
        // so the old `switch (band.name)` hit `default:` for every cell.
        mockFetch(matrixConfig({
            likelihoodLevels: 5,
            impactLevels: 5,
            bandNames: ['Tolerable', 'Elevated', 'Severe'],
        }));
        renderPage();

        await waitFor(() => expect(cells().length).toBe(25));

        const classes = cells().map((c) => c.className);
        // The lowest band tones success, the highest tones error — proof the
        // resolver keyed off ordinal position, not English band names.
        expect(classes.some((c) => c.includes('bg-bg-success'))).toBe(true);
        expect(classes.some((c) => c.includes('bg-bg-error'))).toBe(true);
        // And no cell is left on the muted fallback.
        expect(classes.every((c) => !c.includes('bg-bg-muted'))).toBe(true);
    });

    it('keeps the band name on each cell for the tooltip and tests', async () => {
        mockFetch(matrixConfig({
            likelihoodLevels: 4,
            impactLevels: 4,
            bandNames: ['Tolerable', 'Severe'],
        }));
        renderPage();

        await waitFor(() => expect(cells().length).toBe(16));
        const names = new Set(cells().map((c) => c.getAttribute('data-band')));
        expect(names).toEqual(new Set(['Tolerable', 'Severe']));
    });
});
