/** @jest-environment jsdom */

/**
 * `<DataTable>` scroll container — no CSS scroll-snap, contained overscroll.
 *
 * The table's scroll wrapper used to carry `snap-y snap-proximity
 * scroll-pt-[37px]` with `snap-start` on EVERY row. Rows are ~37-45px tall,
 * so that put a snap target every few dozen pixels and the browser
 * re-evaluated the nearest one continuously through a momentum scroll — the
 * list grabbed and settled instead of scrolling freely. The `scroll-pt-[37px]`
 * padding did not even match the real sticky-header height (~45px), so a
 * snapped row landed under the header: the alignment the snap existed for.
 *
 * These assertions read the RENDERED DOM rather than grepping source, so they
 * survive a refactor of how the class string is composed — a source regex
 * would pass the moment someone moved the classes into a cva variant or a
 * shared constant.
 *
 * This is the shared primitive, so it governs every list page in the app.
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

interface Row {
    id: string;
    name: string;
}

const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
    id: `r${i}`,
    name: `Row ${i}`,
}));

const columns = createColumns<Row>([{ accessorKey: 'name', header: 'Name' }]);

/** Tailwind scroll-snap utilities, in any axis/strictness combination. */
const SNAP_CLASS = /\bsnap-(?:x|y|both|mandatory|proximity|start|end|center|align-none|normal|always)\b/;

describe('DataTable scroll container', () => {
    it('does not scroll-snap the wrapper', () => {
        const { container } = render(
            <DataTable fillBody data={rows} columns={columns} getRowId={(r) => r.id} />,
        );
        const wrapper = container.querySelector('[role="region"]');
        expect(wrapper).not.toBeNull();
        expect(wrapper!.className).not.toMatch(SNAP_CLASS);
    });

    it('does not make rows snap points', () => {
        const { container } = render(
            <DataTable fillBody data={rows} columns={columns} getRowId={(r) => r.id} />,
        );
        const bodyRows = container.querySelectorAll('tbody tr');
        expect(bodyRows.length).toBeGreaterThan(0);
        for (const tr of Array.from(bodyRows)) {
            expect(tr.className).not.toMatch(SNAP_CLASS);
        }
    });

    it('contains overscroll so reaching an end does not scroll the page behind it', () => {
        const { container } = render(
            <DataTable fillBody data={rows} columns={columns} getRowId={(r) => r.id} />,
        );
        const wrapper = container.querySelector('[role="region"]');
        expect(wrapper!.className).toContain('overscroll-contain');
    });

    it('does not transition layout-invalidating table properties', () => {
        // `transition-[border-spacing,margin-top]` on the <table> never ran
        // (neither property changes) but marked it animatable on properties
        // whose change invalidates the whole table layout.
        const { container } = render(
            <DataTable fillBody data={rows} columns={columns} getRowId={(r) => r.id} />,
        );
        const table = container.querySelector('table');
        expect(table).not.toBeNull();
        expect(table!.className).not.toMatch(/transition-\[[^\]]*border-spacing/);
    });
});
