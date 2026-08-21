/** @jest-environment jsdom */

/**
 * #97 — the prev/next stepper on an audit CYCLE, end to end.
 *
 * The two halves of the #107 contract, mounted as real pages:
 *
 *   • `audits/cycles/page.tsx` publishes the cycle order it rendered.
 *   • `audits/cycles/[cycleId]/page.tsx` steps that order.
 *
 * Why this is not the usual list/detail pair, and why a structural test
 * would have missed it: the cycles list does NOT read `/audits/cycles`. It
 * reads `/audits/readiness/overview` — the cycle list joined with per-cycle
 * readiness scores — while the stepper's key is `CACHE_KEYS.audits.cycles()`.
 * So the detail page's FALLBACK read lands on a cache entry the list page
 * never fills: whatever the audits-hub cycle picker last fetched, or a fresh
 * network round-trip, at a different moment and from a different query.
 *
 * The fixture below makes that concrete — the bare `/audits/cycles` endpoint
 * answers in the REVERSE order — so deleting the `usePublishDisplayedOrder`
 * call from the list page does not merely weaken these assertions, it flips
 * the neighbours: stepping down from the middle cycle walks backwards.
 *
 * Assertions are on rendered behaviour: the arrows exist, carry the `cycle`
 * phrase from the catalog, and NAVIGATE to the right neighbour.
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

// The repo-wide next-intl mock returns a FRESH `t` per render, which makes
// page-level suites loop rather than fail. Memoise one `t` per namespace.
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

// The published key is TENANT-scoped off the route params, so a `useParams`
// that forgets `tenantSlug` silently splits publisher and reader onto two
// different cache keys.
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
    usePathname: () => '/t/acme/audits/cycles',
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

// The create-cycle trigger sits behind an authz gate this suite does not
// exercise; the stepper is what is under test.
jest.mock('@/components/require-permission', () => ({
    RequirePermission: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { SWRConfig } from 'swr';
import AuditCyclesPage from '@/app/t/[tenantSlug]/(app)/audits/cycles/page';
import CycleDetailPage from '@/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/page';
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

function cycle(id: string, name: string) {
    return {
        id,
        name,
        frameworkKey: 'ISO27001',
        frameworkVersion: '2022',
        status: 'PLANNING',
        createdAt: '2026-06-01T00:00:00.000Z',
        packs: [] as { id: string }[],
    };
}

/** What the readiness overview returns — and therefore what the page paints. */
const DISPLAYED = [cycle('cyc-a', 'FY26 Q1'), cycle('cyc-b', 'FY26 Q2'), cycle('cyc-c', 'FY26 Q3')];
/**
 * What the BARE `/audits/cycles` endpoint answers — the stepper's fallback
 * key, which the cycles page never populates. Reversed on purpose: any
 * assertion below that passes for this order is not testing the publish.
 */
const FALLBACK = [...DISPLAYED].reverse();

const fetchMock = jest.fn();

