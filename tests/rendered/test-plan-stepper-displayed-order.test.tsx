/** @jest-environment jsdom */

/**
 * The prev/next stepper on a TEST PLAN — the one entity in the stepper wave
 * whose siblings depend on which door you came through.
 *
 * `TestPlanDetailView` backs two routes:
 *
 *   • `/tests/plans/{planId}`                    (context="tests")
 *   • `/controls/{controlId}/tests/{planId}`     (context="control")
 *
 * and the list behind each is a DIFFERENT set. The `/tests` register lists
 * every plan in the tenant, filtered and client-sorted; `TestPlansPanel` on
 * the control detail page lists only that control's plans. Stepping the
 * register's order from the control-scoped route would walk to a plan owned
 * by another control while the URL still names this one — so the reader picks
 * its `orderKey` per context, and `hrefFor` builds the matching route.
 *
 * The failure mode being guarded is SILENCE: `EntityPrevNextNav` renders
 * `null` when `ids.indexOf(currentId)` is -1, so a wrongly-keyed publish
 * yields no arrows at all and a test that only asserted "the hook was called"
 * would pass against a completely inert feature. Every case here reads the
 * painted order out of the DOM and clicks the real buttons.
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
const pathname = { current: '/t/acme/tests' };
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

jest.mock('@/components/require-permission', () => ({
    RequirePermission: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { SWRConfig } from 'swr';
import TestsRollupPage from '@/app/t/[tenantSlug]/(app)/tests/page';
import TestPlansPanel from '@/components/TestPlansPanel';
import { TestPlanDetailView } from '@/components/test-plans/TestPlanDetailView';
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

interface Plan {
    id: string;
    name: string;
    controlId: string;
}

/**
 * The tenant-wide register's plans, in SERVER order. Names are deliberately
 * NOT alphabetical: the first test sorts by Name and asserts the stepper
 * follows the sorted order, which is only a real assertion because the two
 * orders differ.
 */
const REGISTER: Plan[] = [
    { id: 'plan-z', name: 'Zeta restore drill', controlId: 'ctl-1' },
    { id: 'plan-m', name: 'Mu access review', controlId: 'ctl-2' },
    { id: 'plan-a', name: 'Alpha backup check', controlId: 'ctl-1' },
];

/** ctl-1's own plans — a strict subset, in the panel's own order. */
const CONTROL_PLANS: Plan[] = [
    { id: 'plan-z', name: 'Zeta restore drill', controlId: 'ctl-1' },
    { id: 'plan-a', name: 'Alpha backup check', controlId: 'ctl-1' },
];

function summary(p: Plan) {
    return {
        id: p.id,
        name: p.name,
        method: 'MANUAL',
        frequency: 'QUARTERLY',
        status: 'ACTIVE',
        nextDueAt: null,
        nextRunAt: null,
        automationType: 'MANUAL',
        schedule: null,
        controlId: p.controlId,
        control: { id: p.controlId, code: p.controlId.toUpperCase(), name: `Control ${p.controlId}` },
        owner: null,
        runs: [],
        _count: { runs: 0, steps: 0 },
    };
}

function detail(p: Plan) {
    return {
        ...summary(p),
        description: null,
        scheduleTimezone: null,
        createdBy: null,
        steps: [],
        runs: [],
        runResultCounts: { passed: 0, failed: 0, inconclusive: 0 },
        createdAt: '2026-01-01T00:00:00.000Z',
    };
}

const fetchMock = jest.fn();
/** Every URL the stub was asked for — used by the no-fallback assertion. */
let requested: string[] = [];

