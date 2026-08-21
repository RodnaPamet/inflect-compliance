/**
 * #99 — the Business Impact Analysis stepper walks the register's order.
 *
 * The BCM register is the case #107 was written for, in its purest form: the
 * rows are SERVER-rendered into the client as a prop and then filtered
 * ENTIRELY in the browser, so nothing outside `BusinessContinuityClient` can
 * know what the table is showing. A detail page that guessed from a list
 * endpoint would offer arrows to a BIA the user had filtered out of view.
 *
 * These assertions are on rendered behaviour: the arrows appear on the detail
 * page, the down arrow navigates to the BIA that is genuinely next in the DOM
 * order of the filtered table, and a BIA opened without the register on screen
 * gets no arrows.
 */
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

// Memoized `t` per namespace — a fresh one per render invalidates the filter-def
// memo in `BusinessContinuityClient` and the suite loops instead of failing.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
                }
            }
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v : key;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockReplace = jest.fn();
// `useParams` is not optional: `useDisplayedOrderKey` scopes the published
// order by the route's tenantSlug so tenant B never reads tenant A's order.
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: (...a: unknown[]) => mockReplace(...a),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/audits/business-continuity',
    useSearchParams: () => new URLSearchParams(window.location.search),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { BusinessContinuityClient, type BiaRow } from '@/app/t/[tenantSlug]/(app)/audits/business-continuity/BusinessContinuityClient';
import { BiaDetailClient, type BiaDetail } from '@/app/t/[tenantSlug]/(app)/audits/business-continuity/[id]/BiaDetailClient';

function makeRow(id: string, name: string, criticality: string, rank: number): BiaRow {
    return {
        id,
        name,
        criticality,
        rtoHours: 4,
        rpoHours: 1,
        mtpdHours: 24,
        reviewedAt: '2026-06-01T00:00:00.000Z',
        processNode: null,
        ownerUser: null,
        recovery: { rank, rationale: 'seeded' },
    };
}

/**
 * The MEDIUM row sits in the MIDDLE on purpose. Filtering to CRITICAL then
 * yields a subset that is neither a prefix nor a suffix of the full set, so an
 * assertion about the displayed order cannot accidentally hold for the
 * unfiltered order too.
 */
const ROWS: BiaRow[] = [
    makeRow('bia_1', 'Payments ledger', 'CRITICAL', 1),
    makeRow('bia_2', 'Marketing site', 'MEDIUM', 2),
    makeRow('bia_3', 'Customer support desk', 'CRITICAL', 3),
];

function makeDetail(row: BiaRow): BiaDetail {
    return {
        id: row.id,
        name: row.name,
        criticality: row.criticality,
        rtoHours: row.rtoHours,
        rpoHours: row.rpoHours,
        mtpdHours: row.mtpdHours,
        impactProfile: null,
        notes: null,
        reviewedAt: row.reviewedAt,
        processNode: null,
        ownerUser: null,
        dependencies: [],
        linkedControls: [],
        evidenceLinks: [],
        recovery: row.recovery,
    } as unknown as BiaDetail;
}

function makeSharedCache() {
    const cache = new Map();
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
                {children}
            </SWRConfig>
        );
    };
}

/** Apply a register filter the way the toolbar applies one — through the URL. */
function withUrlFilter(search: string) {
    window.history.replaceState({}, '', `/t/acme/audits/business-continuity${search}`);
}

beforeEach(() => {
    mockReplace.mockReset();
    withUrlFilter('');
});
afterEach(() => withUrlFilter(''));

describe('BIA stepper', () => {
    it('walks only the rows the filtered register displayed, in DOM order', () => {
        const Wrapper = makeSharedCache();
        withUrlFilter('?criticality=CRITICAL');

        const list = render(
            <Wrapper>
                <BusinessContinuityClient initialRows={ROWS} tenantSlug="acme" canWrite />
            </Wrapper>,
        );

        // Derive the displayed order from the DOM rather than restating it.
        const rendered = Array.from(list.container.querySelectorAll('tbody tr'))
            .map((tr) => tr.textContent ?? '')
            .map((text) => ROWS.find((r) => text.includes(r.name))?.id)
            .filter((id): id is string => Boolean(id));
        // If this is 3 the filter did not apply and the rest proves nothing.
        expect(rendered).toEqual(['bia_1', 'bia_3']);

        list.unmount();

        render(
            <Wrapper>
                <BiaDetailClient bia={makeDetail(ROWS[0])} tenantSlug="acme" />
            </Wrapper>,
        );

        expect(screen.getByTestId('entity-prev-next-nav')).toBeInTheDocument();
        // First of the filtered pair: no previous, next is the row that
        // followed it ON SCREEN — bia_3, NOT the unfiltered neighbour bia_2.
        expect(screen.getByTestId('entity-nav-prev')).toBeDisabled();
        fireEvent.click(screen.getByTestId('entity-nav-next'));
        expect(mockReplace).toHaveBeenCalledWith(
            `/t/acme/audits/business-continuity/${rendered[1]}`,
        );
        expect(mockReplace).not.toHaveBeenCalledWith(
            '/t/acme/audits/business-continuity/bia_2',
        );
    });

    it('shows no arrows for a BIA opened without the register on screen', () => {
        // The register is server-rendered, so there is no list cache entry to
        // fall back to and the reader uses a null `listKey` deliberately.
        const Wrapper = makeSharedCache();
        render(
            <Wrapper>
                <BiaDetailClient bia={makeDetail(ROWS[0])} tenantSlug="acme" />
            </Wrapper>,
        );
        expect(screen.queryByTestId('entity-prev-next-nav')).not.toBeInTheDocument();
    });
});
