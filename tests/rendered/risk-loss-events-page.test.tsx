/**
 * Loss-events page — the predicted-vs-actual surface.
 *
 * Written to pay a debt. `risk-write-permission-gates` mounted this page for
 * the first time, which enrolled a 95-statement file in the coverage report at
 * whatever the permission assertions happened to touch, and that alone pushed
 * the global gate 0.04pp under its floor. Enrolling a file and leaving it
 * mostly unexecuted is a real cost, not a bookkeeping artefact: it means the
 * page's logic is running in production with nothing checking it.
 *
 * So these are the page's actual load-bearing behaviours:
 *
 *   - the rollup is honest about having no data (an empty aggregate must not
 *     render zeroed tiles, which read as "we measured, and it was zero");
 *   - the prediction line appears only when a simulation exists;
 *   - the calibration back-test — the reason this page exists — joins the
 *     sim's per-risk P50/P90 against recorded actuals, annualised over the
 *     observed loss window, and offers a re-estimate link ONLY where the
 *     forecast actually missed;
 *   - a mean-only forecast row (no real tail) is excluded rather than
 *     flagged as a miss;
 *   - record reports both outcomes and clears the draft only on success.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { SWRConfig } from 'swr';

const PERMS = { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true };

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme', permissions: PERMS }),
    usePermissions: () => ({}),
    useMoneyFormatter: () => (v: number | null | undefined) => (v == null ? '—' : `€${Math.round(v)}`),
    useCurrentUserId: () => 'u1',
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const resolve = (ns: string, key: string) =>
        key.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) for (const [p, val] of Object.entries(params)) s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return s;
        };
        t.rich = (key: string) => resolve(ns, key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/risks/loss-events',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import LossEventsPage from '@/app/t/[tenantSlug]/(app)/risks/loss-events/page';

const en = require('../../messages/en.json');
const L = en.risks.lossEvents;

type Bodies = { events?: unknown; aggregate?: unknown; run?: unknown };
let bodies: Bodies = {};
let writeOk = true;
const writes: string[] = [];

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method !== 'GET') {
            writes.push(`${method} ${url}`);
            const b = writeOk ? {} : { error: { code: 'internal', message: 'boom' } };
            return { ok: writeOk, status: writeOk ? 200 : 500, headers: new Headers({ 'content-type': 'application/json' }), json: async () => b, text: async () => JSON.stringify(b) } as unknown as Response;
        }
        let body: unknown = {};
        if (url.includes('/loss-events/aggregate')) body = bodies.aggregate ?? { total: 0, count: 0, byYear: [], byRisk: [] };
        else if (url.includes('/loss-events')) body = { events: bodies.events ?? [] };
        else if (url.includes('/risks/simulate')) body = { run: bodies.run ?? null };
        else if (url.includes('/risks/options')) body = { risks: [] };
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    }) as unknown as typeof fetch;
}

beforeEach(() => {
    bodies = {};
    writeOk = true;
    writes.length = 0;
    installFetch();
});

const mount = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider><LossEventsPage /></TooltipProvider>
        </SWRConfig>,
    );

describe('Loss events — the rollup only claims what it measured', () => {
    it('an empty aggregate renders the honest empty state, not zeroed tiles', async () => {
        mount();
        expect(await screen.findByTestId('loss-events-empty')).toHaveTextContent(L.emptyActuals);
        expect(screen.queryByTestId('loss-events-total')).not.toBeInTheDocument();
        expect(screen.queryByTestId('loss-events-by-year')).not.toBeInTheDocument();
    });

    it('a populated aggregate renders totals, count, calendar years and per-year bars', async () => {
        bodies.aggregate = {
            total: 30000, count: 4,
            byYear: [{ year: 2024, total: 10000, count: 1 }, { year: 2026, total: 20000, count: 3 }],
            byRisk: [],
        };
        mount();
        expect(await screen.findByTestId('loss-events-total')).toHaveTextContent('€30000');
        expect(screen.getByTestId('loss-events-count')).toHaveTextContent('4');
        // Two YEARS present, not the three-year span — the tile counts rows.
        expect(screen.getByTestId('loss-events-years')).toHaveTextContent('2');
        const byYear = screen.getByTestId('loss-events-by-year');
        expect(byYear).toHaveTextContent('2024');
        expect(byYear).toHaveTextContent('2026');
    });

    it('the prediction line appears only once a simulation exists', async () => {
        bodies.aggregate = { total: 1000, count: 1, byYear: [{ year: 2026, total: 1000, count: 1 }], byRisk: [] };
        const { unmount } = mount();
        await screen.findByTestId('loss-events-total');
        expect(screen.queryByTestId('loss-events-prediction-line')).not.toBeInTheDocument();
        unmount();

        bodies.run = { portfolioMean: 5000, portfolioP90: 12000, completedAt: '2026-01-01', perRiskResultsJson: [] };
        mount();
        expect(await screen.findByTestId('loss-events-prediction-line')).toHaveTextContent('€5000');
    });
});

describe('Loss events — the calibration back-test', () => {
    // One risk forecast with a real tail (p90 > mean) plus recorded actuals.
    const withTail = (over: Record<string, unknown> = {}) => ({
        portfolioMean: 1000, portfolioP90: 4000, completedAt: '2026-01-01',
        perRiskResultsJson: [
            { riskId: 'r1', title: 'Ransomware', aleMean: 1000, aleP50: 900, aleP90: 4000 },
            ...(over.extra as unknown[] ?? []),
        ],
    });

    it('is absent entirely when nothing can be scored', async () => {
        bodies.aggregate = { total: 100, count: 1, byYear: [{ year: 2026, total: 100, count: 1 }], byRisk: [] };
        bodies.run = { portfolioMean: 1, portfolioP90: 2, completedAt: null, perRiskResultsJson: [] };
        mount();
        await screen.findByTestId('loss-events-total');
        expect(screen.queryByTestId('loss-calibration')).not.toBeInTheDocument();
    });

    it('scores a risk inside its band and offers no re-estimate nudge', async () => {
        bodies.aggregate = {
            total: 1200, count: 1,
            byYear: [{ year: 2026, total: 1200, count: 1 }],
            byRisk: [{ riskId: 'r1', total: 1200, count: 1 }],
        };
        bodies.run = withTail();
        mount();
        const card = await screen.findByTestId('loss-calibration');
        expect(card).toBeInTheDocument();
        expect(screen.getByTestId('calibration-row-r1')).toHaveTextContent('Ransomware');
        // Within band → the page must NOT nag the owner to re-estimate.
        expect(screen.queryByTestId('calibration-reestimate-r1')).not.toBeInTheDocument();
    });

    it('a loss far above P90 is flagged and links to that risk\'s FAIR tab', async () => {
        bodies.aggregate = {
            total: 90000, count: 2,
            byYear: [{ year: 2026, total: 90000, count: 2 }],
            byRisk: [{ riskId: 'r1', total: 90000, count: 2 }],
        };
        bodies.run = withTail();
        mount();
        await screen.findByTestId('loss-calibration');
        const link = screen.getByTestId('calibration-reestimate-r1');
        // The nudge points at the quantification tab; it never rewrites inputs.
        expect(link.getAttribute('href')).toBe('/t/acme/risks/r1?tab=quantification');
    });

    it('annualises a multi-year total against the observed window', async () => {
        // 3600 spread over 2024..2026 is 1200/yr — inside the band. Treated as
        // one year it would read as a 3.6x over-run and flag falsely.
        bodies.aggregate = {
            total: 3600, count: 3,
            byYear: [
                { year: 2024, total: 1200, count: 1 },
                { year: 2025, total: 1200, count: 1 },
                { year: 2026, total: 1200, count: 1 },
            ],
            byRisk: [{ riskId: 'r1', total: 3600, count: 3 }],
        };
        bodies.run = withTail();
        mount();
        await screen.findByTestId('loss-calibration');
        expect(screen.queryByTestId('calibration-reestimate-r1')).not.toBeInTheDocument();
    });

    it('excludes a mean-only forecast row instead of scoring it', async () => {
        // aleP90 === aleMean → no distribution. The >200-risk sim fallback
        // produces these; scoring them would invent misses out of arithmetic.
        bodies.aggregate = {
            total: 5000, count: 1,
            byYear: [{ year: 2026, total: 5000, count: 1 }],
            byRisk: [{ riskId: 'r2', total: 5000, count: 1 }],
        };
        bodies.run = {
            portfolioMean: 1000, portfolioP90: 1000, completedAt: '2026-01-01',
            perRiskResultsJson: [{ riskId: 'r2', title: 'Flat', aleMean: 1000, aleP50: 1000, aleP90: 1000 }],
        };
        mount();
        await screen.findByTestId('loss-events-total');
        expect(screen.queryByTestId('calibration-row-r2')).not.toBeInTheDocument();
    });
});

describe('Loss events — recording', () => {
    it('a successful record confirms and clears the draft', async () => {
        mount();
        const amount = await screen.findByPlaceholderText(L.amountPlaceholder);
        fireEvent.change(amount, { target: { value: '2500' } });
        fireEvent.click(screen.getByRole('button', { name: L.record }));

        await screen.findByText(L.lossRecorded);
        expect(writes.some((w) => w.startsWith('POST') && w.includes('/loss-events'))).toBe(true);
        await waitFor(() => expect(screen.getByPlaceholderText(L.amountPlaceholder)).toHaveValue(''));
    });

    it('a failed record says so and keeps the amount', async () => {
        writeOk = false;
        mount();
        const amount = await screen.findByPlaceholderText(L.amountPlaceholder);
        fireEvent.change(amount, { target: { value: '2500' } });
        fireEvent.click(screen.getByRole('button', { name: L.record }));

        await screen.findByText(L.saveFailed);
        expect(screen.getByPlaceholderText(L.amountPlaceholder)).toHaveValue('2500');
    });

    it('a non-numeric amount never reaches the network', async () => {
        mount();
        const amount = await screen.findByPlaceholderText(L.amountPlaceholder);
        fireEvent.change(amount, { target: { value: 'not a number' } });
        fireEvent.click(screen.getByRole('button', { name: L.record }));
        await waitFor(() => expect(writes.filter((w) => w.startsWith('POST'))).toHaveLength(0));
    });

    it('a failed remove reports through the same surface as record', async () => {
        bodies.events = [{
            id: 'le1', riskId: null, occurredAt: '2026-01-02T00:00:00.000Z', amount: 400,
            description: 'Outage', source: 'USER', justification: null, createdByUserId: null,
            createdAt: '2026-01-02T00:00:00.000Z',
        }];
        writeOk = false;
        mount();
        fireEvent.click(await screen.findByRole('button', { name: L.remove }));
        await screen.findByText(L.saveFailed);
        expect(writes.some((w) => w.startsWith('DELETE'))).toBe(true);
    });
});
