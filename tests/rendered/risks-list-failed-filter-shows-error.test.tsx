/**
 * A filter change whose fetch fails must say so, not leave the previous
 * filter's rows and counts on screen (#4327).
 *
 * `useTenantSWR` keeps the previous key's data, so after a failed filtered
 * fetch `data` is the unfiltered answer. The Risks list never read the
 * query's error at all: the table, the matrix and the histogram went on
 * drawing the old risks under the new filter pills, and the KPI cards their
 * counts. The check is whether the current key has rows of its own, the same
 * test the Assets and Tasks lists use.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
    }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
    useMoneyFormatter: () => (v: number | null | undefined) => (v == null ? '' : String(v)),
    useModules: () => ({}),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string) => {
            const v = walk(walk(en, ns), key);
            return typeof v === 'string' ? v : key;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => {
    const searchParams = new URLSearchParams();
    const router = {
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/risks',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { RisksClient } from '@/app/t/[tenantSlug]/(app)/risks/RisksClient';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

type Props = React.ComponentProps<typeof RisksClient>;
type RiskRow = Props['initialRisks'][number];

const EN = require('../../messages/en.json');
const LOAD_ERROR: string = EN.risks.loadError;

const risk = (id: string, title: string, status: string): RiskRow => ({
    id,
    key: id.toUpperCase(),
    title,
    threat: 'Threat',
    likelihood: 3,
    impact: 4,
    inherentScore: 12,
    score: 12,
    treatment: null,
    status,
    controls: [],
});
const OPEN = risk('risk-1', 'Ransomware on the file server', 'OPEN');
const CLOSED = risk('risk-2', 'Expired vendor contract', 'CLOSED');
const ROWS = [OPEN, CLOSED];
const KPIS = { total: 2, open: 1, avgScore: 12 };

const json = (status: number, body: unknown) =>
    ({
        ok: status < 400,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    }) as unknown as Response;

/** Which list fetches fail: a filtered one (status set), or every one. */
let failWhen: (url: URL) => boolean = () => false;

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/risks');
    failWhen = (url) => url.searchParams.has('status');
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        if (url.pathname.endsWith('/risks')) {
            return failWhen(url)
                ? json(500, { error: { code: 'INTERNAL', message: 'boom', requestId: 'req-1' } })
                : json(200, { rows: ROWS, truncated: false, kpiCounts: KPIS });
        }
        return json(200, {});
    }) as unknown as typeof fetch;
});

const translations = new Proxy({} as Props['translations'], { get: (_t, key) => String(key) });

function mount() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TooltipProvider>
                <RisksClient
                    initialRisks={ROWS}
                    matrixConfig={DEFAULT_RISK_MATRIX_CONFIG}
                    tenantSlug="acme"
                    permissions={{ canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true }}
                    bulkPermissions={{ canEdit: true, canDelete: true }}
                    canCreate
                    translations={translations}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

/** The Open card applies a status filter, which the fetch then refuses. */
async function applyOpenFilter() {
    const card = await screen.findByRole('button', { name: /openRisks/ });
    await act(async () => {
        fireEvent.click(card);
    });
}

/** The figure a KPI card shows, found by its label. */
const cardValue = (label: string) => {
    const card = screen.getAllByTestId('kpi-filter-card').find((c) => c.textContent?.includes(label));
    if (!card) throw new Error(`no ${label} card`);
    return card.querySelector('[data-metric-value]')?.textContent ?? '';
};

const listCalls = () =>
    (global.fetch as jest.Mock).mock.calls
        .map(([u]) => new URL(String(u), 'https://test.local'))
        .filter((u) => u.pathname.endsWith('/risks'));

it('a filter whose fetch fails shows the load error, not the previous rows or counts', async () => {
    mount();
    await screen.findByText(CLOSED.title);
    // The cards read the server's counts before the filter is applied.
    await waitFor(() => expect(cardValue('avgScore')).toBe('12.0'));
    expect(cardValue('openRisks')).toBe('1');

    await applyOpenFilter();

    expect(await screen.findByText(LOAD_ERROR)).toBeTruthy();
    expect(listCalls().some((u) => u.searchParams.has('status'))).toBe(true);
    // Both risks belong to the unfiltered answer and must not stand in for
    // the filtered one.
    expect(screen.queryByText(CLOSED.title)).toBeNull();
    expect(screen.queryByText(OPEN.title)).toBeNull();
    // Nor may the cards show the unfiltered answer's figures.
    for (const label of ['totalRisks', 'avgScore', 'openRisks']) {
        expect(cardValue(label)).toBe('—');
    }
});

it('the histogram view shows the load error instead of drawing the previous risks', async () => {
    window.localStorage.setItem('inflect:risks-view:acme', JSON.stringify('histogram'));
    mount();
    await screen.findByTestId('risk-histogram-view');

    await applyOpenFilter();

    expect(await screen.findByText(LOAD_ERROR)).toBeTruthy();
    expect(screen.queryByTestId('risk-histogram-view')).toBeNull();
});

it('a failed refresh of a list that did load keeps its rows', async () => {
    failWhen = () => true;
    mount();
    await screen.findByText(CLOSED.title);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    // Let the failed revalidation settle.
    await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
    expect(screen.getByText(CLOSED.title)).toBeTruthy();
});
