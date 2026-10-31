/**
 * RQ3-10 — RiskBoardPage rendered tests.
 *
 * Locks the five-section contract + the honest-null empty states:
 *
 *   - Position headlines portfolioP80 when a simulation exists;
 *     otherwise renders the "not quantified yet" nudge, not a 0.
 *   - Appetite renders the typed chip with the threshold;
 *     "NONE" status surfaces the empty-state copy.
 *   - Top contributors top-5 only; empty state when no quantified
 *     risk in topByAle.
 *   - Best-value list reads from `/controls/best-value`; honest
 *     empty state when no control qualifies.
 *   - Hygiene line: "X of Y carry a stale assessment (Z%)";
 *     "every assessment is current" when staleCount=0 and total>0.
 */
import { render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { SWRConfig } from 'swr';

// The tenant context the page reads. `permissions` + `appPermissions` decide
// whether the empty register offers Create (`riskCanCreate`); a test swaps
// in a Reader's to check the button goes away.
const mockRoleContext = (role: 'ADMIN' | 'READER') => ({
    tenantName: 'Acme',
    tenantSlug: 'acme',
    currencySymbol: '€',
    membershipRole: role,
    permissions: {
        canRead: true,
        canWrite: role === 'ADMIN',
        canAdmin: role === 'ADMIN',
        canAudit: false,
        canExport: true,
    },
    appPermissions: jest.requireActual('@/lib/permissions').getPermissionsForRole(role),
});
let mockTenant: ReturnType<typeof mockRoleContext> | null = null;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => mockTenant ?? mockRoleContext('ADMIN'),
    useMoneyFormatter: () => (v: number | null | undefined) =>
        jest.requireActual('@/lib/risk-coherence').formatCompactCurrency(v),
}));
// next-intl is ESM — mock it, resolving real en.json values (with
// {param} interpolation + t.rich tag rendering) so the board's copy +
// the board-hygiene-pct span (which lives inside a t.rich tag) render.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const React = require('react');
    const resolve = (ns: string, key: string) =>
        key.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const sub = (v: string, params?: Record<string, unknown>) => {
        let s = v;
        if (params) for (const [p, val] of Object.entries(params)) if (typeof val !== 'function') s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
        return s;
    };
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? sub(v, params) : key;
        };
        t.rich = (key: string, params?: Record<string, unknown>) => {
            const v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            const s = sub(v, params);
            const nodes: React.ReactNode[] = [];
            const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
            let last = 0, m: RegExpExecArray | null, i = 0;
            while ((m = re.exec(s))) {
                if (m.index > last) nodes.push(s.slice(last, m.index));
                const fn = params?.[m[1]] as ((c: React.ReactNode) => React.ReactElement) | undefined;
                nodes.push(fn ? React.cloneElement(fn(m[2]), { key: i++ }) : m[2]);
                last = re.lastIndex;
            }
            if (last < s.length) nodes.push(s.slice(last));
            return nodes;
        };
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

import { TooltipProvider } from '@/components/ui/tooltip';
import RiskBoardPage from '@/app/t/[tenantSlug]/(app)/risks/board/page';

const renderPage = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider delayDuration={0}>
                <RiskBoardPage />
            </TooltipProvider>
        </SWRConfig>,
    );

const MATRIX = {
    likelihoodLevels: 5,
    impactLevels: 5,
    axisLikelihoodLabel: 'Likelihood',
    axisImpactLabel: 'Impact',
    levelLabels: { likelihood: ['1', '2', '3', '4', '5'], impact: ['1', '2', '3', '4', '5'] },
    bands: [{ name: 'Low', minScore: 1, maxScore: 25, color: '#22c55e' }],
};

const ANALYTICS = {
    totals: { totalCount: 7, quantifiedCount: 3, totalAle: 300_000, avgAle: 100_000, maxAle: 200_000 },
    topByAle: [
        { id: 'r1', title: 'Vendor outage', category: 'Operational', sleAmount: 0, aroAmount: 0, ale: 200_000 },
        { id: 'r2', title: 'Phishing', category: 'Security', sleAmount: 0, aroAmount: 0, ale: 60_000 },
        { id: 'r3', title: 'Data breach', category: 'Security', sleAmount: 0, aroAmount: 0, ale: 40_000 },
    ],
    byCategory: [{ category: 'Operational', count: 3, totalAle: 200_000 }],
};

