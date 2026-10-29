/**
 * The admin Personnel page says what it can do and what it is showing (#4470).
 *
 * Four findings, each pinned here by what a viewer sees:
 *
 *   1. The empty state promised "add a person", and the page cannot add one;
 *      it also named BambooHR alone among the HRIS providers.
 *   2. The roster stopped at 500 with no notice, and the header's count
 *      stopped with it.
 *   3. Status and Source were printed as raw codes (TERMINATED, MANUAL).
 *   4. The page had no search, and its status filter ran over the capped rows
 *      in the browser. Both now go to `GET /personnel`, so a filtered view is
 *      answered from the whole roster.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/personnel',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

import { PersonnelClient, type EmployeeRoster, type EmployeeRow } from '@/app/t/[tenantSlug]/(app)/admin/personnel/PersonnelClient';
import { HRIS_PROVIDERS } from '@/app-layer/integrations/providers/hris';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

const person = (over: Partial<EmployeeRow> = {}): EmployeeRow => ({
    id: 'e-1',
    fullName: 'Ada Lovelace',
    workEmail: 'ada@acme.test',
    status: 'ACTIVE',
    department: null,
    jobTitle: null,
    managerEmployeeId: null,
    source: 'HRIS',
    ...over,
});

const roster = (employees: EmployeeRow[], over: Partial<EmployeeRoster> = {}): EmployeeRoster => ({
    employees,
    truncated: false,
    total: employees.length,
    ...over,
});

/** A fetch whose answer depends on the query string, like the real route. */
function mockFetch(byUrl: (url: string) => EmployeeRoster) {
    global.fetch = jest.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => byUrl(String(url)),
    })) as unknown as typeof fetch;
}

/** Every roster URL this render has asked for. */
const rosterCalls = (): string[] =>
    ((global.fetch as jest.Mock | undefined)?.mock.calls ?? []).map((c) => String(c[0]));

function renderPage(initialRoster: EmployeeRoster, initialFilters: Record<string, string> = {}) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <PersonnelClient initialRoster={initialRoster} initialFilters={initialFilters} tenantSlug="acme" />
        </SWRConfig>,
    );
}

/** Open the Filter popover and return its live content-search input. */
async function openSearch(): Promise<HTMLInputElement> {
    const trigger = document.querySelector('[data-filter-trigger]') as HTMLElement;
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger);
    await waitFor(() => {
        expect(document.querySelector('#personnel-search input')).not.toBeNull();
    });
    return document.querySelector('#personnel-search input') as HTMLInputElement;
}

beforeEach(() => {
    window.history.replaceState({}, '', '/t/acme/admin/personnel');
    mockFetch(() => roster([]));
});

describe('the empty state describes an HRIS-synced roster', () => {
    it('does not offer to add a person, and names no single HRIS', () => {
        renderPage(roster([]));

        expect(screen.getByText(en.personnel.emptyDesc)).toBeInTheDocument();
        expect(screen.queryByText(/add a person/i)).not.toBeInTheDocument();
        for (const text of [en.personnel.emptyDesc, bg.personnel.emptyDesc, en.personnel.description, bg.personnel.description]) {
            for (const provider of HRIS_PROVIDERS) {
                expect(text.toLowerCase()).not.toContain(provider);
            }
        }
        // Neither header line says the page adds people by hand.
        expect(en.personnel.description).not.toMatch(/manual/i);
        expect(bg.personnel.description).not.toMatch(/ръчно/i);
    });
});

describe('the cap is said, and the count is the roster', () => {
    it('shows the truncation notice and the exact total when the read was cut', () => {
        renderPage(roster([person()], { truncated: true, total: 2000 }));

        expect(screen.getByTestId('list-truncation-banner')).toBeInTheDocument();
        expect(screen.getByText('2000 people in the roster, synced from your HRIS.')).toBeInTheDocument();
    });

    it('says nothing about a cap when the roster fits', () => {
        renderPage(roster([person(), person({ id: 'e-2', workEmail: 'bob@acme.test' })]));

        expect(screen.queryByTestId('list-truncation-banner')).not.toBeInTheDocument();
        expect(screen.getByText('2 people in the roster, synced from your HRIS.')).toBeInTheDocument();
    });
});

