/** @jest-environment jsdom */

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { getPermissionsForRole } from '@/lib/permissions';


/**
 * #4630 — the Tests page offers each control only to the roles the server lets
 * use it: creating, bulk status and bulk owner take `tests.create`, starting a
 * run takes `tests.execute`, and bulk delete takes `admin.manage`.
 */
type Role = 'OWNER' | 'EDITOR' | 'READER';
function ctxFor(role: Role) {
    const canWrite = role !== 'READER';
    return {
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        tenantName: 'Acme',
        role,
        permissions: { canRead: true, canWrite, canAdmin: role === 'OWNER', canAudit: false, canExport: canWrite },
        appPermissions: getPermissionsForRole(role),
        modules: { processCanvas: false },
    };
}

/** Due within a week, so the row qualifies for "Run Now". */
const DUE_SOON = new Date(Date.now() + 2 * 86_400_000).toISOString();
const PLANS = [
    {
        id: 'plan-1', name: 'Quarterly access check', method: 'MANUAL', frequency: 'QUARTERLY',
        status: 'ACTIVE', nextDueAt: DUE_SOON, nextRunAt: null, controlId: 'ctl-1',
        control: { id: 'ctl-1', code: 'AC-1', name: 'Access' }, owner: null, runs: [],
        _count: { runs: 0, steps: 0 },
    },
];
const CHECKS = [
    { id: 'chk-1', provider: 'github', automationKey: 'github.branch_protection', status: 'PARTIAL',
      controlId: 'ctl-1', executedAt: null, control: { id: 'ctl-1', name: 'Access', code: 'AC-1' } },
];

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        const ok = (body: unknown) => ({ ok: true, text: async () => JSON.stringify(body), json: async () => body }) as Response;
        if (u.endsWith('/tests/plans')) return ok(PLANS);
        if (u.endsWith('/tests/checks')) return ok({ checks: CHECKS });
        return ok(null);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

async function renderAs(role: Role) {
    const cache = new Map();
    const view = render(
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={ctxFor(role)}>
                <KeyboardShortcutProvider>
                    <TooltipProvider><TestsRollupPage /></TooltipProvider>
                </KeyboardShortcutProvider>
            </TenantProvider>
        </SWRConfig>,
    );
    await waitFor(() => {
        expect(view.container.querySelector('a[href="/t/acme/tests/plans/plan-1"]')).not.toBeNull();
    });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    return view;
}

/** The first row's selection box (the header's select-all is the first box in the table). */
const rowCheckbox = (c: HTMLElement) => c.querySelectorAll('table [role="checkbox"]')[1] ?? null;

/** The labels the bulk bar's action picker offers, after selecting the first row. */
async function bulkActionLabels(c: HTMLElement): Promise<string[]> {
    await act(async () => { fireEvent.click(rowCheckbox(c) as Element); });
    const select = document.getElementById('bulk-action-select') as HTMLElement;
    fireEvent.click(select);
    const listbox = await screen.findByRole('listbox');
    return within(listbox).getAllByRole('option').map((o) => o.textContent?.trim() ?? '');
}

describe('Tests page — controls follow the server (#4630)', () => {
    it('a Reader gets no create button, no row selection and no Run Now', async () => {
        const { container, queryByText } = await renderAs('READER');
        expect(container.querySelector('#tests-create-plan-btn')).toBeNull();
        expect(rowCheckbox(container)).toBeNull();
        expect(queryByText('Run Now')).toBeNull();
    });

    it('an Editor can create, select and run, but bulk delete is not offered', async () => {
        const { container, getAllByText, queryByText } = await renderAs('EDITOR');
        expect(container.querySelector('#tests-create-plan-btn')).not.toBeNull();
        expect(getAllByText('Run Now').length).toBeGreaterThan(0);
        expect(rowCheckbox(container)).not.toBeNull();
        const labels = await bulkActionLabels(container);
        expect(labels).toEqual(expect.arrayContaining(['Set status', 'Assign owner']));
        expect(labels).not.toContain('Delete');
        expect(queryByText('Delete')).toBeNull();
    });

    it('an Owner is offered bulk delete', async () => {
        const { container } = await renderAs('OWNER');
        expect(await bulkActionLabels(container)).toContain('Delete');
    });

    it('a PARTIAL automated check reads "Partial", not a message path', async () => {
        const { getByText, findByText } = await renderAs('READER');
        await act(async () => { fireEvent.click(getByText('Automated checks')); });
        await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/tests/checks'))).toBe(true));
        expect(await findByText('Partial')).toBeTruthy();
    });
});
