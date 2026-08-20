/** @jest-environment jsdom */

/**
 * #101 — the standard table row is memoized, and the memo actually bites.
 *
 * `ResizableTableRow` only mounts when `enableColumnResizing && sizingFrozen`,
 * and column resizing has been default-off since 2026-06-04. So before
 * `TableBodyRow` existed, EVERY production table re-rendered every `<tr>`,
 * every `<td>` and every consumer cell renderer on any ancestor re-render —
 * across the whole accumulated row set, which load-on-scroll grows past 400
 * on the heavy list pages. The memo'd row component that was supposed to
 * prevent that was unreachable dead code.
 *
 * These tests count CONSUMER CELL RENDERS, because that is the expensive
 * thing and the thing a user feels. Counting `<tr>` elements in the DOM
 * would not move whether or not the memo works.
 *
 * The load-bearing detail is that the parent must re-render for its OWN
 * reason while the table's data is unchanged — that is the real scenario
 * (a filter panel opening, a toast appearing, a sibling's state changing).
 * Re-rendering a stable element reference instead lets React bail out above
 * the table entirely, which would make this pass with no memo at all.
 */

import * as React from "react";
import { render, act, fireEvent } from "@testing-library/react";

jest.mock("next/navigation", () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => "/t/acme/things",
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: "acme" }),
}));

import { DataTable, createColumns } from "@/components/ui/table";

interface Thing {
    id: string;
    name: string;
}

const ROWS: Thing[] = Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`,
    name: `Item ${i}`,
}));

let cellRenders = 0;
const columns = createColumns<Thing>([
    {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => {
            cellRenders += 1;
            return <span>{row.original.name}</span>;
        },
    },
]);

/** Parent that re-renders for its own reason, table data untouched. */
function Harness({ rows = ROWS }: { rows?: Thing[] }) {
    const [tick, setTick] = React.useState(0);
    return (
        <div>
            <button type="button" onClick={() => setTick((v) => v + 1)}>
                bump {tick}
            </button>
            <DataTable<Thing>
                data={rows}
                columns={columns}
                getRowId={(r) => r.id}
                selectionEnabled={false}
            />
        </div>
    );
}

describe("DataTable — body rows are memoized (#101)", () => {
    it("does not re-render consumer cells when the parent re-renders with unchanged rows", () => {
        cellRenders = 0;
        const { getByRole } = render(<Harness />);
        expect(cellRenders).toBe(ROWS.length); // initial paint

        // fireEvent inside act(), NOT node.click() — a bare .click() does
        // not flush the state update here, so the table subtree never
        // re-renders and the assertion below passes with no memo at all.
        // Assert the parent really did re-render before trusting the count.
        const bump = getByRole("button", { name: /bump/ });
        act(() => { fireEvent.click(bump); });
        act(() => { fireEvent.click(bump); });
        act(() => { fireEvent.click(bump); });
        expect(bump.textContent).toContain("3");

        // Three ancestor re-renders, zero additional cell work.
        expect(cellRenders).toBe(ROWS.length);
    });

    it("still repaints when the row data actually changes", () => {
        cellRenders = 0;
        const { rerender } = render(<Harness />);
        expect(cellRenders).toBe(ROWS.length);

        // The memo must not be so sticky that real changes are swallowed —
        // a stale row is far worse than a slow one.
        const changed = ROWS.map((r) =>
            r.id === "r2" ? { ...r, name: "RENAMED" } : r,
        );
        rerender(<Harness rows={changed} />);

        expect(cellRenders).toBeGreaterThan(ROWS.length);
    });
});
