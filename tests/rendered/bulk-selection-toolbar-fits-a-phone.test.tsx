/**
 * The bulk-selection toolbar fits a phone, and Apply is reachable on it.
 *
 * As one non-wrapping `h-9` row the bar was ~408px wide at 390: Apply and the
 * action picker were cut off by the shell's horizontal clip, with no way to
 * scroll to them, so bulk actions could not be used on a phone at all. And on
 * the card list the bar sat over the TOP of the list, off-screen by the time a
 * card further down was ticked.
 *
 * Below md the bar is now two rows (count and Clear; then the controls across
 * the whole width), docked to the bottom of the screen over the card list and
 * padded clear of the home indicator. Desktop keeps its single overlay row.
 *
 * jsdom applies no stylesheet, so the classes that PRODUCE the layout are
 * asserted, read off the rendered elements.
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

let mockBelowMd = false;
jest.mock('@/components/ui/table/use-is-below-md', () => ({
    useIsBelowMd: () => mockBelowMd,
}));

import { DataTable, createColumns } from '@/components/ui/table';
import { BulkActionBar, type BulkActionDef } from '@/components/ui/bulk-action-bar';

interface Row {
    id: string;
    name: string;
}

const columns = createColumns<Row>([{ id: 'name', header: 'Name', accessorKey: 'name' }]);
const data: Row[] = [
    { id: 'r1', name: 'First' },
    { id: 'r2', name: 'Second' },
];

const NO_VALUE: BulkActionDef[] = [{ value: 'archive', label: 'Archive' }];
const WITH_VALUE: BulkActionDef[] = [
    {
        value: 'status',
        label: 'Change status',
        renderInput: () => <button type="button" data-testid="status-input">Status</button>,
    },
];

const classesOf = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);

function renderTable(actions: BulkActionDef[] = NO_VALUE) {
    return render(
        <DataTable<Row>
            data={data}
            columns={columns}
            getRowId={(r) => r.id}
            selectionControls={() => <BulkActionBar actions={actions} onApply={() => undefined} />}
        />,
    );
}

/** Tick the first card on the phone's card list. */
function tickFirstCard() {
    const cards = screen.getByTestId('data-table-cards');
    const box = within(cards).getAllByRole('checkbox')[0]!;
    fireEvent.click(box);
}

beforeEach(() => {
    mockBelowMd = false;
});

describe('on a phone (the card list)', () => {
    beforeEach(() => {
        mockBelowMd = true;
    });

    it('docks the bar at the bottom of the screen, clear of the home indicator, after the cards', () => {
        renderTable();
        tickFirstCard();

        const bar = screen.getByTestId('selection-toolbar');
        expect(bar.getAttribute('data-placement')).toBe('dock');
        expect(classesOf(bar)).toEqual(
            expect.arrayContaining(['sticky', 'bottom-0', 'pb-[env(safe-area-inset-bottom)]']),
        );
        expect(classesOf(bar)).not.toContain('hidden');
        // Not the desktop overlay over the top of the list.
        expect(classesOf(bar)).not.toContain('absolute');

        // After the list, so it comes to rest below the last card, not over it.
        const cards = screen.getByTestId('data-table-cards');
        expect(cards.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('takes no space in the flow while nothing is selected', () => {
        renderTable();
        expect(classesOf(screen.getByTestId('selection-toolbar'))).toContain('hidden');
    });

    it('wraps onto two rows: count and Clear, then the controls across the whole width', () => {
        renderTable();
        tickFirstCard();

        const bar = screen.getByTestId('selection-toolbar');
        const row = bar.querySelector('[data-selection-toolbar-row]');
        expect(classesOf(row)).toEqual(expect.arrayContaining(['flex-wrap', 'md:flex-nowrap']));
        expect(classesOf(row)).not.toContain('h-9');

        const controls = bar.querySelector('[data-selection-toolbar-controls]');
        expect(classesOf(controls)).toContain('basis-full');
        expect(controls!.contains(document.getElementById('bulk-apply-btn'))).toBe(true);

        // Clear is a 44px target on the first row.
        const clear = within(bar).getByRole('button', { name: /clear selection/i });
        expect(classesOf(clear)).toContain('min-h-11');
        expect(controls!.contains(clear)).toBe(false);
    });

    it('gives the picker the row and Apply a 44px labelled button beside it', () => {
        renderTable();
        tickFirstCard();

        const bar = document.querySelector('[data-bulk-action-bar]');
        expect(classesOf(bar)).toEqual(expect.arrayContaining(['w-full', 'flex-wrap']));

        const picker = document.querySelector('[data-bulk-action-picker]');
        expect(classesOf(picker)).toContain('flex-1');
        expect(picker!.contains(document.getElementById('bulk-action-select'))).toBe(true);

        const apply = document.getElementById('bulk-apply-btn')!;
        expect(apply).toHaveAccessibleName('Apply');
        expect(classesOf(apply)).toContain('h-11');
        // The word is VISIBLE on a phone — only `md:` hides it.
        const label = within(apply).getByText('Apply');
        expect(classesOf(label)).toContain('md:sr-only');
        expect(classesOf(label)).not.toContain('sr-only');
    });

    it('gives an action with a value input its own row: picker full width, then the input beside Apply', () => {
        renderTable(WITH_VALUE);
        tickFirstCard();

        // Choose the action so its input renders.
        fireEvent.click(document.getElementById('bulk-action-select')!);
        fireEvent.click(screen.getByRole('option', { name: 'Change status' }));

        const picker = document.querySelector('[data-bulk-action-picker]');
        expect(classesOf(picker)).toContain('basis-full');

        const value = document.querySelector('[data-bulk-action-value]');
        expect(value).not.toBeNull();
        expect(classesOf(value)).toContain('flex-1');
        expect(value!.contains(screen.getByTestId('status-input'))).toBe(true);

        // DOM order picker → value → Apply: focus order is the working order.
        const apply = document.getElementById('bulk-apply-btn')!;
        expect(picker!.compareDocumentPosition(value!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(value!.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});

describe('on desktop (the table)', () => {
    it('keeps the overlay over the header row, one non-wrapping 36px row', () => {
        renderTable();
        const bar = screen.getByTestId('selection-toolbar');
        expect(bar.getAttribute('data-placement')).toBe('overlay');
        expect(classesOf(bar)).toEqual(expect.arrayContaining(['absolute', 'top-0']));
        expect(classesOf(bar)).not.toContain('sticky');

        const row = bar.querySelector('[data-selection-toolbar-row]');
        expect(classesOf(row)).toEqual(expect.arrayContaining(['md:h-9', 'md:flex-nowrap']));
    });

    it('keeps Apply an icon-sized square with its label for assistive tech only', () => {
        renderTable();
        const apply = document.getElementById('bulk-apply-btn')!;
        expect(apply).toHaveAccessibleName('Apply');
        expect(classesOf(apply)).toEqual(expect.arrayContaining(['md:h-8', 'md:w-8', 'md:px-0']));
    });
});