describe('status and source are words, not codes', () => {
    it('renders the translated labels', () => {
        renderPage(
            roster([
                person({ id: 'e-1', status: 'TERMINATED', source: 'MANUAL' }),
                person({ id: 'e-2', workEmail: 'bob@acme.test', status: 'ONBOARDING', source: 'HRIS' }),
            ]),
        );
        const table = screen.getByRole('table');

        expect(within(table).getByText(en.personnel.filterEnums.status.TERMINATED)).toBeInTheDocument();
        expect(within(table).getByText(en.personnel.filterEnums.status.ONBOARDING)).toBeInTheDocument();
        expect(within(table).getByText(en.personnel.sourceLabels.MANUAL)).toBeInTheDocument();
        expect(within(table).queryByText('TERMINATED')).not.toBeInTheDocument();
        expect(within(table).queryByText('ONBOARDING')).not.toBeInTheDocument();
        expect(within(table).queryByText('MANUAL')).not.toBeInTheDocument();
    });

    it('falls back to the stored value for a code it has no label for', () => {
        renderPage(roster([person({ source: 'IMPORT' })]));
        expect(within(screen.getByRole('table')).getByText('IMPORT')).toBeInTheDocument();
    });
});

describe('search and filter are answered by the server', () => {
    it('the unfiltered page is the server-rendered roster, with no request', () => {
        renderPage(roster([person()]));
        expect(screen.getByText('ada@acme.test')).toBeInTheDocument();
        expect(rosterCalls()).toEqual([]);
    });

    it('has a search box, and sends the typed term to the API', async () => {
        mockFetch((url) =>
            url.includes('q=zoe') ? roster([person({ id: 'z', fullName: 'Zoe', workEmail: 'zoe@acme.test' })]) : roster([]),
        );
        renderPage(roster([person()]));

        const input = await openSearch();
        expect(input.placeholder).toBe(en.personnel.searchPlaceholder);
        fireEvent.change(input, { target: { value: 'zoe' } });

        await waitFor(() => {
            expect(rosterCalls()).toContain('/api/t/acme/personnel?q=zoe');
        });
        // A person who was never in the server-rendered rows is now on screen.
        expect(await screen.findByText('zoe@acme.test')).toBeInTheDocument();
    });

    it('a status filter in the address asks the API, not the capped rows', async () => {
        // The server-rendered roster holds nobody TERMINATED: the leaver is
        // past the cap, which is exactly the case the browser filter missed.
        window.history.replaceState({}, '', '/t/acme/admin/personnel?status=TERMINATED');
        mockFetch((url) =>
            url.includes('status=TERMINATED')
                ? roster([person({ id: 'gone', workEmail: 'gone@acme.test', status: 'TERMINATED' })])
                : roster([]),
        );
        renderPage(roster([person()], { truncated: true, total: 900 }), { status: 'TERMINATED' });

        await waitFor(() => {
            expect(rosterCalls()).toContain('/api/t/acme/personnel?status=TERMINATED');
        });
        expect(await screen.findByText('gone@acme.test')).toBeInTheDocument();
        expect(screen.queryByText('ada@acme.test')).not.toBeInTheDocument();
        // The header still counts the roster, not the filtered view.
        expect(screen.getByText('900 people in the roster, synced from your HRIS.')).toBeInTheDocument();
    });

    it('a failed filtered read says so instead of showing the empty state', async () => {
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 500,
            url: '/api/t/acme/personnel?q=x',
            json: async () => ({ error: { code: 'INTERNAL', message: 'boom' } }),
        })) as unknown as typeof fetch;
        window.history.replaceState({}, '', '/t/acme/admin/personnel?q=x');
        renderPage(roster([person()]), { q: 'x' });

        expect(await screen.findByText(en.personnel.loadError)).toBeInTheDocument();
        expect(screen.queryByText(en.personnel.emptyMatchingTitle)).not.toBeInTheDocument();
    });
});
