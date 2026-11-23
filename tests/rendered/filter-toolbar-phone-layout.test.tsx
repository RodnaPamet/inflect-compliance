/**
 * `<FilterToolbar>` on a phone: the active-filter pills get a row of their
 * own, the icon-button cluster wraps, and "Clear filters" can always be
 * reached — translated, never squeezed, a 44px target on touch.
 *
 * The failure this protects against was silent: the pills sat in a
 * `flex-1 min-w-0` slot between the Filter trigger and the icon buttons,
 * squeezed to ~80px, and "Clear Filters" (an English literal) was clipped to
 * "Clear l" by the shell's `overflow-x-clip`. jsdom does no layout, so the
 * assertions are on the classes that make the wrap happen and on the
 * behaviour of the controls.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), back: jest.fn(),
        forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/risks',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { CheckCircle, User } from 'lucide-react';

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
        multiple: true,
        options: [
            { value: 'OPEN', label: 'Open' },
            { value: 'CLOSED', label: 'Closed' },
        ],
    },
    owner: {
        label: 'Owner',
        icon: User,
        options: [{ value: 'u1', label: 'A very long owner display name that cannot fit' }],
    },
});

function Seed({ active }: { active: boolean }) {
    const { set } = useFilters();
    React.useEffect(() => {
        if (!active) return;
        set('status', 'OPEN');
        set('owner', 'u1');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
}

function StateProbe() {
    const { state } = useFilters();
    return <output data-testid="filter-state">{JSON.stringify(state)}</output>;
}

function Shell({ active }: { active: boolean }) {
    const ctx = useFilterContext(defs, filterKeys);
    return (
        <FilterProvider value={ctx}>
            <Seed active={active} />
            <FilterToolbar
                filters={defs}
                actions={
                    <>
                        <button type="button">Columns</button>
                        <button type="button">Views</button>
                    </>
                }
            />
            <StateProbe />
        </FilterProvider>
    );
}

async function renderShell(active: boolean) {
    render(<Shell active={active} />);
    await act(async () => {});
}

describe('FilterToolbar — phone layout', () => {
    it('the active pills take a full row of their own below md, and the desktop spacer from md', async () => {
        await renderShell(true);
        const slot = screen.getByTestId('filter-toolbar-active');
        // A row of its own on a phone…
        expect(slot).toHaveClass('basis-full', 'order-last', 'min-w-0');
        // …and the flex-1 spacer that right-pins the actions on a desktop.
        expect(slot).toHaveClass('md:flex-1', 'md:order-none');
        expect(slot).not.toHaveClass('hidden');
        expect(within(slot).getByTestId('filter-pill-status')).toBeInTheDocument();
        expect(within(slot).getByTestId('filter-pill-owner')).toBeInTheDocument();
    });

    it('with no active filter the pill row is not laid out below md (no empty gap)', async () => {
        await renderShell(false);
        expect(screen.getByTestId('filter-toolbar-active')).toHaveClass('hidden', 'md:block');
        expect(screen.queryByTestId('filter-list-clear')).toBeNull();
    });

    it('the secondary cluster wraps instead of running off the edge', async () => {
        await renderShell(true);
        const secondary = screen.getByTestId('filter-toolbar-secondary');
        expect(secondary).toHaveClass('flex-wrap', 'max-w-full', 'min-w-0');
    });

    it('a pill fits its row: it can shrink, and its value gives way rather than the remove button', async () => {
        await renderShell(true);
        const pill = screen.getByTestId('filter-pill-owner');
        expect(pill).toHaveClass('max-w-full', 'min-w-0', 'pointer-coarse:min-h-11');
        const remove = within(pill).getByRole('button', { name: 'Remove the Owner filter' });
        expect(remove).toHaveClass('shrink-0', 'pointer-coarse:min-w-11');
        const value = within(pill).getByText(/A very long owner/);
        expect(value).toHaveClass('truncate', 'min-w-0');
    });

    it('"Clear filters" is translated, never squeezed, 44px on touch, and clears every filter', async () => {
        await renderShell(true);
        const clear = screen.getByTestId('filter-list-clear');
        expect(clear).toHaveTextContent('Clear filters');
        expect(clear).not.toHaveTextContent('Clear Filters');
        expect(clear).toHaveClass('shrink-0', 'whitespace-nowrap', 'pointer-coarse:min-h-11');
        // The ESC hint is a keyboard affordance; it is not shown to touch.
        expect(within(clear).getByText('ESC')).toHaveClass('pointer-coarse:hidden');

        expect(screen.getByTestId('filter-state').textContent).toContain('OPEN');
        fireEvent.click(clear);
        await act(async () => {});
        expect(screen.getByTestId('filter-state').textContent).not.toContain('OPEN');
        expect(screen.getByTestId('filter-state').textContent).not.toContain('u1');
    });

    it('every remove button is named, so a pill can be cleared one at a time', async () => {
        await renderShell(true);
        fireEvent.click(screen.getByRole('button', { name: 'Remove the Status filter' }));
        await act(async () => {});
        const state = screen.getByTestId('filter-state').textContent ?? '';
        expect(state).not.toContain('OPEN');
        expect(state).toContain('u1');
    });
});
