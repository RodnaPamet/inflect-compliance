/**
 * Behavioural test — `<DataTable>` renders a spanning column-GROUP header
 * (TanStack grouped column defs) in the non-virtualized `<table>` path.
 * This is the mechanism behind the Evidence table's "Actions" header that
 * spans its four right-most icon/action columns (edit/archive/download/
 * submit). The virtualized CSS-grid header can't colSpan, so grouped
 * headers require `virtualize={false}` (which Evidence sets).
 */
import * as React from 'react';
import { render } from '@testing-library/react';
import { DataTable, createColumns } from '@/components/ui/table';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/things',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

interface Row {
    id: string;
    name: string;
}

const rows: Row[] = [
    { id: 'r0', name: 'Alpha' },
    { id: 'r1', name: 'Beta' },
];

// A flat name column + four "action" leaf columns grouped under "Actions".
const columns = createColumns<Row>([
    { accessorKey: 'name', header: 'Name' },
    {
        id: 'actionsGroup',
        header: 'Actions',
        columns: [
            { id: 'edit', header: '', cell: () => <span>e</span>, enableHiding: false },
            { id: 'archive', header: '', cell: () => <span>a</span>, enableHiding: false },
            { id: 'download', header: '', cell: () => <span>d</span>, enableHiding: false },
            { id: 'submit', header: '', cell: () => <span>s</span>, enableHiding: false },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
]);

describe('<DataTable> grouped (spanning) header', () => {
    it('renders the group header text and spans its leaf columns via colSpan', () => {
        const { container, getAllByText } = render(
            <DataTable<Row>
                data={rows}
                columns={columns}
                getRowId={(r) => r.id}
                virtualize={false}
            />,
        );
        // The "Actions" group header is present...
        expect(getAllByText('Actions').length).toBeGreaterThan(0);
        // ...and rendered as a header cell spanning the 4 leaf columns.
        const spanning = Array.from(container.querySelectorAll('th')).find(
            (th) => th.getAttribute('colspan') === '4',
        );
        expect(spanning).toBeTruthy();
        expect(spanning?.textContent).toContain('Actions');
    });

    it('produces a two-row header (group row + leaf row)', () => {
        const { container } = render(
            <DataTable<Row>
                data={rows}
                columns={columns}
                getRowId={(r) => r.id}
                virtualize={false}
            />,
        );
        const headerRows = container.querySelectorAll('thead tr');
        expect(headerRows.length).toBe(2);
    });

    it('still renders every leaf cell in the body', () => {
        const { container } = render(
            <DataTable<Row>
                data={rows}
                columns={columns}
                getRowId={(r) => r.id}
                virtualize={false}
            />,
        );
        const bodyRows = container.querySelectorAll('tbody tr');
        expect(bodyRows.length).toBe(2);
        // name + 4 action leaves (+ the default select column) per row.
        const firstRowCells = bodyRows[0].querySelectorAll('td');
        expect(firstRowCells.length).toBeGreaterThanOrEqual(5);
    });
});
