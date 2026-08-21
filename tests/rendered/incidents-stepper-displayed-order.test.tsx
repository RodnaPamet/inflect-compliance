/**
 * #107 end-to-end: a REAL list client publishes the order it rendered, and a
 * detail page's `useEntityListIds` walks that order.
 *
 * `tests/rendered/entity-list-ids-hook.test.tsx` proves the two halves of the
 * contract against synthetic rows. It cannot prove the part that actually
 * broke: that the seven list clients are WIRED to it. A hook nobody calls has
 * no bug — the stepper walked server order because no page ever told it what
 * it had displayed.
 *
 * So this test mounts the genuine `IncidentsClient`, with a filter applied
 * through the URL exactly as the toolbar applies one, and asserts the reader
 * answers with the rows on screen. Incidents is the sharpest fixture of the
 * seven: it filters ENTIRELY client-side under a stable cache key, so the
 * list cache holds rows the table is not showing, and a reader that fell back
 * to the cache would hand the stepper an incident the user filtered out.
 *
 * The mocked `useTenantSWR` deliberately answers every non-null key with the
 * FULL row set — that is the server order the pre-#107 reader returned, and
 * it is what these assertions go red against if the publish call is dropped
 * from `IncidentsClient`.
 */
import * as React from 'react';
import { render, screen, renderHook } from '@testing-library/react';
import { SWRConfig } from 'swr';

// next-intl is ESM (jest cannot parse it); resolve real en.json values.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        // Memoized per namespace: a fresh `t` each render would invalidate the
        // filter-def memo and re-render forever.
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
            return typeof v === 'string'
                ? v.replace(/<(\w+)>(.*?)<\/\1>/g, (_m: string, _tag: string, inner: string) => inner)
                : key;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/incidents',
    useSearchParams: () => new URLSearchParams(window.location.search),
}));

const mockUseTenantSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockUseTenantSWR(...args),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { IncidentsClient, type IncidentRow } from '@/app/t/[tenantSlug]/(app)/incidents/IncidentsClient';
import { useEntityListIds } from '@/lib/hooks/use-entity-list-ids';
import { CACHE_KEYS } from '@/lib/swr-keys';

function makeRow(id: string, reference: string, severity: IncidentRow['severity']): IncidentRow {
    return {
        id,
        reference,
        title: `Incident ${reference}`,
        severity,
        phase: 'CONTAINMENT',
        incidentType: 'OTHER',
        detectedAt: '2026-06-01T00:00:00.000Z',
        reportable: false,
        ownerUserId: null,
        createdAt: '2026-06-01T00:00:00.000Z',
        notifications: [],
    };
}

/**
 * Server order — what the list endpoint returned, and what the cache holds.
 *
 * The CRITICAL row sits in the MIDDLE on purpose: filtering to LOW then yields
 * a subset that is neither a prefix nor a suffix of the cache order, so an
 * assertion on the displayed order cannot accidentally hold for the cache
 * order too. An earlier draft of this file put it first, and the DOM-order
 * test below stayed green with the publish call deleted.
 */
const ROWS: IncidentRow[] = [
    makeRow('inc_1', 'INC-2026-001', 'LOW'),
    makeRow('inc_2', 'INC-2026-002', 'CRITICAL'),
    makeRow('inc_3', 'INC-2026-003', 'LOW'),
];

/**
 * One cache shared by the list mount and the detail mount — separate React
 * trees, exactly as list → detail navigation produces, but the same SWR cache.
 */
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

/** Apply a toolbar filter the way the toolbar does — through the URL. */
function withUrlFilter(search: string) {
    window.history.replaceState({}, '', `/t/acme/incidents${search}`);
}

beforeEach(() => {
    mockUseTenantSWR.mockReset();
    // Every non-null key answers with the FULL server-order list.
    mockUseTenantSWR.mockImplementation((key: unknown) => ({
        data: key == null ? undefined : ROWS,
        isLoading: false,
        error: null,
        mutate: jest.fn(),
    }));
    withUrlFilter('');
});

afterEach(() => withUrlFilter(''));

describe('IncidentsClient publishes the order it displayed', () => {
    it('hands the stepper only the filtered rows, in the rendered order', () => {
        const Wrapper = makeSharedCache();
        withUrlFilter('?severity=LOW');

        render(
            <Wrapper>
                <IncidentsClient initialIncidents={ROWS} tenantSlug="acme" canManage />
            </Wrapper>,
        );

        // The table shows the two LOW incidents and not the CRITICAL one.
        expect(screen.getByText('INC-2026-001')).toBeInTheDocument();
        expect(screen.getByText('INC-2026-003')).toBeInTheDocument();
        expect(screen.queryByText('INC-2026-002')).not.toBeInTheDocument();

        // The detail page — a separate mount over the same cache — steps
        // exactly those two. The cache still holds all three in server order,
        // so an unpublished reader answers ['inc_1','inc_2','inc_3'] here.
        const { result } = renderHook(() => useEntityListIds(CACHE_KEYS.incidents.list()), {
            wrapper: Wrapper,
        });
        expect(result.current).toEqual(['inc_1', 'inc_3']);
    });

    it('matches the row order actually in the DOM, not the cache order', () => {
        // Derived from the DOM rather than restated as a literal, so the
        // assertion is "what the stepper walks IS what is on screen" rather
        // than "both happen to equal a constant I typed twice".
        const Wrapper = makeSharedCache();
        withUrlFilter('?severity=LOW');

        const { container } = render(
            <Wrapper>
                <IncidentsClient initialIncidents={ROWS} tenantSlug="acme" canManage />
            </Wrapper>,
        );

        const rendered = Array.from(container.querySelectorAll('tbody tr'))
            .map((tr) => tr.textContent ?? '')
            .map((text) => ROWS.find((r) => text.includes(r.reference))?.id)
            .filter((id): id is string => Boolean(id));
        // The filter dropped one of the three — if this is 3, the filter did
        // not apply and the rest of the test proves nothing.
        expect(rendered).toHaveLength(2);

        const { result } = renderHook(() => useEntityListIds(CACHE_KEYS.incidents.list()), {
            wrapper: Wrapper,
        });
        expect(result.current).toEqual(rendered);
    });

    it('leaves the stepper empty when the list rendered nothing', () => {
        // A cold cache publishing nothing is the CORRECT semantic: stepping
        // "the order the list showed" is meaningless when there was no list.
        // `EntityPrevNextNav` hides itself on an empty `ids`.
        const Wrapper = makeSharedCache();
        mockUseTenantSWR.mockImplementation(() => ({
            data: [],
            isLoading: false,
            error: null,
            mutate: jest.fn(),
        }));
        render(
            <Wrapper>
                <IncidentsClient initialIncidents={[]} tenantSlug="acme" canManage />
            </Wrapper>,
        );
        const { result } = renderHook(() => useEntityListIds(CACHE_KEYS.incidents.list()), {
            wrapper: Wrapper,
        });
        expect(result.current).toEqual([]);
    });
});
