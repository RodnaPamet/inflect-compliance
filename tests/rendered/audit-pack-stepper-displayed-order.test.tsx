/** @jest-environment jsdom */

/**
 * #97 — the prev/next stepper on an audit PACK, and the one production call
 * site of the `orderKey` + null-`listKey` axis #107 left open.
 *
 * Audit packs have NO list route. The only surface in the product that
 * renders a list of packs is the pack panel at the bottom of the CYCLE detail
 * page, so that is the publisher; the pack detail page reads
 * `useEntityListIds(null, { orderKey: CACHE_KEYS.audits.packs() })`.
 *
 * A null `listKey` means published-order-or-nothing. The second test pins
 * that: a pack opened by deep link, with a fully populated `/audits/packs`
 * cache entry sitting right there, still shows NO arrows and issues NO
 * fallback request. Falling back would be worse than nothing here — it would
 * offer to step through a list the user has never seen, in an order no
 * screen in the product displays.
 */

import * as React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: jest.fn(), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

// Memoised per namespace — the repo-wide next-intl mock hands back a fresh
// `t` per render, which makes page-level suites time out rather than fail.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            const str = typeof val === 'string' ? val : key;
            return params
                ? str.replace(/\{(\w+)\}/g, (m, n) =>
                    Object.prototype.hasOwnProperty.call(params, n) ? String(params[n]) : m)
                : str;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => lookup(ns, k) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
        useFormatter: () => ({
            dateTime: String, number: String, relativeTime: String,
            list: (l: string[]) => l.join(', '),
        }),
        NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
    };
});

