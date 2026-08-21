/** @jest-environment jsdom */

/**
 * The prev/next stepper on an EU AI Act system, and the fourth production
 * call site of the `orderKey` + null-`listKey` axis `use-entity-list-ids`
 * left open.
 *
 * `/risks/ai-systems` is SERVER-rendered: its rows arrive at
 * `AiSystemsClient` as props and never touch an SWR cache entry. So the
 * detail page has nothing to fall back to, and the order the registry
 * published is the only thing that can give it arrows — which also means a
 * fallback read would fire a fresh `GET /ai-systems` on every detail load to
 * serve a list the deep-linking user never saw. It reads with a null
 * `listKey` instead.
 *
 * The failure mode this guards against is SILENCE: `EntityPrevNextNav`
 * renders `null` when `ids.indexOf(currentId)` is -1, so a wrongly-keyed
 * publish produces no arrows at all and a test that merely asserted "the hook
 * was called" would pass against a completely inert feature. So this suite
 * mounts the real registry, reads the painted order back out of the DOM,
 * mounts the real detail client over the SAME SWR cache, and clicks.
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
// missing `tenantSlug` puts publisher and reader on different cache keys. And
// `usePathname` is load-bearing too: PageHeader classifies the route to decide
// whether the H1 (and with it the `titleAdornment` slot the stepper rides in)
// is visible at all.
const routeParams: { current: Record<string, string> } = {
    current: { tenantSlug: 'acme' },
};
const pathname = { current: '/t/acme/risks/ai-systems' };
const routerMock = {
    push: jest.fn(), replace: jest.fn(), back: jest.fn(),
    refresh: jest.fn(), prefetch: jest.fn(),
};
jest.mock('next/navigation', () => ({
    useParams: () => routeParams.current,
    useRouter: () => routerMock,
    usePathname: () => pathname.current,
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

import { SWRConfig } from 'swr';
import {
    AiSystemsClient,
    type AiSystemRow,
} from '@/app/t/[tenantSlug]/(app)/risks/ai-systems/AiSystemsClient';
import {
    AiSystemDetailClient,
    type AiSystemDetail,
} from '@/app/t/[tenantSlug]/(app)/risks/ai-systems/[systemId]/AiSystemDetailClient';
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

function row(id: string, name: string, riskTier: string): AiSystemRow {
    return {
        id,
        name,
        provider: 'Acme Labs',
        deploymentRole: 'PROVIDER',
        riskTier,
        classificationClauseId: null,
        status: 'ACTIVE',
        ownerUserId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        _count: { requirementLinks: 0 },
    };
}

/** What the registry receives from the server, in server order. */
const ROWS: AiSystemRow[] = [
    row('sys-1', 'Resume screener', 'HIGH'),
    row('sys-2', 'Support summariser', 'MINIMAL'),
    row('sys-3', 'Credit scorer', 'HIGH'),
    row('sys-4', 'Meeting notes bot', 'MINIMAL'),
];

function detail(id: string): AiSystemDetail {
    const r = ROWS.find((x) => x.id === id)!;
    return {
        id: r.id,
        name: r.name,
        provider: r.provider,
        deploymentRole: r.deploymentRole,
        riskTier: r.riskTier,
        status: r.status,
        purpose: null,
        useContext: null,
        classificationClauseId: null,
        classificationRationale: null,
        requirementLinks: [],
    };
}

