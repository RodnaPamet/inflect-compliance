/** @jest-environment jsdom */

/**
 * Enter in a filter's option search applies nothing when nothing matches
 * (#5309).
 *
 * On Filter → Status, typing "xyz" (no option matches; "No matching options"
 * is shown) and pressing Enter set `status=xyz` — a value the picker never
 * offered, sent to an API that takes an enum. Enter still picks the typed text
 * for a FREE-TEXT filter (one with no option list), where it is the offered
 * row.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/risks',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { CheckCircle } from 'lucide-react';

import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { createFilterDefs, FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';

const { filters: defs, filterKeys } = createFilterDefs({
    status: {
        label: 'Status',
        icon: CheckCircle,
        options: [
            { value: 'OPEN', label: 'Open' },
            { value: 'CLOSED', label: 'Closed' },
        ],
    },
    owner: {
        label: 'Owner',
        icon: CheckCircle,
        options: [],
    },
});

function StateProbe() {
    const { state } = useFilters();
    return <output data-testid="filter-state">{JSON.stringify(state)}</output>;
}

function Shell() {
    const ctx = useFilterContext(defs, filterKeys);
    return (
        <FilterProvider value={ctx}>
            <FilterToolbar filters={defs} searchId="probe-search" searchPlaceholder="Search risks…" />
            <StateProbe />
        </FilterProvider>
    );
}

async function openFilter(label: string): Promise<HTMLInputElement> {
    fireEvent.click(document.querySelector('[data-filter-trigger]') as HTMLElement);
    fireEvent.click(await screen.findByText(label));
    await waitFor(() => expect(document.querySelector('[cmdk-input]')).not.toBeNull());
    return document.querySelector('[cmdk-input]') as HTMLInputElement;
}

const state = () => JSON.parse(screen.getByTestId('filter-state').textContent || '{}') as Record<string, string[]>;

describe('FilterSelect — Enter with no matching option', () => {
    it('applies nothing on a filter that has options', async () => {
        render(<Shell />);
        const input = await openFilter('Status');
        fireEvent.change(input, { target: { value: 'xyz' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(state().status ?? []).toEqual([]);
    });

    it('still applies the typed text on a free-text filter', async () => {
        render(<Shell />);
        const input = await openFilter('Owner');
        fireEvent.change(input, { target: { value: 'alice' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(state().owner).toEqual(['alice']));
    });
});
