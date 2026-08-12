/**
 * The calendar filter lives in the side panel, and the calendar's state lives
 * in the URL.
 *
 * Two claims, both previously untestable because `CalendarClient` had no
 * executing test at all:
 *
 *   1. The interactive filter moved INTO the day-events panel, while a
 *      non-interactive colour key stayed with the grid. Those used to be the
 *      same control — chips that were both the legend and the filter — so
 *      moving them wholesale would have left a grid of coloured events with no
 *      key anywhere.
 *   2. View, month, categories and "my deadlines" are in the query string. None
 *      of them were, on a page whose entire purpose is "what is due" and whose
 *      links get pasted into chat: a shared link dropped the recipient on the
 *      current month with no filters, whatever the sender was looking at.
 */

import React from 'react';
import { render, waitFor, fireEvent, act } from '@testing-library/react';

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
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme-corp',
    tenantName: 'Acme Corp',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

const EMPTY_RESPONSE = {
    events: [],
    counts: { total: 0, partial: false },
    truncation: { capped: false, sources: [], perSourceLimit: 500, totalCap: 5000, totalCapped: false },
    omittedSources: [],
    failedSources: [],
    todayYmd: '2026-06-01',
    range: { from: '2026-05-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
};

beforeEach(() => {
    currentSearch = '';
    replaceMock.mockClear();
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => EMPTY_RESPONSE,
    }));
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

describe('calendar filter panel placement', () => {
    it('renders the interactive filter INSIDE the side panel', async () => {
        const { container } = mount();
        await waitFor(() =>
            expect(container.querySelector('#calendar-filter-group')).toBeTruthy(),
        );
        const panel = container.querySelector('[data-testid="calendar-side-panel"]');
        expect(panel).toBeTruthy();
        // Containment, not mere co-existence: the whole point of the move.
        expect(panel!.querySelector('#calendar-filter-group')).toBeTruthy();
    });

    it('keeps a colour key with the grid, OUTSIDE the panel', async () => {
        const { container } = mount();
        await waitFor(() => expect(container.querySelector('#calendar-legend')).toBeTruthy());
        const panel = container.querySelector('[data-testid="calendar-side-panel"]');
        // Moving the chips wholesale would have taken the key away from the
        // grid it explains.
        expect(panel!.querySelector('#calendar-legend')).toBeNull();
    });

    it('the legend is not interactive — the filter is', async () => {
        const { container } = mount();
        await waitFor(() => expect(container.querySelector('#calendar-legend')).toBeTruthy());
        const legend = container.querySelector('#calendar-legend')!;
        expect(legend.querySelectorAll('button')).toHaveLength(0);
        expect(legend.querySelectorAll('input')).toHaveLength(0);
        // …while the filter group carries the controls.
        const group = container.querySelector('#calendar-filter-group')!;
        expect(group.querySelectorAll('[role="checkbox"], input').length).toBeGreaterThan(0);
    });

    it('moves the total count with the filter it reports on', async () => {
        const { container } = mount();
        await waitFor(() =>
            expect(container.querySelector('[data-testid="calendar-count-total"]')).toBeTruthy(),
        );
        const group = container.querySelector('#calendar-filter-group')!;
        // The count is the only feedback that a filter did anything, so it has
        // to travel with it.
        expect(group.querySelector('[data-testid="calendar-count-total"]')).toBeTruthy();
    });
});

describe('calendar state is shareable via the URL', () => {
    it('writes a toggled category into the query string', async () => {
        const { container } = mount();
        await waitFor(() =>
            expect(container.querySelector('#calendar-filter-group')).toBeTruthy(),
        );
        const box = container
            .querySelector('#calendar-filter-group')!
            .querySelector('[role="checkbox"], input')!;
        await act(async () => {
            fireEvent.click(box);
        });
        expect(replaceMock).toHaveBeenCalled();
        const url = replaceMock.mock.calls.at(-1)![0] as string;
        expect(url).toContain('categories=');
    });

    it('reads the view back OUT of the query string', async () => {
        // The half that makes a pasted link work: state in the URL is useless
        // if the page does not initialise from it.
        currentSearch = 'view=heatmap';
        const { container } = mount();
        await waitFor(() =>
            expect(container.querySelector('[data-testid="calendar-heatmap"]')).toBeTruthy(),
        );
        // …and the month grid is NOT what rendered.
        expect(container.querySelector('[data-testid="calendar-month"]')).toBeNull();
    });

    it('restores an active category filter from the query string', async () => {
        currentSearch = 'categories=risk';
        const { container } = mount();
        await waitFor(() =>
            expect(container.querySelector('#calendar-filter-group')).toBeTruthy(),
        );
        const checked = container
            .querySelector('#calendar-filter-group')!
            .querySelectorAll('[data-state="checked"], input:checked');
        expect(checked.length).toBeGreaterThan(0);
    });
});
