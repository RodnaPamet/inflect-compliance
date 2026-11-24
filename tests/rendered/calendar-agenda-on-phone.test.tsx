/**
 * The calendar on a phone opens as an agenda: the month's deadlines as a list
 * of days, today first, every event a link — with month navigation, and the
 * month grid one tap away. From `md` up the month grid stays the default.
 */

import React from 'react';
import { render, waitFor, fireEvent, act, within, screen } from '@testing-library/react';

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

jest.mock('next-auth/react', () => ({ signOut: jest.fn(), signIn: jest.fn() }));

import { SWRConfig } from 'swr';
import { CalendarClient } from '@/app/t/[tenantSlug]/(app)/calendar/CalendarClient';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const EN = jest.requireActual('../../messages/en.json') as {
    calendar: Record<string, string> & { agenda: Record<string, string>; category: Record<string, string> };
};

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme-corp',
    tenantName: 'Acme Corp',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: false },
};

const event = (id: string, date: string, over: Record<string, unknown> = {}) => ({
    id: `TASK:${id}:task-due`,
    type: 'task-due',
    category: 'task',
    title: `Task due: ${id}`,
    entityName: `Deadline ${id}`,
    date: `${date}T00:00:00.000Z`,
    status: 'scheduled',
    entityType: 'TASK',
    entityId: id,
    href: `/t/acme-corp/tasks/${id}`,
    ...over,
});

const RESPONSE = {
    events: [
        event('past', '2026-06-03', { status: 'overdue' }),
        event('today', '2026-06-10', { status: 'due_soon' }),
        event('later', '2026-06-12'),
        event('also-later', '2026-06-12', { category: 'evidence', type: 'evidence-review', entityType: 'EVIDENCE' }),
    ],
    counts: { total: 4, partial: false },
    truncation: { capped: false, sources: [], perSourceLimit: 500, totalCap: 5000, totalCapped: false },
    omittedSources: [],
    failedSources: [],
    todayYmd: '2026-06-10',
    range: { from: '2026-05-25T00:00:00.000Z', to: '2026-07-06T00:00:00.000Z' },
};

const realMatchMedia = window.matchMedia;
function setViewport(phone: boolean) {
    window.matchMedia = ((query: string) => ({
        matches: query.includes('max-width: 767.98px') ? phone : false,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
    })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
    currentSearch = 'month=2026-06';
    replaceMock.mockClear();
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => RESPONSE,
    }));
});
afterEach(() => {
    window.matchMedia = realMatchMedia;
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

const agendaDays = () =>
    screen.getAllByTestId('calendar-agenda-day').map((d) => d.getAttribute('data-ymd'));

describe('calendar on a phone', () => {
    beforeEach(() => setViewport(true));

    it('opens as an agenda, today first, with the month grid not rendered', async () => {
        mount();
        await waitFor(() => expect(screen.getByTestId('calendar-agenda')).toBeInTheDocument());
        expect(document.querySelector('[data-testid="calendar-month"]')).toBeNull();
        // What is due now leads; the earlier day waits behind one button.
        expect(agendaDays()).toEqual(['2026-06-10', '2026-06-12']);
        const today = screen.getAllByTestId('calendar-agenda-day')[0];
        expect(within(today).getByText(EN.calendar.agenda.today)).toBeInTheDocument();
    });

    it('makes every event a link to its record, with its category and status', async () => {
        mount();
        await waitFor(() => expect(screen.getByTestId('calendar-agenda')).toBeInTheDocument());
        const later = screen.getAllByTestId('calendar-agenda-day')[1];
        const links = within(later).getAllByRole('link');
        expect(links.map((l) => l.getAttribute('href')).sort()).toEqual([
            '/t/acme-corp/tasks/also-later',
            '/t/acme-corp/tasks/later',
        ]);
        expect(within(later).getByText('Deadline later', { exact: false })).toBeInTheDocument();
        expect(later).toHaveTextContent(EN.calendar.category.evidence);
    });

    it('reveals the earlier days of the month on request', async () => {
        mount();
        await waitFor(() => expect(screen.getByTestId('calendar-agenda')).toBeInTheDocument());
        const earlier = screen.getByTestId('calendar-agenda-earlier');
        expect(earlier).toHaveAttribute('aria-expanded', 'false');
        await act(async () => { fireEvent.click(earlier); });
        expect(agendaDays()).toEqual(['2026-06-03', '2026-06-10', '2026-06-12']);
    });

    it('pages by month from the agenda', async () => {
        mount();
        await waitFor(() => expect(screen.getByTestId('calendar-agenda')).toBeInTheDocument());
        const nav = document.getElementById('calendar-month-nav')!;
        await act(async () => {
            fireEvent.click(within(nav).getByRole('button', { name: EN.calendar.nextMonth }));
        });
        expect(replaceMock.mock.calls.at(-1)![0]).toContain('month=2026-07');
    });

    it('folds the category filter behind one button, so the list starts on the first screen', async () => {
        mount();
        await waitFor(() => expect(screen.getByTestId('calendar-agenda')).toBeInTheDocument());
        const toggle = document.getElementById('calendar-filter-toggle')!;
        // The fold is CSS, so the server's paint is already folded on a phone.
        expect(toggle.className.split(' ')).toContain('md:hidden');
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        const group = document.getElementById('calendar-filter-group')!;
        expect(group.className.split(' ')).toContain('max-md:hidden');
        await act(async () => { fireEvent.click(toggle); });
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(group.className.split(' ')).not.toContain('max-md:hidden');
        expect(group.querySelectorAll('[role="checkbox"]').length).toBeGreaterThan(0);
    });

    it('offers the agenda and the month grid, and the grid is one tap away', async () => {
        mount();
        await waitFor(() => expect(screen.getByTestId('calendar-agenda')).toBeInTheDocument());
        const views = screen.getByRole('radiogroup', { name: EN.calendar.viewAria });
        const options = within(views).getAllByRole('radio').map((r) => r.textContent);
        expect(options).toEqual([EN.calendar.agenda.view, EN.calendar.viewMonth]);
        await act(async () => {
            fireEvent.click(within(views).getByRole('radio', { name: EN.calendar.viewMonth }));
        });
        // On a phone the month grid is not the default, so it is written down.
        expect(replaceMock.mock.calls.at(-1)![0]).toContain('view=month');
    });
});

describe('calendar from md up', () => {
    beforeEach(() => setViewport(false));

    it('keeps the month grid as the default and the three views it had', async () => {
        const { container } = mount();
        await waitFor(() =>
            expect(container.querySelector('[data-testid="calendar-month"]')).toBeTruthy(),
        );
        expect(screen.queryByTestId('calendar-agenda')).toBeNull();
        const views = screen.getByRole('radiogroup', { name: EN.calendar.viewAria });
        expect(within(views).getAllByRole('radio').map((r) => r.textContent)).toEqual([
            EN.calendar.viewMonth,
            EN.calendar.viewHeatmap,
            EN.calendar.viewTimeline,
        ]);
    });

    it('still opens an agenda named in a shared link', async () => {
        currentSearch = 'month=2026-06&view=agenda';
        mount();
        await waitFor(() => expect(screen.getByTestId('calendar-agenda')).toBeInTheDocument());
    });
});