beforeEach(() => {
    routeParams.current = { tenantSlug: 'acme' };
    pathname.current = '/t/acme/risks/ai-systems';
    routerMock.replace.mockReset();
    routerMock.push.mockReset();
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

function paintedOrder(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('[data-testid^="ai-system-row-"]')).map((el) =>
        (el.getAttribute('data-testid') ?? '').replace('ai-system-row-', ''),
    );
}

/** Mount the REGISTRY and read back the ids it painted, in DOM order. */
async function renderRegistry(
    Wrapper: React.ComponentType<{ children: React.ReactNode }>,
    rows: AiSystemRow[] = ROWS,
) {
    routeParams.current = { tenantSlug: 'acme' };
    pathname.current = '/t/acme/risks/ai-systems';
    const view = render(
        <Wrapper>
            <AiSystemsClient initialRows={rows} tenantSlug="acme" canWrite />
        </Wrapper>,
    );
    await waitFor(() => {
        expect(view.container.querySelector('[data-testid^="ai-system-row-"]')).not.toBeNull();
    });
    await flush();
    return { view, order: paintedOrder(view.container) };
}

async function renderDetail(
    Wrapper: React.ComponentType<{ children: React.ReactNode }>,
    systemId: string,
) {
    routeParams.current = { tenantSlug: 'acme', systemId };
    pathname.current = `/t/acme/risks/ai-systems/${systemId}`;
    const view = render(
        <Wrapper>
            <AiSystemDetailClient system={detail(systemId)} tenantSlug="acme" canWrite />
        </Wrapper>,
    );
    await waitFor(() => {
        expect(view.container.querySelector('[data-testid="page-header-title"]')).not.toBeNull();
    });
    await flush();
    return view;
}

describe('AI-system stepper reads the order the registry displayed', () => {
    it('steps to the systems either side of the one the registry painted', async () => {
        const Wrapper = makeWrapper();
        const { view: registry, order } = await renderRegistry(Wrapper);
        expect(order).toEqual(['sys-1', 'sys-2', 'sys-3', 'sys-4']);
        registry.unmount();

        const view = await renderDetail(Wrapper, 'sys-2');
        // Positive anchor: the page really rendered THIS system.
        expect(
            view.container.querySelector('[data-testid="page-header-title"]')?.textContent,
        ).toBe('Support summariser');
        expect(view.container.querySelector('[data-testid="entity-prev-next-nav"]')).not.toBeNull();

        const prev = view.container.querySelector('[data-testid="entity-nav-prev"]') as HTMLButtonElement;
        const next = view.container.querySelector('[data-testid="entity-nav-next"]') as HTMLButtonElement;
        // No `aiSystem` phrase in the stepper catalog yet → generic wording.
        expect(prev.getAttribute('aria-label')).toBe('Previous item');
        expect(next.getAttribute('aria-label')).toBe('Next item');

        act(() => { fireEvent.click(next); });
        expect(routerMock.replace).toHaveBeenCalledWith('/t/acme/risks/ai-systems/sys-3');

        act(() => { fireEvent.click(prev); });
        expect(routerMock.replace).toHaveBeenLastCalledWith('/t/acme/risks/ai-systems/sys-1');
    });

    it('walks the FILTERED order, not the server order', async () => {
        const Wrapper = makeWrapper();
        // What the registry paints once the risk-tier filter has narrowed it
        // to HIGH. Feeding the narrowed rows is what the filter click amounts
        // to at the publish seam; driving the cmdk popover would assert the
        // filter widget, not the stepper.
        const { view: registry, order } = await renderRegistry(
            Wrapper,
            ROWS.filter((r) => r.riskTier === 'HIGH'),
        );
        expect(order).toEqual(['sys-1', 'sys-3']);
        registry.unmount();

        // sys-1's next neighbour is sys-3 — the filtered order — and NOT
        // sys-2, which the unfiltered server order would have offered.
        const view = await renderDetail(Wrapper, 'sys-1');
        const prev = view.container.querySelector('[data-testid="entity-nav-prev"]') as HTMLButtonElement;
        const next = view.container.querySelector('[data-testid="entity-nav-next"]') as HTMLButtonElement;
        expect(prev.disabled).toBe(true);
        act(() => { fireEvent.click(next); });
        expect(routerMock.replace).toHaveBeenCalledWith('/t/acme/risks/ai-systems/sys-3');
        expect(routerMock.replace).not.toHaveBeenCalledWith('/t/acme/risks/ai-systems/sys-2');
    });

    it('shows no arrows, and issues no list request, on a deep link', async () => {
        const fetchMock = jest.fn(
            async () => ({ ok: true, json: async () => [] }) as unknown as Response,
        );
        (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
        try {
            const Wrapper = makeWrapper();
            const view = await renderDetail(Wrapper, 'sys-3');
            // Positive anchor: the page rendered. This is not a "nothing
            // mounted, so of course there are no arrows" pass.
            expect(
                view.container.querySelector('[data-testid="page-header-title"]')?.textContent,
            ).toBe('Credit scorer');
            expect(view.container.querySelector('[data-testid="entity-prev-next-nav"]')).toBeNull();
            // …and the null `listKey` meant no fallback fetch went out.
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            delete (global as unknown as { fetch?: unknown }).fetch;
        }
    });

    it('disables the far end at the ends of the published order', async () => {
        const Wrapper = makeWrapper();
        const { view: registry, order } = await renderRegistry(Wrapper);
        registry.unmount();

        const view = await renderDetail(Wrapper, order[order.length - 1]);
        const prev = view.container.querySelector('[data-testid="entity-nav-prev"]') as HTMLButtonElement;
        const next = view.container.querySelector('[data-testid="entity-nav-next"]') as HTMLButtonElement;
        expect(next.disabled).toBe(true);
        expect(prev.disabled).toBe(false);
        act(() => { fireEvent.click(next); });
        expect(routerMock.replace).not.toHaveBeenCalled();
        act(() => { fireEvent.click(prev); });
        expect(routerMock.replace).toHaveBeenCalledWith(
            `/t/acme/risks/ai-systems/${order[order.length - 2]}`,
        );
    });
});
