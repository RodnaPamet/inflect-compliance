/**
 * DataTable expandable rows.
 *
 * A row whose `getRowCanExpand` returns true shows a leading chevron; toggling
 * it renders `renderAlignedSubRows(row, columnIds)` as real `<tr>`/`<td>` rows
 * whose cells align with the parent columns. Default off: without
 * `renderAlignedSubRows` no chevron renders and behaviour is unchanged (so
 * every existing table is unaffected).
 *
 * This file used to drive the same contract through `renderExpandedRow` — a
 * SECOND expansion slot that rendered one full-width `colSpan` cell. It had no
 * consumer in the product (the aligned variant exists precisely because a
 * colSpan cell cannot line up with the columns), so it was two mechanisms and
 * one behaviour. Removed 2026-08-08 (roadmap P3.2); the contract assertions
 * moved here rather than being deleted with it.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";

import { DataTable, createColumns } from "@/components/ui/table";

interface Row {
    id: string;
    name: string;
    owner: string;
}
const columns = createColumns<Row>([
    { id: "name", header: "Name", accessorKey: "name" },
    { id: "owner", header: "Owner", accessorKey: "owner" },
]);
const data: Row[] = [
    { id: "a", name: "Alpha", owner: "Ada" },
    { id: "b", name: "Bravo", owner: "Bo" },
];

/** One sub-row per parent, with a `<td>` per visible column id. */
function subRowsFor(rowId: string, columnIds: string[]) {
    return (
        <tr key={`sub-${rowId}`} data-testid={`exp-${rowId}`}>
            {columnIds.map((columnId) => (
                <td key={columnId} data-column={columnId}>
                    {columnId === "name" ? `tasks for ${rowId}` : ""}
                </td>
            ))}
        </tr>
    );
}

describe("DataTable expandable rows", () => {
    it("renders no chevron when renderAlignedSubRows is absent (default off)", () => {
        render(<DataTable<Row> data={data} columns={columns} getRowId={(r) => r.id} />);
        expect(screen.queryByRole("button", { name: /expand row/i })).toBeNull();
    });

    it("shows a chevron per expandable row and reveals the sub-rows on click", () => {
        render(
            <DataTable<Row>
                data={data}
                columns={columns}
                getRowId={(r) => r.id}
                getRowCanExpand={() => true}
                renderAlignedSubRows={(row, columnIds) =>
                    subRowsFor(row.original.id, columnIds)
                }
            />,
        );
        const chevrons = screen.getAllByRole("button", { name: /expand row/i });
        expect(chevrons).toHaveLength(2);
        // Collapsed initially.
        expect(screen.queryByTestId("exp-a")).toBeNull();
        // Expand row A.
        fireEvent.click(chevrons[0]);
        expect(screen.getByTestId("exp-a")).toBeInTheDocument();
        // Row B stays collapsed.
        expect(screen.queryByTestId("exp-b")).toBeNull();
    });

    it("passes the visible column ids so sub-row cells align with the columns", () => {
        // The whole reason this slot exists rather than a full-width colSpan:
        // the consumer needs one <td> per column, in order, to line up.
        render(
            <DataTable<Row>
                data={data}
                columns={columns}
                getRowId={(r) => r.id}
                getRowCanExpand={() => true}
                renderAlignedSubRows={(row, columnIds) =>
                    subRowsFor(row.original.id, columnIds)
                }
            />,
        );
        fireEvent.click(screen.getAllByRole("button", { name: /expand row/i })[0]);
        const cells = screen
            .getByTestId("exp-a")
            .querySelectorAll("td[data-column]");
        expect([...cells].map((c) => c.getAttribute("data-column"))).toEqual([
            "name",
            "owner",
        ]);
    });

    it("only flags rows allowed by getRowCanExpand", () => {
        render(
            <DataTable<Row>
                data={data}
                columns={columns}
                getRowId={(r) => r.id}
                getRowCanExpand={(row) => row.original.id === "a"}
                renderAlignedSubRows={(row, columnIds) =>
                    subRowsFor(row.original.id, columnIds)
                }
            />,
        );
        expect(screen.getAllByRole("button", { name: /expand row/i })).toHaveLength(1);
    });
});