// The published order is TENANT-scoped off the route params — a `useParams`
// missing `tenantSlug` puts publisher and reader on different cache keys.
const routeParams: { current: Record<string, string> } = {
    current: { tenantSlug: 'acme' },
};
const routerMock = {
    push: jest.fn(), replace: jest.fn(), back: jest.fn(),
    refresh: jest.fn(), prefetch: jest.fn(),
};
jest.mock('next/navigation', () => ({
    useParams: () => routeParams.current,
    useRouter: () => routerMock,
    usePathname: () => '/t/acme/audits/packs',
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

jest.mock('@/components/require-permission', () => ({
    RequirePermission: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { SWRConfig } from 'swr';
import CycleDetailPage from '@/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/page';
import PackDetailPage from '@/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page';
import { __setConfettiForTest } from '@/components/ui/hooks/use-celebration';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { getPermissionsForRole } from '@/lib/permissions';

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

/** The packs the cycle page paints, in the order it paints them. */
const PACKS = [
    { id: 'pack-1', name: 'Controls pack', status: 'DRAFT' },
    { id: 'pack-2', name: 'Policies pack', status: 'DRAFT' },
    { id: 'pack-3', name: 'Evidence pack', status: 'FROZEN' },
];

/**
 * What a hypothetical `GET /audits/packs` answers. Nothing in the product
 * reads it for a list view — it exists here purely so the null-`listKey`
 * test can prove the reader does NOT reach for it. Reversed so a fallback
 * would produce visibly wrong neighbours rather than accidentally-right ones.
 */
const PACKS_ENDPOINT_ORDER = [...PACKS].reverse();

const CYCLE = {
    id: 'cyc-1',
    name: 'FY26 ISO cycle',
    frameworkKey: 'ISO27001',
    frameworkVersion: '2022',
    status: 'PLANNING',
    audits: [] as unknown[],
    packs: PACKS,
};

function packDetail(id: string) {
    const row = PACKS.find((p) => p.id === id);
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        status: row.status,
        frozenAt: null,
        frozenBy: null,
        cycle: { id: 'cyc-1', name: CYCLE.name, frameworkKey: 'ISO27001' },
        items: [] as unknown[],
        _count: { items: 0, shares: 0 },
    };
}

const fetchMock = jest.fn();
/** Every URL the suite's fetch stub was asked for, for the no-fallback test. */
let requested: string[] = [];

beforeEach(() => {
    // jsdom has no canvas — the pack page's celebration hook would throw.
    __setConfettiForTest(() => Promise.resolve(null));
    routeParams.current = { tenantSlug: 'acme' };
    routerMock.replace.mockReset();
    routerMock.push.mockReset();
    requested = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        requested.push(u);
        const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
        if (u.includes('action=default-pack-preview')) return ok(null);
        if (/\/audits\/packs\/([\w-]+)\/share-comments$/.test(u)) return ok({ comments: [], openCount: 0 });
        if (/\/audits\/packs\/([\w-]+)\/shares$/.test(u)) return ok([]);
        const pack = /\/audits\/packs\/([\w-]+)$/.exec(u);
        if (pack) return ok(packDetail(pack[1]));
        if (u.endsWith('/audits/packs')) return ok(PACKS_ENDPOINT_ORDER);
        if (/\/audits\/cycles\/([\w-]+)$/.test(u)) return ok(CYCLE);
        if (u.endsWith('/audits/cycles')) return ok([]);
        return ok(null);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

function makeWrapper() {
    const cache = new Map();
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
                <TenantProvider value={TENANT_CTX}>
                    <KeyboardShortcutProvider>
                        <TooltipProvider>{children}</TooltipProvider>
                    </KeyboardShortcutProvider>
                </TenantProvider>
            </SWRConfig>
        );
    };
}

async function flush(times = 6) {
    await act(async () => {
        for (let i = 0; i < times; i++) await Promise.resolve();
    });
}

/** Mount the CYCLE page and read back the pack ids it painted, in DOM order. */
async function renderCycleAndReadPackOrder(
    Wrapper: React.ComponentType<{ children: React.ReactNode }>,
) {
    routeParams.current = { tenantSlug: 'acme', cycleId: 'cyc-1' };
    const view = render(<Wrapper><CycleDetailPage /></Wrapper>);
    await waitFor(() => {
        expect(view.container.querySelector('[id^="pack-link-"]')).not.toBeNull();
    });
    await flush();
    const order = Array.from(view.container.querySelectorAll('[id^="pack-link-"]')).map((el) =>
        el.id.replace('pack-link-', ''),
    );
    return { view, order };
}

async function renderPackDetail(
    Wrapper: React.ComponentType<{ children: React.ReactNode }>,
    packId: string,
) {
    routeParams.current = { tenantSlug: 'acme', packId };
    const view = render(<Wrapper><PackDetailPage /></Wrapper>);
    await waitFor(() => {
        expect(view.container.querySelector('#pack-name')).not.toBeNull();
    });
    await flush();
    return view;
}

describe('audit pack stepper reads the order the cycle page displayed', () => {
    it('steps to the packs either side of the one the cycle page painted', async () => {
        const Wrapper = makeWrapper();
        const { view: cyclePage, order } = await renderCycleAndReadPackOrder(Wrapper);
        expect(order).toEqual(['pack-1', 'pack-2', 'pack-3']);
        // Fixture guard: a fallback read would give the opposite neighbours.
        expect(PACKS_ENDPOINT_ORDER.map((p) => p.id)).not.toEqual(order);
        cyclePage.unmount();

        const detail = await renderPackDetail(Wrapper, 'pack-2');
        expect(detail.container.querySelector('[data-testid="entity-prev-next-nav"]')).not.toBeNull();

        const prev = detail.container.querySelector('[data-testid="entity-nav-prev"]') as HTMLButtonElement;
        const next = detail.container.querySelector('[data-testid="entity-nav-next"]') as HTMLButtonElement;
        // The `pack` phrase from the catalog, not the generic `item` fallback.
        expect(prev.getAttribute('aria-label')).toBe('Previous pack');
        expect(next.getAttribute('aria-label')).toBe('Next pack');

        const at = order.indexOf('pack-2');
        act(() => { fireEvent.click(next); });
        expect(routerMock.replace).toHaveBeenCalledWith(`/t/acme/audits/packs/${order[at + 1]}`);

        act(() => { fireEvent.click(prev); });
        expect(routerMock.replace).toHaveBeenLastCalledWith(`/t/acme/audits/packs/${order[at - 1]}`);
    });

    it('shows no arrows, and reads no list, on a pack opened without its cycle', async () => {
        const Wrapper = makeWrapper();
        const detail = await renderPackDetail(Wrapper, 'pack-2');
        // The page itself rendered — this is not a "nothing mounted" pass.
        expect(detail.container.querySelector('#pack-name')?.textContent).toBe('Policies pack');
        expect(detail.container.querySelector('[data-testid="entity-prev-next-nav"]')).toBeNull();
        // …and no fallback request went out for a pack LIST. `/audits/packs/<id>`
        // (the pack itself) is expected; a bare `/audits/packs` is not.
        expect(requested.some((u) => u.endsWith('/audits/packs'))).toBe(false);
    });

    it('disables the far end at the ends of the published order', async () => {
        const Wrapper = makeWrapper();
        const { view: cyclePage, order } = await renderCycleAndReadPackOrder(Wrapper);
        cyclePage.unmount();

        const detail = await renderPackDetail(Wrapper, order[order.length - 1]);
        const prev = detail.container.querySelector('[data-testid="entity-nav-prev"]') as HTMLButtonElement;
        const next = detail.container.querySelector('[data-testid="entity-nav-next"]') as HTMLButtonElement;
        expect(next.disabled).toBe(true);
        expect(prev.disabled).toBe(false);
        act(() => { fireEvent.click(next); });
        expect(routerMock.replace).not.toHaveBeenCalled();
    });
});
