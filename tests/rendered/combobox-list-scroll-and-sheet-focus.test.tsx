/**
 * TWO COMBOBOX GAPS FOUND BY projectZ WHILE VENDORING IT BYTE-IDENTICAL.
 *
 * 1. With the list open, axe reported `scrollable-region-focusable` (serious)
 *    on the div that scrolled around cmdk's `role="listbox"`. No option is
 *    focusable — focus stays in the search box and `aria-activedescendant`
 *    walks the options — and axe exempts exactly that pattern, but only when
 *    the scrolling element IS the combobox's listbox popup. The listbox is now
 *    the scroller (`<ScrollContainer asChild>`).
 *
 *    jsdom has no layout, so axe cannot measure a scroll here. What this pins
 *    is the structure the exemption keys on: the element carrying the overflow
 *    is the `role="listbox"` that the search box's `aria-controls` names.
 *
 * 2. Below md the Combobox is a bottom sheet (vaul), and vaul moves no focus on
 *    open, so focus stayed on the trigger: typed characters went nowhere and
 *    the next Enter re-toggled the trigger. The sheet now opens into its search
 *    box, as the desktop popover does.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

const mockIsMobile = { current: false };
jest.mock('@/components/ui/hooks/use-media-query', () => ({
    useMediaQuery: () => ({
        device: mockIsMobile.current ? ('mobile' as const) : ('desktop' as const),
        width: mockIsMobile.current ? 393 : 1280,
        height: 851,
        isMobile: mockIsMobile.current,
        isTablet: false,
        isDesktop: !mockIsMobile.current,
    }),
}));

import { Combobox, type ComboboxOption } from '@/components/ui/combobox';

const SPORTS: ComboboxOption[] = [
    { value: 'padel', label: 'Padel' },
    { value: 'tennis', label: 'Tennis' },
    { value: 'squash', label: 'Squash' },
];

function Harness({ onPicked }: { onPicked?: (v: string | null) => void }) {
    const [selected, setSelected] = React.useState<ComboboxOption | null>(null);
    return (
        <Combobox
            id="sport"
            options={SPORTS}
            selected={selected}
            setSelected={(o: ComboboxOption | null) => {
                setSelected(o);
                onPicked?.(o?.value ?? null);
            }}
            placeholder="Sport"
        />
    );
}

afterEach(() => {
    mockIsMobile.current = false;
});

describe('Combobox — the option list is the scroller', () => {
    it('puts the overflow on the listbox the search box controls', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.click(screen.getByRole('combobox', { name: 'Sport' }));

        const listbox = await screen.findByRole('listbox');
        expect(listbox.className).toMatch(/\boverflow-y-scroll\b/);
        expect(listbox.className).toMatch(/max-h-\[min\(50vh,250px\)\]/);

        // The search box is the combobox that controls this listbox — the
        // relationship axe's exemption checks.
        const input = document.querySelector('[cmdk-input]');
        expect(input).not.toBeNull();
        expect(input).toHaveAttribute('role', 'combobox');
        expect(input).toHaveAttribute('aria-controls', listbox.id);

        // And no plain element between them scrolls instead.
        expect(listbox.parentElement?.className ?? '').not.toMatch(
            /overflow-y-(scroll|auto)/,
        );
        expect(within(listbox).getAllByRole('option')).toHaveLength(3);
    });
});

describe('Combobox — the phone sheet opens into its search box', () => {
    it('focuses the search input on open, so the keyboard can search and pick', async () => {
        mockIsMobile.current = true;
        const picked = jest.fn();
        const user = userEvent.setup();
        render(<Harness onPicked={picked} />);

        const trigger = screen.getByRole('combobox', { name: 'Sport' });
        trigger.focus();
        await user.keyboard('{Enter}');

        const sheet = await screen.findByRole('dialog');
        expect(sheet).toHaveAttribute('data-popover-drawer');

        const input = sheet.querySelector('[cmdk-input]');
        expect(input).toHaveFocus();

        await user.keyboard('squ{Enter}');
        expect(picked).toHaveBeenCalledWith('squash');
    });

    it('focuses the search input on the desktop popover too', async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await user.click(screen.getByRole('combobox', { name: 'Sport' }));
        await screen.findByRole('listbox');
        expect(document.querySelector('[cmdk-input]')).toHaveFocus();
    });
});
