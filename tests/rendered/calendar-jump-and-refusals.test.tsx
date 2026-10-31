/**
 * #4628 — the calendar's refusals say why, "Jump to it" keeps the filters it
 * was asked from, the next-deadline hint honours the category filter, and the
 * Timeline's panel does not ask for a click it cannot take.
 */

import React from 'react';
import { render, waitFor, fireEvent, act } from '@testing-library/react';

const toastError = jest.fn();
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: (...a: unknown[]) => toastError(...a), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

let currentSearch = '';
const replaceMock = jest.fn((url: string) => {
    currentSearch = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme-corp' }),
    useRouter: () => ({ replace: replaceMock, push: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme-corp/calendar',
    useSearchParams: () => new URLSearchParams(currentSearch),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const cache = new Map<string, unknown>();
    const lookup = (ns: string, key: string) =>
        key
            .split('.')
            .reduce(
                (o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
                (en as Record<string, unknown>)[ns],
            );
    const make = (ns: string) => {
        const t = ((key: string, params?: Record<string, unknown>) => {
            let v = lookup(ns, key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return v as string;
        }) as ((key: string, params?: Record<string, unknown>) => string) & Record<string, unknown>;
        t.has = (key: string) => typeof lookup(ns, key) === 'string';
        t.raw = (key: string) => lookup(ns, key);
        t.rich = (key: string) => lookup(ns, key) ?? key;
        return t;
    };
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next-auth/react', () => ({ signOut: jest.fn(), signIn: jest.fn() }));

import { SWRConfig } from 'swr';
import { CalendarClient } from '@/app/t/[tenantSlug]/(app)/calendar/CalendarClient';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const TENANT_CTX = {
    userId: 'user-1', tenantId: 'tenant-1', tenantSlug: 'acme-corp', tenantName: 'Acme Corp',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: false },
};

const DAY_MS = 86_400_000;
const respond = (events: unknown[]) => ({
    events,
    counts: { total: events.length, partial: false },
    truncation: { capped: false, sources: [], perSourceLimit: 500, totalCap: 5000, totalCapped: false },
    omittedSources: [], failedSources: [],
    todayYmd: new Date().toISOString().slice(0, 10),
    range: { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' },
});

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
let route: (url: string, init?: RequestInit) => Reply;
const fetchMock = jest.fn(async (url: string, init?: RequestInit) => route(String(url), init));

beforeEach(() => {
    currentSearch = '';
    replaceMock.mockClear();
    toastError.mockReset();
    fetchMock.mockClear();
    route = () => ({ ok: true, status: 200, json: async () => respond([]) });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

function mount() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <TooltipProvider>
                    <CalendarClient tenantSlug="acme-corp" />
                </TooltipProvider>
            </TenantProvider>
        </SWRConfig>,
    );
}

const toParam = (url: string) => new Date(decodeURIComponent(new URL(url, 'http://x').searchParams.get('to') ?? '')).getTime();

describe('calendar — "Jump to it" and the next-deadline probe (#4628)', () => {
    it('asks for the next deadline within the filter, and jumps to it in one address change that keeps the filter', async () => {
        const later = new Date(Date.now() + 400 * DAY_MS);
        // The heatmap's window ends about six months out; only the probe asks
        // two years ahead, and only it gets a deadline back.
        route = (url) => ({
            ok: true, status: 200,
            json: async () => respond(
                url.includes('/calendar?') && toParam(url) > Date.now() + 300 * DAY_MS
                    ? [{
                          id: 'ev-1', date: later.toISOString(), title: 'Access policy', type: 'policy-review',
                          category: 'policy', status: 'upcoming', entityType: 'POLICY', entityId: 'p-1',
                          href: '/policies/p-1', source: 'policy', ownerUserId: null,
                      }]
                    : [],
            ),
        });
        currentSearch = 'view=heatmap&categories=policy';
        const { container } = mount();
        await waitFor(() => expect(container.querySelector('#calendar-jump-to-next')).toBeTruthy());

        const probe = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/calendar?') && toParam(u) > Date.now() + 300 * DAY_MS);
        expect(probe).toContain('categories=policy');

        replaceMock.mockClear();
        await act(async () => { fireEvent.click(container.querySelector('#calendar-jump-to-next') as Element); });
        expect(replaceMock).toHaveBeenCalledTimes(1);
        const query = new URLSearchParams(String(replaceMock.mock.calls[0][0]).split('?')[1] ?? '');
        expect(query.get('categories')).toBe('policy');
        expect(query.get('month')).toBe(later.toISOString().slice(0, 7));
        // Month is the default view, so the jump drops `view` rather than
        // leaving the heatmap, where the selected day is not shown.
        expect(query.get('view')).toBeNull();
    });
});

describe('calendar — refusals say why (#4628)', () => {
    it("shows the server's reason when a task cannot be completed from the calendar", async () => {
        const day = '2026-11-10';
        currentSearch = 'month=2026-11';
        route = (url, init) => {
            if (url.includes('/tasks/t-1/status') && init?.method === 'POST') {
                return {
                    ok: false, status: 400,
                    json: async () => ({ error: { code: 'VALIDATION_ERROR', message: 'This task has a reviewer, so it must be In review before it can be closed.' } }),
                };
            }
            return {
                ok: true, status: 200,
                json: async () => respond([{
                    id: 'ev-t1', date: `${day}T09:00:00.000Z`, title: 'Rotate keys', type: 'task-due',
                    category: 'task', status: 'upcoming', entityType: 'TASK', entityId: 't-1',
                    href: '/tasks/t-1', source: 'task', ownerUserId: 'user-1',
                }]),
            };
        };
        const { container, findByText } = mount();
        await waitFor(() => expect(container.querySelector(`[data-ymd="${day}"]`)).toBeTruthy());
        await act(async () => { fireEvent.click(container.querySelector(`[data-ymd="${day}"]`) as Element); });
        const complete = await findByText('Complete');
        await act(async () => { fireEvent.click(complete); });
        await waitFor(() => expect(toastError).toHaveBeenCalled());
        expect(toastError.mock.calls[0][0]).toBe('This task has a reviewer, so it must be In review before it can be closed.');
    });
});

describe('calendar — the Timeline view (#4628)', () => {
    it('does not ask the reader to click a day the timeline has no way to select', async () => {
        currentSearch = 'view=gantt';
        const { container } = mount();
        await waitFor(() => expect(container.querySelector('#calendar-side-panel')).toBeTruthy());
        const panel = container.querySelector('#calendar-side-panel')!.textContent ?? '';
        expect(panel).toContain('The timeline has no days to click.');
        expect(panel).not.toContain('Click a day to see events on that date.');
    });
});
