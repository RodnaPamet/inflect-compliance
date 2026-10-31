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
import { toast } from 'sonner';
import { TestPlanDetailView } from '@/components/test-plans/TestPlanDetailView';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { getPermissionsForRole } from '@/lib/permissions';
import type { TenantContextValue } from '@/lib/tenant-context-provider';

/**
 * #4796 — the test-plan page tells the person WHY a write was refused, and
 * offers each write only to a viewer whose tests permission the server asks.
 */

const PLAN = {
    id: 'plan-1',
    name: 'Quarterly restore drill',
    description: null,
    method: 'AUTOMATED',
    frequency: 'QUARTERLY',
    status: 'ACTIVE',
    nextDueAt: null,
    automationType: 'INTEGRATION',
    schedule: '0 9 * * MON',
    scheduleTimezone: 'UTC',
    nextRunAt: null,
    controlId: 'ctl-1',
    owner: null,
    createdBy: null,
    steps: [],
    runs: [],
    _count: { runs: 0, steps: 0 },
    runResultCounts: { passed: 0, failed: 0, inconclusive: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
};

const REFUSAL = 'Only the owner of the auditor agent may change this plan.';

const fetchMock = jest.fn();

function ok(body: unknown) {
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response;
}
function refused(status: number, body: unknown) {
    return { ok: false, status, text: async () => JSON.stringify(body), json: async () => body } as Response;
}

beforeEach(() => {
    routeParams.current = { tenantSlug: 'acme', planId: 'plan-1' };
    (toast.error as jest.Mock).mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/tests/plans/plan-1/runs') && init?.method === 'POST') {
            return refused(403, { error: { code: 'FORBIDDEN', message: REFUSAL } });
        }
        if (u.endsWith('/tests/plans/plan-1') && init?.method === 'PATCH') {
            return refused(403, { error: { code: 'FORBIDDEN', message: REFUSAL } });
        }
        if (u.endsWith('/tests/plans/plan-1')) return ok(PLAN);
        return ok(null);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

function ctxFor(overrides: Partial<TenantContextValue>): TenantContextValue {
    return {
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        tenantName: 'Acme',
        role: 'OWNER',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('OWNER'),
        modules: { processCanvas: false },
        ...overrides,
    } as TenantContextValue;
}

function renderView(ctx: TenantContextValue) {
    const cache = new Map();
    return render(
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={ctx}>
                <KeyboardShortcutProvider>
                    <TooltipProvider>
                        <TestPlanDetailView planId="plan-1" context="tests" />
                    </TooltipProvider>
                </KeyboardShortcutProvider>
            </TenantProvider>
        </SWRConfig>,
    );
}

async function flush(times = 8) {
    await act(async () => {
        for (let i = 0; i < times; i++) await Promise.resolve();
    });
}

describe('TestPlanDetailView — refusals carry the server reason (#4796)', () => {
    test('a refused run shows the refusal, not the generic failure', async () => {
        renderView(ctxFor({}));
        await waitFor(() => expect(document.getElementById('create-test-run-btn')).not.toBeNull());
        fireEvent.click(document.getElementById('create-test-run-btn')!);
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(toast.error).toHaveBeenCalledWith(REFUSAL, expect.anything());
        expect(routerMock.push).not.toHaveBeenCalled();
    });

    test('a refused save shows the refusal and keeps the form open', async () => {
        renderView(ctxFor({}));
        await waitFor(() => expect(document.getElementById('edit-test-plan-btn')).not.toBeNull());
        fireEvent.click(document.getElementById('edit-test-plan-btn')!);
        fireEvent.click(document.getElementById('save-plan-changes-btn')!);
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(toast.error).toHaveBeenCalledWith(REFUSAL, expect.anything());
        expect(document.getElementById('save-plan-changes-btn')).not.toBeNull();
    });

    test('a 5xx keeps the generic message', async () => {
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            const u = String(url);
            if (u.endsWith('/runs') && init?.method === 'POST') return refused(500, { error: { message: 'db exploded' } });
            if (u.endsWith('/tests/plans/plan-1')) return ok(PLAN);
            return ok(null);
        });
        renderView(ctxFor({}));
        await waitFor(() => expect(document.getElementById('create-test-run-btn')).not.toBeNull());
        fireEvent.click(document.getElementById('create-test-run-btn')!);
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect((toast.error as jest.Mock).mock.calls[0][0]).not.toContain('db exploded');
    });
});

describe('TestPlanDetailView — writes follow the tests permissions (#4796)', () => {
    test('a write-tier viewer without tests.create / tests.execute is offered no write', async () => {
        const auditorTests = getPermissionsForRole('AUDITOR');
        renderView(ctxFor({ role: 'EDITOR', appPermissions: auditorTests }));
        await waitFor(() => expect(document.getElementById('test-plan-title')).not.toBeNull());
        await flush();
        expect(document.getElementById('edit-test-plan-btn')).toBeNull();
        expect(document.getElementById('create-test-run-btn')).toBeNull();
    });

    test('tests.execute alone offers the run but not the edit', async () => {
        const base = getPermissionsForRole('READER');
        renderView(ctxFor({
            role: 'READER',
            permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
            appPermissions: { ...base, tests: { view: true, create: false, execute: true } },
        }));
        await waitFor(() => expect(document.getElementById('create-test-run-btn')).not.toBeNull());
        expect(document.getElementById('edit-test-plan-btn')).toBeNull();
    });
});