beforeEach(() => {
    routeParams.current = { tenantSlug: 'acme' };
    routerMock.replace.mockReset();
    routerMock.push.mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
        if (u.includes('action=default-pack-preview')) return ok(null);
        if (u.endsWith('/audits/readiness/overview')) {
            return ok({ cycles: DISPLAYED, scoresByCycleId: {} });
        }
        if (u.endsWith('/audits/cycles')) return ok(FALLBACK);
        const detail = /\/audits\/cycles\/([\w-]+)$/.exec(u);
        if (detail) {
            const row = DISPLAYED.find((c) => c.id === detail[1]);
            return ok(row ? { ...row, audits: [], packs: [] } : null);
        }
        if (u.endsWith('/frameworks')) return ok([]);
        return ok(null);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

/** One SWR cache shared by the list mount and the detail mount. */
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

/** Mount the cycles LIST and return the cycle ids in painted DOM order. */
async function renderListAndReadOrder(Wrapper: React.ComponentType<{ children: React.ReactNode }>) {
    const view = render(<Wrapper><AuditCyclesPage /></Wrapper>);
    await waitFor(() => {
        expect(view.container.querySelector('[id^="cycle-card-"]')).not.toBeNull();
    });
    await flush();
    const order = Array.from(view.container.querySelectorAll('[id^="cycle-card-"]')).map((el) =>
        el.id.replace('cycle-card-', ''),
    );
    return { view, order };
}

async function renderCycleDetail(
    Wrapper: React.ComponentType<{ children: React.ReactNode }>,
    cycleId: string,
) {
    routeParams.current = { tenantSlug: 'acme', cycleId };
    const view = render(<Wrapper><CycleDetailPage /></Wrapper>);
    await waitFor(() => {
        expect(view.container.querySelector('#cycle-name')).not.toBeNull();
    });
    await flush();
    return view;
}

describe('audit cycle stepper walks the order the cycles list displayed', () => {
    it('steps to the neighbours of the rendered order, not the list endpoint order', async () => {
        const Wrapper = makeWrapper();
        const { view: list, order } = await renderListAndReadOrder(Wrapper);
        // Guard the fixture: the assertions below only mean something while
        // the two orders genuinely disagree.
        expect(order).toEqual(['cyc-a', 'cyc-b', 'cyc-c']);
        expect(FALLBACK.map((c) => c.id)).not.toEqual(order);
        list.unmount();

        const detail = await renderCycleDetail(Wrapper, 'cyc-b');
        expect(detail.container.querySelector('[data-testid="entity-prev-next-nav"]')).not.toBeNull();

        const prev = detail.container.querySelector('[data-testid="entity-nav-prev"]') as HTMLButtonElement;
        const next = detail.container.querySelector('[data-testid="entity-nav-next"]') as HTMLButtonElement;
        // The catalog phrase for THIS entity — not the generic `item` fallback.
        expect(prev.getAttribute('aria-label')).toBe('Previous cycle');
        expect(next.getAttribute('aria-label')).toBe('Next cycle');

        const at = order.indexOf('cyc-b');
        act(() => { fireEvent.click(next); });
        expect(routerMock.replace).toHaveBeenCalledWith(`/t/acme/audits/cycles/${order[at + 1]}`);

        act(() => { fireEvent.click(prev); });
        expect(routerMock.replace).toHaveBeenLastCalledWith(`/t/acme/audits/cycles/${order[at - 1]}`);
    });

    it('disables the far end at the ends of the displayed order', async () => {
        const Wrapper = makeWrapper();
        const { view: list, order } = await renderListAndReadOrder(Wrapper);
        list.unmount();

        const detail = await renderCycleDetail(Wrapper, order[0]);
        const prev = detail.container.querySelector('[data-testid="entity-nav-prev"]') as HTMLButtonElement;
        const next = detail.container.querySelector('[data-testid="entity-nav-next"]') as HTMLButtonElement;
        expect(prev.disabled).toBe(true);
        expect(next.disabled).toBe(false);
        act(() => { fireEvent.click(prev); });
        expect(routerMock.replace).not.toHaveBeenCalled();
    });

    it('falls back to the cycles endpoint when the list was never opened', async () => {
        // A deep link straight into a cycle (email, bookmark) publishes
        // nothing. Cycles pass a real `listKey`, so the server order is still
        // the best available answer — this is the axis audit PACKS
        // deliberately do NOT take (see audit-pack-stepper-displayed-order).
        const Wrapper = makeWrapper();
        const detail = await renderCycleDetail(Wrapper, 'cyc-b');
        await waitFor(() => {
            expect(detail.container.querySelector('[data-testid="entity-prev-next-nav"]')).not.toBeNull();
        });
        const next = detail.container.querySelector('[data-testid="entity-nav-next"]') as HTMLButtonElement;
        const fallbackOrder = FALLBACK.map((c) => c.id);
        const at = fallbackOrder.indexOf('cyc-b');
        act(() => { fireEvent.click(next); });
        expect(routerMock.replace).toHaveBeenCalledWith(`/t/acme/audits/cycles/${fallbackOrder[at + 1]}`);
    });
});
