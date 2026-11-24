/**
 * `<ToggleGroup>` on a phone: labels never wrap, a group wider than its
 * container scrolls (with a cue on the side that has more) instead of being
 * clipped, and below `sm` a group of four or more options is a select.
 *
 * jsdom does no layout, so overflow is simulated by stubbing the group's
 * `scrollWidth` / `clientWidth`, and the breakpoint by mocking the hook.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

const push = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push, replace: jest.fn(), back: jest.fn(),
        forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/risks/hierarchy',
    useSearchParams: () => new URLSearchParams(),
}));

let mockIsMobile = false;
// The group asks for a POSITIVE below-sm match, so the stub answers the
// max-width query with the test's switch and every other query with false.
// The shared setup defines matchMedia writable (not configurable): assign it.
window.matchMedia = ((query: string) => ({
        matches: mockIsMobile && query.includes('max-width'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

import { SELECT_MIN_OPTIONS, ToggleGroup } from '@/components/ui/toggle-group';

const FOUR = [
    { value: 'org', label: 'Организационен' },
    { value: 'process', label: 'Процесен' },
    { value: 'asset', label: 'Активи' },
    { value: 'custom', label: 'Персонализирано' },
];
const THREE = FOUR.slice(0, 3);

function Harness({
    options,
    onSelect,
}: {
    options: typeof FOUR;
    onSelect?: (v: string) => void;
}) {
    const [sel, setSel] = React.useState(options[0].value);
    return (
        <ToggleGroup
            ariaLabel="Hierarchy type"
            options={options}
            selected={sel}
            selectAction={(v) => {
                setSel(v);
                onSelect?.(v);
            }}
        />
    );
}

beforeEach(() => {
    mockIsMobile = false;
    push.mockReset();
});

describe('ToggleGroup — labels and overflow', () => {
    it('an option never wraps its label and never shrinks below it', () => {
        render(<Harness options={FOUR} />);
        for (const radio of screen.getAllByRole('radio')) {
            expect(radio).toHaveClass('whitespace-nowrap', 'shrink-0');
        }
    });

    it('each option is a 44px target on a coarse pointer, a one-word option included', () => {
        // Height and width: an "All" option was 44px tall and 41px wide (#5924).
        render(<Harness options={THREE} />);
        for (const radio of screen.getAllByRole('radio')) {
            expect(radio).toHaveClass('pointer-coarse:min-h-11', 'pointer-coarse:min-w-11');
        }
    });

    it('the group scrolls sideways inside its container rather than overflowing it', () => {
        render(<Harness options={FOUR} />);
        const group = screen.getByRole('radiogroup', { name: 'Hierarchy type' });
        expect(group).toHaveClass('overflow-x-auto', 'max-w-full');
        // The frame around it can shrink in a flex row (min-w-0), so the
        // scroller is what gives — not the page.
        expect(group.parentElement).toHaveClass('min-w-0', 'max-w-full');
    });

    it('selected and unselected options differ in text tone, not by the pill alone', () => {
        render(<Harness options={THREE} />);
        const [first, second] = screen.getAllByRole('radio');
        expect(first).toHaveAttribute('data-selected', 'true');
        expect(second).toHaveAttribute('data-selected', 'false');
        expect(first).toHaveClass('text-content-muted', 'data-[selected=true]:text-content-emphasis');
        const pill = first.querySelector('[data-toggle-pill]');
        expect(pill).toHaveClass('border-border-strong');
    });
});

describe('ToggleGroup — the edge cue', () => {
    function stubOverflow(el: HTMLElement, scrollWidth: number, clientWidth: number) {
        Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
        Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
    }

    it('shows the end cue while there is more to the right, and the start cue once scrolled', () => {
        render(<Harness options={FOUR} />);
        const group = screen.getByRole('radiogroup');
        const frame = group.parentElement!;
        stubOverflow(group, 500, 300);
        // A scroll event re-reads the extent.
        act(() => {
            fireEvent.scroll(group);
        });
        expect(frame.dataset.scrollEnd).toBe('true');
        expect(frame.dataset.scrollStart).toBe('false');

        act(() => {
            group.scrollLeft = 200;
            fireEvent.scroll(group);
        });
        expect(frame.dataset.scrollStart).toBe('true');
        expect(frame.dataset.scrollEnd).toBe('false');

        // The cues are decorative and keyed to those attributes.
        const end = within(frame).getByTestId('toggle-group-cue-end');
        expect(end).toHaveAttribute('aria-hidden', 'true');
        expect(end).toHaveClass('group-data-[scroll-end=true]/toggle:opacity-100');
    });

    it('selecting an option past the edge scrolls it into view inside the group, not the page', () => {
        const scrollIntoView = jest.fn();
        Element.prototype.scrollIntoView = scrollIntoView;
        render(<Harness options={FOUR} />);
        const group = screen.getByRole('radiogroup');
        stubOverflow(group, 500, 200);
        const last = screen.getByRole('radio', { name: 'Персонализирано' });
        Object.defineProperty(last, 'offsetLeft', { configurable: true, value: 400 });
        Object.defineProperty(last, 'offsetWidth', { configurable: true, value: 80 });
        fireEvent.click(last);
        // Its right edge (480) lands on the group's right edge (200 wide).
        expect(group.scrollLeft).toBe(280);
        // `scrollIntoView` would also scroll the PAGE to the group.
        expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('a group that fits shows no cue', () => {
        render(<Harness options={THREE} />);
        const frame = screen.getByRole('radiogroup').parentElement!;
        expect(frame.dataset.scrollEnd).toBe('false');
        expect(frame.dataset.scrollStart).toBe('false');
    });
});

describe('ToggleGroup — below sm', () => {
    it(`a group of ${SELECT_MIN_OPTIONS}+ options renders as a select, and picking one selects it`, async () => {
        mockIsMobile = true;
        const onSelect = jest.fn();
        render(<Harness options={FOUR} onSelect={onSelect} />);
        expect(screen.queryByRole('radiogroup')).toBeNull();
        // The select is loaded on demand (next/dynamic), so it appears a tick later.
        const wrap = await screen.findByTestId('toggle-group-select');
        const trigger = within(wrap).getByRole('combobox', {
            name: 'Hierarchy type: Организационен',
        });
        expect(trigger).toHaveClass('min-h-11');

        const user = userEvent.setup();
        await user.click(trigger);
        await user.click(await screen.findByRole('option', { name: /Персонализирано/ }));
        expect(onSelect).toHaveBeenCalledWith('custom');
        expect(
            within(screen.getByTestId('toggle-group-select')).getByRole('combobox', {
                name: 'Hierarchy type: Персонализирано',
            }),
        ).toBeInTheDocument();
    });

    it('a link-mode option navigates from the select', async () => {
        mockIsMobile = true;
        const options = FOUR.map((o) => ({ ...o, href: `/t/acme/x?view=${o.value}` }));
        render(<ToggleGroup options={options} selected="org" ariaLabel="View" />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('combobox', { name: 'View: Организационен' }));
        await user.click(await screen.findByRole('option', { name: /Активи/ }));
        expect(push).toHaveBeenCalledWith('/t/acme/x?view=asset');
    });

    it('fewer options stay a segmented group even below sm', () => {
        mockIsMobile = true;
        render(<Harness options={THREE} />);
        expect(screen.getByRole('radiogroup')).toBeInTheDocument();
        expect(screen.queryByTestId('toggle-group-select')).toBeNull();
    });
});
