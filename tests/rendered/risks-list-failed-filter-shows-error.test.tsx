/**
 * A filter change whose fetch fails must SAY so, not leave the previous
 * filter's rows on screen (#4327).
 *
 * `useTenantSWR` runs with `keepPreviousData`, so after a failed filtered
 * fetch `data` is still the earlier key's answer and `risksQuery.error` was
 * never read at all: the table went on showing those rows, and the KPI counts
 * above them, under the new filter pills.
 *
 * The same defect #4317 fixed on Tasks and #4291 on Assets, and the same
 * remedy — so this suite is deliberately the shape of
 * `tasks-list-failed-filter-shows-error.test.tsx`.
 *
 * BOTH DIRECTIONS ARE TESTED, and the second is the one with teeth. Showing an
 * error whenever `error` is set would be easy and wrong: a failed BACKGROUND
 * refresh of a key that already loaded must keep its readable table rather
 * than blare over it. That is what `currentKeyHasRows` decides, and a test for
 * only the first case would pass against `risksQuery.error ? … : undefined`.
 */
import * as React from 'react';
import { configure, render, screen } from '@testing-library/react';
import { SWRConfig, type Cache } from 'swr';

jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useMoneyFormatter: () => (n: number) => `$${n}`,
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
    useSearchParams: () => new URLSearchParams(window.location.search),
    usePathname: () => window.location.pathname,
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { RisksClient } from '@/app/t/[tenantSlug]/(app)/risks/RisksClient';

const en = require('../../messages/en.json');

/**
 * Built FROM the catalogue rather than hand-typed. `translations` carries ~22
 * keys and a hand-written copy would drift from `messages/en.json` silently,
 * which is the one thing a test of i18n-adjacent behaviour must not do.
 */
const TRANSLATIONS = Object.fromEntries(
    [
        'title', 'listDescription', 'risksIdentified', 'heatmap', 'histogram', 'register',
        'addRisk', 'riskTitle', 'asset', 'threat', 'score', 'level', 'treatment',
        'controlsCol', 'noRisks', 'low', 'medium', 'high', 'critical', 'untreated',
        'heatmapTitle', 'totalRisks', 'avgScore', 'openRisks', 'overdueReviews',
    ].map((k) => [k, typeof en.risks[k] === 'string' ? en.risks[k] : k]),
) as React.ComponentProps<typeof RisksClient>['translations'];

const MATRIX_CONFIG = {
    likelihoodLabels: ['1', '2', '3', '4', '5'],
    impactLabels: ['1', '2', '3', '4', '5'],
    thresholds: { low: 4, medium: 9, high: 16 },
} as unknown as React.ComponentProps<typeof RisksClient>['matrixConfig'];

type RiskRow = React.ComponentProps<typeof RisksClient>['initialRisks'][number];
const RISK_TITLE = 'Edge proxy left unpatched';
const ROWS = [
    {
        id: 'risk-a',
        title: RISK_TITLE,
        status: 'OPEN',
        impact: 3,
        likelihood: 3,
        score: 9,
        treatment: 'MITIGATE',
        ownerUserId: null,
        owner: null,
        asset: null,
        threat: null,
        category: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
    } as unknown as RiskRow,
];

const PERMISSIONS = {
    canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true,
};
const FILTERED_LIST_URL = '/api/t/acme/risks?status=OPEN';

// SWR's `provider` wants its own `Cache`, and a `Map` satisfies it at runtime
// (which is what the sibling Tasks suite relies on by leaving `new Map()`
// un-annotated). The cast is at the seam rather than widening the map's own
// type, so the primed entry below stays checked.
function renderPage(cache: Map<string, { data: unknown }>) {
    return render(
        <SWRConfig value={{ provider: () => cache as unknown as Cache, dedupingInterval: 0, shouldRetryOnError: false }}>
            <TooltipProvider>
                <RisksClient
                    initialRisks={ROWS}
                    matrixConfig={MATRIX_CONFIG}
                    tenantSlug="acme"
                    permissions={PERMISSIONS}
                    bulkPermissions={{ canEdit: true, canDelete: false }}
                    canCreate
                    translations={TRANSLATIONS}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

beforeEach(() => {
    window.localStorage.clear();
    // A FILTERED url the server did not render: `initialFilters` is absent, so
    // the SSR rows belong to the unfiltered key and `filtersMatchInitial` is
    // false. That is the live shape of "the user changed a filter".
    window.history.replaceState({}, '', '/t/acme/risks?status=OPEN');
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        const failed = url.pathname.endsWith('/risks') && url.searchParams.has('status');
        const body = failed ? { error: { code: 'INTERNAL', message: 'boom' } } : { rows: ROWS, truncated: false };
        return {
            ok: !failed,
            status: failed ? 500 : 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
});

it('a filtered load that fails shows the error instead of the unfiltered rows', async () => {
    renderPage(new Map());

    expect(await screen.findByText(en.risks.loadError)).toBeTruthy();
    // The SSR rows answer the UNFILTERED key and must not stand in for the
    // filtered one.
    expect(screen.queryAllByText(RISK_TITLE)).toHaveLength(0);
});

it('a failed refresh of a key that DID load keeps its table, with no error', async () => {
    // The same failing fetch, but this key already has rows of its own in the
    // cache. `currentKeyHasRows` is true, so the stale-but-readable table
    // stands. Without that term this case would show the error too.
    renderPage(new Map([[FILTERED_LIST_URL, { data: { rows: ROWS, truncated: false } }]]));

    expect(await screen.findByText(RISK_TITLE)).toBeTruthy();
    expect(screen.queryAllByText(en.risks.loadError)).toHaveLength(0);
});