const SIM_RUN = {
    portfolioMean: 380_000, portfolioP50: 350_000, portfolioP80: 540_000,
    portfolioP90: 720_000, portfolioP95: 840_000, portfolioP99: 1_200_000,
    portfolioStdDev: 180_000, iterations: 10_000, executionMs: 42,
    completedAt: '2026-06-12T00:00:00.000Z',
    lecPointsJson: null,
    perRiskResultsJson: [{ riskId: 'r1', title: 'Vendor outage', aleMean: 200_000, aleP90: 800_000, contribution: 0.6 }],
};

// `??` returns RHS when LHS is null OR undefined — which means
// `opts.simulation ?? SIM_RUN` would coerce an explicit `null` to
// SIM_RUN. We need an explicit `'simulation' in opts` check so a
// caller can opt OUT (override to null) without losing the default.
function pick<T>(opts: Record<string, unknown>, key: string, fallback: T): T | null {
    return key in opts ? (opts[key] as T | null) : fallback;
}

function mockFetch(opts: {
    simulation?: unknown;
    appetite?: unknown;
    analytics?: unknown;
    staleness?: unknown;
    bestValue?: unknown;
    failDashboard?: boolean;
    failBestValue?: boolean;
} = {}) {
    const failed = {
        ok: false, status: 500, headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: { code: 'INTERNAL', message: 'boom' } }), text: async () => '',
    } as unknown as Response;
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.endsWith('/risks/dashboard') && opts.failDashboard) return failed;
        if (u.includes('/controls/best-value') && opts.failBestValue) return failed;
        if (u.endsWith('/risks/dashboard')) {
            return {
                ok: true,
                json: async () => ({
                    risks: Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, status: 'OPEN', likelihood: 3, impact: 3 })),
                    analytics: pick(opts, 'analytics', ANALYTICS),
                    coherence: null,
                    staleness: pick(opts, 'staleness', { staleRisks: [], staleCount: 2, totalCount: 7, maxAssessmentAgeDays: 180 }),
                    appetite: pick(opts, 'appetite', null),
                    simulation: pick(opts, 'simulation', SIM_RUN),
                    matrix: MATRIX,
                }),
            } as Response;
        }
        if (u.includes('/controls/best-value')) {
            return {
                ok: true,
                json: async () =>
                    pick(opts, 'bestValue', [
                        {
                            controlId: 'c-1', code: 'AC-1', name: 'MFA',
                            annualCost: 10_000, effectiveness: 50,
                            aleProtected: 80_000, roiMultiple: 8, quantifiedRiskCount: 2, linkedRiskCount: 3,
                        },
                    ]),
            } as Response;
        }
        return { ok: false, json: async () => null } as Response;
    }) as unknown as typeof fetch;
}

describe('RiskBoardPage — five-section board view', () => {
    afterEach(() => {
        jest.clearAllMocks();
        mockTenant = null;
    });

    it('renders all five board cards with their headlines', async () => {
        mockFetch({
            appetite: {
                config: { totalAleThreshold: 600_000, singleRiskAleMax: null },
                status: { status: 'WITHIN', portfolioAle: 380_000, activeBreaches: 0, portfolioTested: null },
            },
        });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('board-position-card')).toBeInTheDocument());
        // Position headlines portfolioP80.
        expect(screen.getByTestId('board-position-card').textContent).toMatch(/€540K/);
        // Appetite chip + ceiling.
        expect(screen.getByTestId('board-appetite-chip').textContent).toBe('Within appetite');
        expect(screen.getByTestId('board-appetite-card').textContent).toMatch(/€600K/);
        // Top contributors lists 3 quantified risks, all linked.
        expect(screen.getAllByTestId(/board-top-risk-r/).length).toBe(3);
        expect(screen.getByTestId('board-top-risk-r1').textContent).toMatch(/€200K/);
        // Best-value leaderboard.
        expect(screen.getByTestId('board-best-value-row-c-1').textContent).toMatch(/8\.0×/);
        // Hygiene line: 2 of 7 = 29%.
        expect(screen.getByTestId('board-hygiene-pct').textContent).toBe('29%');
    });

    it('Position renders the honest "not quantified yet" nudge when no simulation', async () => {
        mockFetch({ simulation: null });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('board-position-card')).toBeInTheDocument());
        expect(screen.getByTestId('board-position-empty').textContent).toMatch(/Not quantified yet/);
        expect(screen.getByTestId('board-position-card').textContent).not.toMatch(/€0/);
    });

    it('Appetite renders the "no appetite set" empty state when status is NONE', async () => {
        mockFetch();
        renderPage();
        await waitFor(() => expect(screen.getByTestId('board-appetite-card')).toBeInTheDocument());
        expect(screen.getByTestId('board-appetite-chip').textContent).toBe('No appetite set');
        expect(screen.getByTestId('board-appetite-empty').textContent).toMatch(/Set a portfolio loss ceiling/);
    });

    it('Top contributors renders the empty state when no risk is quantified', async () => {
        mockFetch({
            analytics: { ...ANALYTICS, topByAle: [] },
        });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('board-top-risks-card')).toBeInTheDocument());
        expect(screen.getByTestId('board-top-risks-empty').textContent).toMatch(/No quantified risks yet/);
    });

    it('Best-value renders the empty state when no control qualifies (no synthetic zeros)', async () => {
        mockFetch({ bestValue: [] });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('board-best-value-card')).toBeInTheDocument());
        expect(screen.getByTestId('board-best-value-empty').textContent).toMatch(/No control yet carries a price/);
    });

    it('Hygiene shows the all-fresh affordance when staleCount is 0', async () => {
        mockFetch({
            staleness: { staleRisks: [], staleCount: 0, totalCount: 7, maxAssessmentAgeDays: 180 },
        });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('board-hygiene-all-fresh')).toBeInTheDocument());
        expect(screen.getByTestId('board-hygiene-pct').textContent).toBe('0%');
    });
});

