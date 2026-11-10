/** @jest-environment jsdom */

/**
 * Behavioural (Tier-2) test — `<DataTable>` column resizing
 * (measure-then-fix).
 *
 * Column resizing is ON by default for the non-virtualized table.
 * The hard part is that `table-layout: fixed` (needed for precise
 * drag-resize) requires an explicit width per column — a uniform
 * default would squish every table. So `Table` renders one
 * auto-layout frame, measures each column's laid-out content width,
 * seeds those widths into TanStack's sizing state, then flips to
 * fixed layout. The structural ratchet (`b2-table-unification`,
 * `datatable-row-double-click`) can only see that the branches
 * exist in source; it cannot prove the measured widths actually
 * reach the rendered `<th>` or that the drag handles mount.
 *
 * jsdom has no layout engine, so `getBoundingClientRect()` returns
 * zeros by default. We stub it to return a DISTINCT width per
 * column (keyed off `data-column-id`) so we can assert the seed
 * landed: a wide "name" column and a narrow "code" column must end
 * up with DIFFERENT explicit widths — i.e. the table did NOT
 * collapse to a uniform width.
 */

import { render } from '@testing-library/react';
import * as React from 'react';

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

interface ThingRow {
    id: string;
    code: string;
    name: string;
}

const rows: ThingRow[] = [
    { id: 'r0', code: 'C-1', name: 'A very long descriptive name here' },
    { id: 'r1', code: 'C-2', name: 'Another long name' },
];

const columns = createColumns<ThingRow>([
    { accessorKey: 'code', header: 'Code' },
    { accessorKey: 'name', header: 'Name' },
]);

/** Per-column stub widths the "browser" would have laid out. */
const MEASURED: Record<string, number> = { code: 90, name: 320 };

let originalGBCR: typeof HTMLElement.prototype.getBoundingClientRect;

beforeAll(() => {
    originalGBCR = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (
        this: HTMLElement,
    ): DOMRect {
        const id = this.dataset?.columnId;
        const width = id && MEASURED[id] !== undefined ? MEASURED[id] : 120;
        return {
            width,
            height: 40,
            top: 0,
            left: 0,
            right: width,
            bottom: 40,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        } as DOMRect;
    };
});

afterAll(() => {
    HTMLElement.prototype.getBoundingClientRect = originalGBCR;
});

// Column resizing is OPT-IN now (DataTable defaults it OFF as of
// 2026-06-04 — shelved because the fixed layout it requires caused a
// horizontal scrollbar). These tests pass `enableColumnResizing`
// explicitly to verify the feature still works when a table opts in.
describe('<DataTable> column resizing — behavioural (Tier 2)', () => {
    it('seeds each column its measured content width and switches to fixed layout', () => {
        const { container } = render(
            <DataTable<ThingRow>
                data={rows}
                columns={columns}
                getRowId={(r) => r.id}
                enableColumnResizing
            />,
        );

        // After mount the measure-then-fix pass has run: the table is
        // in fixed layout so columns honour their seeded widths.
        const table = container.querySelector('table') as HTMLTableElement;
        expect(table).not.toBeNull();
        expect(table.style.tableLayout).toBe('fixed');

        // The two content columns must carry DIFFERENT explicit widths
        // matching the measured values — proving the seed reached the
        // DOM and the table did NOT collapse to a uniform width.
        const codeTh = container.querySelector(
            'th[data-column-id="code"]',
        ) as HTMLElement;
        const nameTh = container.querySelector(
            'th[data-column-id="name"]',
        ) as HTMLElement;
        expect(codeTh.style.width).toBe('90px');
        expect(nameTh.style.width).toBe('320px');
    });

    it('names its layout on the table, so a cell can cap its width only while columns are measured', () => {
        const resizable = render(
            <DataTable<ThingRow>
                data={rows}
                columns={columns}
                getRowId={(r) => r.id}
                enableColumnResizing
            />,
        );
        expect(resizable.container.querySelector('table')?.getAttribute('data-layout')).toBe('fixed');
        resizable.unmount();

        const plain = render(
            <DataTable<ThingRow> data={rows} columns={columns} getRowId={(r) => r.id} />,
        );
        expect(plain.container.querySelector('table')?.getAttribute('data-layout')).toBe('auto');
    });

    it('mounts a drag handle on every resizable (non-utility) column', () => {
        const { container } = render(
            <DataTable<ThingRow>
                data={rows}
                columns={columns}
                getRowId={(r) => r.id}
                enableColumnResizing
            />,
        );
        // The resize handle is the `cursor-col-resize` grip rendered in
        // each non-utility header cell. Two content columns ⇒ two grips
        // (the select utility column gets none).
        const handles = container.querySelectorAll('.cursor-col-resize');
        expect(handles.length).toBe(2);
    });

    it('does NOT enable resizing on a virtualized table (would collapse its grid)', () => {
        // VirtualTable reads getSize() straight into its grid template
        // with no measure step, so resizing is force-disabled above the
        // virtualization threshold. Force virtualization on and assert
        // no resize grips render.
        const many: ThingRow[] = Array.from({ length: 20 }, (_, i) => ({
            id: `v${i}`,
            code: `C-${i}`,
            name: `Name ${i}`,
        }));
        const { container } = render(
            <DataTable<ThingRow>
                data={many}
                columns={columns}
                getRowId={(r) => r.id}
                virtualize
            />,
        );
        const handles = container.querySelectorAll('.cursor-col-resize');
        expect(handles.length).toBe(0);
    });
});
