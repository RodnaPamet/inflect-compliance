/** @jest-environment jsdom */

/**
 * The reconciliation queue's two facets actually filter (#3358).
 *
 * WHY THIS SUITE EXISTS RATHER THAN TRUSTING THE COVERAGE GUARD.
 * `filter-toolbar-coverage` claims to check that a page mounting `<DataTable>`
 * also mounts `<FilterToolbar>`. It checks whether the file CONTAINS the
 * string — so deleting the mount and keeping the import leaves it green. I
 * proved that by mutation while wiring this page, and filed it as #4356. So the
 * guard cannot tell this page from one that imports the toolbar and renders
 * nothing, and the only honest proof that the facets work is to drive them.
 *
 * Both facets are closed unions on `WireRow`, which is why the fixture carries
 * one row per combination worth distinguishing rather than a realistic queue.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

// STABLE REFERENCES, and this is the second time it mattered here. The page's
// `load` is a `useCallback` over `apiUrl`, and its effect depends on `load` — so
// a mock returning a fresh arrow per render changes `apiUrl`'s identity, remakes
// `load`, re-fires the effect, sets state and goes round again. The probe that
// found it showed `executions`/`queue` fetched in an unbroken cycle. Real
// `useTenantApiUrl` returns a stable callback; the mock was the defect, exactly
// as the memoised translator below was.
const API_URL = (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`;
const TENANT_HREF = (p: string) => `/t/acme${p}`;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => API_URL,
    useTenantHref: () => TENANT_HREF,
}));

jest.mock('next/navigation', () => ({
    useParams: () => ({ connectionId: 'conn-1', tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
    useSearchParams: () => new URLSearchParams(window.location.search),
    usePathname: () => window.location.pathname,
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
            if (params) for (const [p, val] of Object.entries(params)) s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        return t;
    };
    // MEMOISED PER NAMESPACE, deliberately. A mock that hands back a fresh `t`
    // per call makes every `useMemo(..., [t])` in the page under test miss, and
    // this page memoises its filter defs on `t` — so an unmemoised mock rebuilt
    // the defs every render and the mount never settled. Real `next-intl`
    // returns a stable translator; the page is fine and the mock was the defect.
    // `tests/rendered/i18n-kept-primitives.test.tsx` carries the same note.
    const cache = new Map<string, ReturnType<typeof make>>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns)!;
        },
        useLocale: () => 'en',
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import ReconciliationQueuePage from '@/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/reconciliation/page';

const en = require('../../messages/en.json');
const L = en.admin.integrations.legacyQueue;

/** One row per (outcome, reason) pair the facets must be able to separate. */
const ROWS = [
    { accountKey: 'acct-suggested', outcome: 'SUGGESTED', reason: 'UNDECIDED', candidates: [], expiredAt: null },
    { accountKey: 'acct-ambiguous', outcome: 'AMBIGUOUS', reason: 'UNDECIDED', candidates: [], expiredAt: null },
    {
        accountKey: 'acct-expired',
        outcome: 'UNMATCHED',
        reason: 'EXTERNAL_EXPIRED',
        candidates: [],
        expiredAt: '2026-01-01T00:00:00.000Z',
    },
];

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/admin/integrations/conn-1/reconciliation');
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        const body = url.pathname.endsWith('/executions')
            ? {
                  executions: [
                      { id: 'exec-1', automationKey: 'legacy-mcp.reconcile', status: 'PASSED', executedAt: '2026-02-01T00:00:00.000Z' },
                  ],
              }
            : url.pathname.endsWith('/queue')
              ? { rows: ROWS }
              : {};
        return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
});

/**
 * Open the Filter popover, choose the FACET, then tick a value.
 *
 * Two steps, because the picker is two levels: the first list is the facets
 * ("Engine outcome", "Why it is here") and only after choosing one does it
 * offer that facet's values. Going straight for the value fails with
 * `Unable to find role="option"` — which is how I learned the shape.
 */
async function pick(facetLabel: string, optionLabel: string) {
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: en.common.ui.filter }));
    });
    const facet = await screen.findByRole('option', { name: new RegExp(`^${facetLabel}`) });
    await act(async () => {
        fireEvent.click(facet);
    });
    const option = await screen.findByRole('option', { name: new RegExp(optionLabel) });
    await act(async () => {
        fireEvent.click(option);
    });
}

it('loads every row, then narrows to the picked engine outcome', async () => {
    render(<ReconciliationQueuePage />);

    // The unfiltered queue — the positive control for the assertions below.
    await screen.findByText('acct-suggested');
    expect(screen.getByText('acct-ambiguous')).toBeTruthy();
    expect(screen.getByText('acct-expired')).toBeTruthy();

    await pick(L.colOutcome, L.outcomeAMBIGUOUS);

    await waitFor(() => expect(screen.queryByText('acct-suggested')).toBeNull());
    expect(screen.getByText('acct-ambiguous')).toBeTruthy();
    expect(screen.queryByText('acct-expired')).toBeNull();
});

it('narrows on the reason facet too, using its date-free chip label', async () => {
    // The COLUMN label for this reason interpolates a date; the chip cannot, so
    // it has its own key. Picking by that label is what proves the key is wired
    // rather than falling back to the raw key name.
    render(<ReconciliationQueuePage />);
    await screen.findByText('acct-expired');

    await pick(L.colReason, L.filterReasonEXTERNAL_EXPIRED);

    await waitFor(() => expect(screen.queryByText('acct-suggested')).toBeNull());
    expect(screen.queryByText('acct-ambiguous')).toBeNull();
    expect(screen.getByText('acct-expired')).toBeTruthy();
});

it('reports the FILTERED count in the subtitle, not the loaded one', async () => {
    // A count that kept reporting the unfiltered total would read as the filter
    // having done nothing.
    render(<ReconciliationQueuePage />);
    await screen.findByText('acct-suggested');
    expect(screen.getByText(L.subtitle.replace('{count}', '3'))).toBeTruthy();

    await pick(L.colOutcome, L.outcomeAMBIGUOUS);

    await waitFor(() => expect(screen.getByText(L.subtitle.replace('{count}', '1'))).toBeTruthy());
});
