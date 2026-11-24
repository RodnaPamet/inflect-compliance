/**
 * A phone card's title is ONE tap target, and a reachable one.
 *
 * Below `md` a `<DataTable>` renders each row as a card. The title cell is
 * the page's own: a `<TableTitleCell href>` link (Risks, Policies, Vendors,
 * the org drill-downs) or a `<TableTitleButton>` quick-view trigger
 * (Controls, Tasks, Assets). As an inline link it was a 17-20px target, and
 * on a card that is itself a button (`onRowClick`) it was also an interactive
 * element inside an interactive element: two tab stops and a small target on
 * top of a large one that did something else.
 *
 * The invariant, both halves:
 *
 *   - a CLICKABLE card holds no link and no button in its title — the title
 *     is text with the same words, and a tap on it does what the card does;
 *   - a card that does NOT open on a tap keeps the title's own action, and
 *     the link or button wears the shared 44px touch hit area.
 *
 * Every negative assertion is paired with a positive one (the title text is
 * there, the card is a button, the action fires), so a title that stopped
 * rendering cannot pass. The desktop table is the control: nothing changes
 * there.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

let mockBelowMd = true;
jest.mock('@/components/ui/table/use-is-below-md', () => ({
    useIsBelowMd: () => mockBelowMd,
}));

import { DataTable, createColumns } from '@/components/ui/table';
import { TableTitleButton, TableTitleCell } from '@/components/ui/table-title-cell';
import { TOUCH_HIT_AREA_CLASS } from '@inflect/ui/components/ui/hit-area';

interface Row {
    id: string;
    name: string;
    status: string;
}

const data: Row[] = [
    { id: 'r1', name: 'Alpha control', status: 'OPEN' },
    { id: 'r2', name: 'Beta control', status: 'CLOSED' },
];

const linkColumns = createColumns<Row>([
    {
        id: 'name',
        header: 'Name',
        accessorKey: 'name',
        cell: ({ row }) => (
            <TableTitleCell href={`/things/${row.original.id}`} testId={`title-${row.original.id}`}>
                {row.original.name}
            </TableTitleCell>
        ),
    },
    { id: 'status', header: 'Status', accessorKey: 'status' },
]);

function buttonColumns(onTitle: (id: string) => void) {
    return createColumns<Row>([
        {
            id: 'name',
            header: 'Name',
            accessorKey: 'name',
            cell: ({ row }) => (
                <TableTitleButton onClick={() => onTitle(row.original.id)} testId={`title-${row.original.id}`}>
                    {row.original.name}
                </TableTitleButton>
            ),
        },
        { id: 'status', header: 'Status', accessorKey: 'status' },
    ]);
}

function cardTitle(rowId: string): HTMLElement {
    const card = document.querySelector(`[data-row-id="${rowId}"]`) as HTMLElement;
    expect(card).not.toBeNull();
    return within(card).getByTestId('data-table-card-title');
}

function expectTouchHitArea(el: HTMLElement) {
    const cls = el.className.split(/\s+/);
    for (const token of TOUCH_HIT_AREA_CLASS.split(/\s+/)) expect(cls).toContain(token);
    expect(cls).toContain('relative');
    // `overflow: hidden` would clip the hit area back to the text.
    expect(cls).not.toContain('truncate');
}

beforeEach(() => {
    mockBelowMd = true;
});

describe('a clickable card has one target: its title is text', () => {
    it('a link title renders as text, and a tap on it opens the row', () => {
        const onRowClick = jest.fn();
        render(<DataTable<Row> data={data} columns={linkColumns} getRowId={(r) => r.id} onRowClick={onRowClick} />);

        const title = cardTitle('r1');
        expect(title.textContent).toContain('Alpha control');
        expect(title.querySelector('a, button, [role="button"], [role="link"], [tabindex]')).toBeNull();

        const card = document.querySelector('[data-row-id="r1"]') as HTMLElement;
        expect(card.getAttribute('role')).toBe('button');
        fireEvent.click(screen.getByTestId('title-r1'));
        expect(onRowClick).toHaveBeenCalledTimes(1);
        expect(onRowClick.mock.calls[0][0].id).toBe('r1');
    });

    it('a quick-view title renders as text; a tap opens the row, not the quick-view', () => {
        const onRowClick = jest.fn();
        const onTitle = jest.fn();
        render(
            <DataTable<Row> data={data} columns={buttonColumns(onTitle)} getRowId={(r) => r.id} onRowClick={onRowClick} />,
        );

        const title = cardTitle('r2');
        expect(title.textContent).toContain('Beta control');
        expect(title.querySelector('a, button, [role="button"], [role="link"], [tabindex]')).toBeNull();

        fireEvent.click(screen.getByTestId('title-r2'));
        expect(onRowClick).toHaveBeenCalledTimes(1);
        expect(onTitle).not.toHaveBeenCalled();
    });
});

describe('a card that does not open on a tap keeps the title action, at 44px', () => {
    it('a link title is a link wearing the touch hit area', () => {
        render(<DataTable<Row> data={data} columns={linkColumns} getRowId={(r) => r.id} />);

        const link = within(cardTitle('r1')).getByRole('link', { name: 'Alpha control' });
        expect(link).toHaveAttribute('href', '/things/r1');
        expectTouchHitArea(link);
    });

    it('a quick-view title is a button wearing the touch hit area, and still acts', () => {
        const onTitle = jest.fn();
        render(<DataTable<Row> data={data} columns={buttonColumns(onTitle)} getRowId={(r) => r.id} />);

        const button = within(cardTitle('r1')).getByRole('button', { name: 'Alpha control' });
        expectTouchHitArea(button);
        fireEvent.click(button);
        expect(onTitle).toHaveBeenCalledWith('r1');
    });
});

describe('an identifying link below the title is reached too', () => {
    it('a TableTitleCell link in the second field wears the hit area', () => {
        // The org drill-downs lead with the workspace, so the control's link
        // is the card's second field, not its title.
        const columns = createColumns<Row>([
            { id: 'status', header: 'Status', accessorKey: 'status' },
            {
                id: 'name',
                header: 'Name',
                accessorKey: 'name',
                cell: ({ row }) => (
                    <TableTitleCell href={`/things/${row.original.id}`}>{row.original.name}</TableTitleCell>
                ),
            },
        ]);
        render(<DataTable<Row> data={data} columns={columns} getRowId={(r) => r.id} />);
        const card = document.querySelector('[data-row-id="r1"]') as HTMLElement;
        expect(within(cardTitle('r1')).queryByRole('link')).toBeNull();
        const link = within(card).getByRole('link', { name: 'Alpha control' });
        expectTouchHitArea(link);
    });
});

describe('the desktop table is unchanged (the control)', () => {
    it('keeps the title link and the truncating quick-view button, with no hit area', () => {
        mockBelowMd = false;
        const onTitle = jest.fn();
        const { unmount } = render(
            <DataTable<Row> data={data} columns={linkColumns} getRowId={(r) => r.id} onRowClick={() => {}} />,
        );
        const link = screen.getByTestId('title-r1');
        expect(link.tagName).toBe('A');
        expect(link.className).not.toContain('pointer-coarse:after:min-h-11');
        unmount();

        render(
            <DataTable<Row> data={data} columns={buttonColumns(onTitle)} getRowId={(r) => r.id} onRowClick={() => {}} />,
        );
        const button = screen.getByTestId('title-r1');
        expect(button.tagName).toBe('BUTTON');
        expect(button.className.split(/\s+/)).toContain('truncate');
        fireEvent.click(button);
        expect(onTitle).toHaveBeenCalledWith('r1');
    });
});