describe('RiskBoardPage — the empty register offers Create only to a user who can create', () => {
    afterEach(() => {
        jest.clearAllMocks();
        mockTenant = null;
    });

    const EMPTY = { staleness: { staleRisks: [], staleCount: 0, totalCount: 0, maxAssessmentAgeDays: 180 } };

    it('an Admin gets the Create button', async () => {
        mockTenant = mockRoleContext('ADMIN');
        mockFetch(EMPTY);
        renderPage();
        await waitFor(() => expect(screen.getByTestId('risk-first-run-empty')).toBeInTheDocument());
        expect(screen.getByTestId('risk-first-run-cta')).toBeInTheDocument();
    });

    it('a Reader, whom the create route refuses, gets none', async () => {
        mockTenant = mockRoleContext('READER');
        mockFetch(EMPTY);
        renderPage();
        await waitFor(() => expect(screen.getByTestId('risk-first-run-empty')).toBeInTheDocument());
        expect(screen.queryByTestId('risk-first-run-cta')).toBeNull();
    });
});

describe('RiskBoardPage — failures and the appetite it measures against (#4767)', () => {
    afterEach(() => {
        jest.clearAllMocks();
        mockTenant = null;
    });

    it('a failed read shows an error with a retry, not a skeleton for ever', async () => {
        mockFetch({ failDashboard: true });
        renderPage();
        expect(await screen.findByTestId('board-load-error')).toHaveTextContent("Couldn't load the board");
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('a failed best-value read is an error, not "nothing qualifies"', async () => {
        mockFetch({ failBestValue: true });
        renderPage();
        expect(await screen.findByTestId('board-best-value-error')).toBeInTheDocument();
        expect(screen.queryByTestId('board-best-value-empty')).toBeNull();
    });

    it('with no appetite set, the headline is neutral, not green', async () => {
        mockFetch();
        renderPage();
        await screen.findByTestId('board-appetite-empty');
        const value = screen.getByTestId('board-position-card').querySelector('[data-metric-value]');
        expect(value).not.toHaveClass('text-content-success');
        expect(value).toHaveClass('text-content-emphasis');
    });

    it('an Admin is linked to the appetite page; a Reader is told who sets it', async () => {
        mockTenant = mockRoleContext('ADMIN');
        mockFetch();
        const { unmount } = renderPage();
        expect(await screen.findByRole('link', { name: 'Set risk appetite' })).toHaveAttribute('href', '/t/acme/admin/risk-appetite');
        unmount();

        mockTenant = mockRoleContext('READER');
        mockFetch();
        renderPage();
        expect(await screen.findByTestId('board-appetite-who')).toHaveTextContent('An Owner or Admin sets the ceiling.');
        expect(screen.queryByRole('link', { name: 'Set risk appetite' })).toBeNull();
    });

    it('a top contributor opens its Quantification tab', async () => {
        mockFetch();
        renderPage();
        const row = await screen.findByTestId('board-top-risk-r1');
        expect(row.querySelector('a')).toHaveAttribute('href', '/t/acme/risks/r1?tab=quantification');
    });
});