beforeEach(() => {
    routeParams.current = { tenantSlug: 'acme' };
    pathname.current = '/t/acme/tests';
    routerMock.replace.mockReset();
    routerMock.push.mockReset();
    requested = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        requested.push(u);
        const ok = (body: unknown) => ({ ok: true, text: async () => JSON.stringify(body), json: async () => body }) as Response;
        const one = /\/tests\/plans\/([\w-]+)$/.exec(u);
        if (one) {
            const p = REGISTER.find((x) => x.id === one[1]);
            return ok(p ? detail(p) : null);
        }
        const panel = /\/controls\/([\w-]+)\/tests\/plans$/.exec(u);
        if (panel) return ok(CONTROL_PLANS.filter((p) => p.controlId === panel[1]).map(summary));
        const control = /\/controls\/([\w-]+)$/.exec(u);
        if (control) return ok({ id: control[1], code: control[1].toUpperCase(), name: `Control ${control[1]}` });
        if (u.endsWith('/tests/plans')) return ok(REGISTER.map(summary));
        if (u.endsWith('/tests/checks')) return ok({ checks: [] });
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

async function flush(times = 8) {
    await act(async () => {
        for (let i = 0; i < times; i++) await Promise.resolve();
    });
}

/** Plan ids linked from a container, in DOM order, de-duplicated. */
function linkedPlanIds(container: HTMLElement, hrefPrefix: string): string[] {
    const ids = Array.from(container.querySelectorAll(`a[href^="${hrefPrefix}"]`)).map((a) =>
        (a.getAttribute('href') ?? '').slice(hrefPrefix.length),
    );
    return ids.filter((id, i) => id !== '' && ids.indexOf(id) === i);
}

async function renderRegister(Wrapper: React.ComponentType<{ children: React.ReactNode }>) {
    routeParams.current = { tenantSlug: 'acme' };
    pathname.current = '/t/acme/tests';
    const view = render(<Wrapper><TestsRollupPage /></Wrapper>);
    await waitFor(() => {
        expect(view.container.querySelector('a[href^="/t/acme/tests/plans/"]')).not.toBeNull();
    });
    await flush();
    return view;
}

async function renderPanel(Wrapper: React.ComponentType<{ children: React.ReactNode }>) {
    routeParams.current = { tenantSlug: 'acme', controlId: 'ctl-1' };
    pathname.current = '/t/acme/controls/ctl-1';
    const view = render(<Wrapper><TestPlansPanel controlId="ctl-1" /></Wrapper>);
    await waitFor(() => {
        expect(view.container.querySelector('[id^="test-plan-link-"]')).not.toBeNull();
    });
    await flush();
    return view;
}

async function renderPlanDetail(
    Wrapper: React.ComponentType<{ children: React.ReactNode }>,
    planId: string,
    context: 'control' | 'tests',
) {
    routeParams.current =
        context === 'tests'
            ? { tenantSlug: 'acme', planId }
            : { tenantSlug: 'acme', controlId: 'ctl-1', planId };
    pathname.current =
        context === 'tests'
            ? `/t/acme/tests/plans/${planId}`
            : `/t/acme/controls/ctl-1/tests/${planId}`;
    const view = render(<Wrapper><TestPlanDetailView planId={planId} context={context} /></Wrapper>);
    await waitFor(() => {
        expect(view.container.querySelector('#test-plan-title')).not.toBeNull();
    });
    await flush();
    return view;
}

function navButtons(container: HTMLElement) {
    return {
        prev: container.querySelector('[data-testid="entity-nav-prev"]') as HTMLButtonElement | null,
        next: container.querySelector('[data-testid="entity-nav-next"]') as HTMLButtonElement | null,
    };
}

describe('test-plan stepper — the /tests register entry path', () => {
    it('steps to the plans either side of the one the register painted', async () => {
        const Wrapper = makeWrapper();
        const register = await renderRegister(Wrapper);
        const order = linkedPlanIds(register.container, '/t/acme/tests/plans/');
        expect(order).toEqual(['plan-z', 'plan-m', 'plan-a']);
        register.unmount();

        const view = await renderPlanDetail(Wrapper, 'plan-m', 'tests');
        // Positive anchor: this really is plan-m's page.
        expect(view.container.querySelector('#test-plan-title')?.textContent).toBe('Mu access review');
        expect(view.container.querySelector('[data-testid="entity-prev-next-nav"]')).not.toBeNull();

        const { prev, next } = navButtons(view.container);
        // No `testPlan` phrase in the stepper catalog yet → generic wording.
        expect(prev!.getAttribute('aria-label')).toBe('Previous item');
        expect(next!.getAttribute('aria-label')).toBe('Next item');

        act(() => { fireEvent.click(next!); });
        expect(routerMock.replace).toHaveBeenCalledWith('/t/acme/tests/plans/plan-a');
        act(() => { fireEvent.click(prev!); });
        expect(routerMock.replace).toHaveBeenLastCalledWith('/t/acme/tests/plans/plan-z');
    });

    it('follows the register’s CLIENT sort, not the order the server returned', async () => {
        const Wrapper = makeWrapper();
        const register = await renderRegister(Wrapper);
        expect(linkedPlanIds(register.container, '/t/acme/tests/plans/')).toEqual([
            'plan-z', 'plan-m', 'plan-a',
        ]);

        // Sort by Name. The sort is a `useState` that never reaches the SWR
        // key — the cache entry keeps SERVER order — so this is exactly the
        // divergence the publish/read contract exists to close.
        const nameHeader = Array.from(
            register.container.querySelectorAll('thead button'),
        ).find((b) => (b.textContent ?? '').trim().startsWith('Name')) as HTMLButtonElement;
        expect(nameHeader).toBeDefined();
        // First click sorts desc; a second gives asc.
        act(() => { fireEvent.click(nameHeader); });
        await flush();
        act(() => { fireEvent.click(nameHeader); });
        await flush();

        const sorted = linkedPlanIds(register.container, '/t/acme/tests/plans/');
        expect(sorted).toEqual(['plan-a', 'plan-m', 'plan-z']);
        register.unmount();

        // plan-m's neighbours under the SORTED order are plan-a then plan-z;
        // under the server order they would have been plan-z then plan-a.
        const view = await renderPlanDetail(Wrapper, 'plan-m', 'tests');
        const { prev, next } = navButtons(view.container);
        act(() => { fireEvent.click(prev!); });
        expect(routerMock.replace).toHaveBeenCalledWith('/t/acme/tests/plans/plan-a');
        act(() => { fireEvent.click(next!); });
        expect(routerMock.replace).toHaveBeenLastCalledWith('/t/acme/tests/plans/plan-z');
    });

    it('falls back to the list endpoint on a deep link into a plan', async () => {
        const Wrapper = makeWrapper();
        // Nothing published — straight to the detail route.
        const view = await renderPlanDetail(Wrapper, 'plan-m', 'tests');
        expect(view.container.querySelector('#test-plan-title')?.textContent).toBe('Mu access review');
        // The register's own SWR key IS `tests.plans()`, so the fallback read
        // is meaningful here: server order is the best available answer.
        await waitFor(() => {
            expect(view.container.querySelector('[data-testid="entity-prev-next-nav"]')).not.toBeNull();
        });
        expect(requested.some((u) => u.endsWith('/tests/plans'))).toBe(true);
        const { next } = navButtons(view.container);
        act(() => { fireEvent.click(next!); });
        expect(routerMock.replace).toHaveBeenCalledWith('/t/acme/tests/plans/plan-a');
    });
});

describe('test-plan stepper — the control-scoped entry path', () => {
    it('walks only THAT control’s plans, under the control-scoped href', async () => {
        const Wrapper = makeWrapper();
        const panel = await renderPanel(Wrapper);
        const order = Array.from(panel.container.querySelectorAll('[id^="test-plan-link-"]')).map(
            (el) => el.id.replace('test-plan-link-', ''),
        );
        expect(order).toEqual(['plan-z', 'plan-a']);
        // Fixture guard: the register carries a plan (plan-m) this control
        // does not own, so a register-keyed read would step somewhere wrong.
        expect(REGISTER.map((p) => p.id)).not.toEqual(order);
        panel.unmount();

        const view = await renderPlanDetail(Wrapper, 'plan-z', 'control');
        expect(view.container.querySelector('#test-plan-title')?.textContent).toBe('Zeta restore drill');
        const { prev, next } = navButtons(view.container);
        expect(prev!.disabled).toBe(true);
        act(() => { fireEvent.click(next!); });
        // The control-scoped route, and plan-a — NOT plan-m, which is the
        // register's next neighbour for plan-z.
        expect(routerMock.replace).toHaveBeenCalledWith('/t/acme/controls/ctl-1/tests/plan-a');
        expect(routerMock.replace).not.toHaveBeenCalledWith('/t/acme/tests/plans/plan-m');
    });

    it('shows no arrows, and reads no plan list, on a control-scoped deep link', async () => {
        const Wrapper = makeWrapper();
        const view = await renderPlanDetail(Wrapper, 'plan-z', 'control');
        // Positive anchor: the page rendered — this is not a "nothing mounted"
        // pass — and it fetched the plan itself.
        expect(view.container.querySelector('#test-plan-title')?.textContent).toBe('Zeta restore drill');
        expect(requested.some((u) => u.endsWith('/tests/plans/plan-z'))).toBe(true);
        expect(view.container.querySelector('[data-testid="entity-prev-next-nav"]')).toBeNull();
        // The control key has a null `listKey`, and the register key must not
        // leak in through the other branch.
        expect(requested.some((u) => u.endsWith('/tests/plans'))).toBe(false);
        expect(requested.some((u) => u.endsWith('/controls/ctl-1/tests/plans'))).toBe(false);
    });
});
