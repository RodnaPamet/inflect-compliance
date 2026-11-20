/**
 * `<FilterToolbar>` must not write the URL for a search that did not change.
 *
 * `FilterSelect` used to report its search value when it mounted, even an
 * empty, untouched one, and the toolbar turned that report into a
 * `router.replace` 250 ms later. A no-op replace issued while a navigation
 * the person started is in flight cancels that navigation: a command-palette
 * "Go to Inbox" from a list page failed several times in twelve, and never
 * from a page without the toolbar. These tests assert at the seam that
 * writes the URL (`router.replace`).
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

const replace = jest.fn();

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace,
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/controls',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { CheckCircle } from 'lucide-react';

import { FilterToolbar } from '@/components/filters/FilterToolbar';
import {
    createFilterDefs,
    FilterProvider,
    useFilterContext,
    useFilters,
} from '@/components/ui/filter';

const { filters: defs, filterKeys } = createFilterDefs({
    status: {
        label: 'Status',
        icon: CheckCircle,
        options: [{ value: 'A', label: 'A' }],
    },
});

function SearchProbe() {
    const { search } = useFilters();
    return <output data-testid="committed-search">{search}</output>;
}

function Shell() {
    const ctx = useFilterContext(defs, filterKeys);
    return (
        <FilterProvider value={ctx}>
            <FilterToolbar
                filters={defs}
                searchId="probe-search"
                searchPlaceholder="Search…"
            />
            <SearchProbe />
        </FilterProvider>
    );
}

async function openSearchInput(): Promise<HTMLInputElement> {
    const trigger = document.querySelector('[data-filter-trigger]') as HTMLElement;
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger);
    await waitFor(() => {
        expect(document.querySelector('#probe-search input')).not.toBeNull();
    });
    return document.querySelector('#probe-search input') as HTMLInputElement;
}

describe('FilterToolbar — no URL write for an unchanged search', () => {
    beforeEach(() => {
        replace.mockClear();
        window.history.replaceState(null, '', '/t/acme/controls');
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('mounting with an empty search writes nothing to the URL', async () => {
        render(<Shell />);
        await act(async () => {
            await jest.advanceTimersByTimeAsync(1000);
        });
        expect(replace).not.toHaveBeenCalled();
    });

    it('mounting with a search already in the URL writes nothing', async () => {
        window.history.replaceState(null, '', '/t/acme/controls?q=iso');
        render(<Shell />);
        expect(screen.getByTestId('committed-search').textContent).toBe('iso');
        await act(async () => {
            await jest.advanceTimersByTimeAsync(1000);
        });
        expect(replace).not.toHaveBeenCalled();
    });

    it('opening and closing the dropdown without typing writes nothing', async () => {
        render(<Shell />);
        await openSearchInput();
        fireEvent.keyDown(document.querySelector('#probe-search input') as HTMLElement, {
            key: 'Escape',
        });
        await act(async () => {
            await jest.advanceTimersByTimeAsync(1000);
        });
        expect(replace).not.toHaveBeenCalled();
    });

    it('a search typed and then restored before the debounce writes nothing', async () => {
        render(<Shell />);
        const input = await openSearchInput();
        fireEvent.change(input, { target: { value: 'iso' } });
        fireEvent.change(input, { target: { value: '' } });
        await act(async () => {
            await jest.advanceTimersByTimeAsync(1000);
        });
        expect(screen.getByTestId('committed-search').textContent).toBe('');
        expect(replace).not.toHaveBeenCalled();
    });

    it('a real change still debounces and writes exactly once', async () => {
        render(<Shell />);
        const input = await openSearchInput();
        fireEvent.change(input, { target: { value: 'iso' } });
        await act(async () => {
            await jest.advanceTimersByTimeAsync(249);
        });
        expect(replace).not.toHaveBeenCalled();
        await act(async () => {
            await jest.advanceTimersByTimeAsync(1);
        });
        expect(replace).toHaveBeenCalledTimes(1);
        expect(replace).toHaveBeenCalledWith('/t/acme/controls?q=iso', { scroll: false });
        await act(async () => {
            await jest.advanceTimersByTimeAsync(1000);
        });
        expect(replace).toHaveBeenCalledTimes(1);
    });
});
