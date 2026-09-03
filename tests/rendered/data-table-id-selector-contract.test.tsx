/**
 * `<DataTable data-testid="x">` must emit `id="x"` as well as
 * `data-testid="x"`, in EVERY render branch.
 *
 * Why this file exists. `DataTableProps` declares no `id` prop and does not
 * extend `HTMLAttributes`, so on a DataTable the `data-testid` prop IS the
 * id setter — it is the only way a table gets an `id`. Ten E2E specs select
 * on that id (`#controls-table`, `#evidence-table`, `#members-table`,
 * `#soa-table`, `#org-tenants-table`, the `#linked-*` and `#org-*` tables),
 * and CLAUDE.md documents the prop as the sanctioned way to create them.
 *
 * Before this file, dropping `id={dataTestId}` from all three branches was
 * caught only incidentally: `list-page-shell.test.tsx` crashed with
 * "Cannot read properties of null (reading 'querySelector')" because a
 * `wrap!` non-null assertion happened to sit downstream. That named nothing,
 * and it covered only the standard branch — the card and virtualized
 * branches went green with the id gone. The v9 migration rewrote every
 * generic in `data-table.tsx`, which is exactly when a silent attribute
 * drop is most likely and least visible.
 */
import { render } from "@testing-library/react";
import * as React from "react";

let mockBelowMd = false;
jest.mock("@/components/ui/table/use-is-below-md", () => ({
    useIsBelowMd: () => mockBelowMd,
}));

import { DataTable, createColumns } from "@/components/ui/table";

interface Row {
    id: string;
    name: string;
}

const columns = createColumns<Row>([{ id: "name", header: "Name", accessorKey: "name" }]);

const smallData: Row[] = [
    { id: "r1", name: "Alpha" },
    { id: "r2", name: "Beta" },
];

const TEST_ID = "controls-table";

beforeEach(() => {
    mockBelowMd = false;
});

/**
 * The assertion every branch shares: the id is present, equals the
 * `data-testid`, and both live on the SAME element — so `#controls-table`
 * and `[data-testid="controls-table"]` can never drift apart.
 */
function expectIdSelectorContract(container: HTMLElement, branch: string) {
    const byId = container.querySelector(`#${TEST_ID}`);
    if (byId === null) {
        throw new Error(
            `[${branch}] <DataTable data-testid="${TEST_ID}"> emitted no id="${TEST_ID}". ` +
                `The data-testid prop is the id setter; ten E2E specs select on these ids.`,
        );
    }
    const byTestId = container.querySelector(`[data-testid="${TEST_ID}"]`);
    expect(byTestId).not.toBeNull();
    expect(byId).toBe(byTestId);
}

describe("DataTable id-selector contract (data-testid sets the id)", () => {
    it("standard table branch emits the id", () => {
        const { container } = render(
            <DataTable<Row>
                data={smallData}
                columns={columns}
                getRowId={(r) => r.id}
                data-testid={TEST_ID}
            />,
        );
        // Confirm we really are on the standard branch.
        expect(container.querySelector("table")).not.toBeNull();
        expectIdSelectorContract(container, "standard");
    });

    it("mobile card branch emits the id", () => {
        mockBelowMd = true;
        const { container } = render(
            <DataTable<Row>
                data={smallData}
                columns={columns}
                getRowId={(r) => r.id}
                data-testid={TEST_ID}
            />,
        );
        // Confirm we really are on the card branch, not the table.
        expect(container.querySelector('[data-testid="data-table-cards"]')).not.toBeNull();
        expectIdSelectorContract(container, "mobile-cards");
    });

    it("virtualized branch emits the id", () => {
        const { container } = render(
            <DataTable<Row>
                data={smallData}
                columns={columns}
                getRowId={(r) => r.id}
                data-testid={TEST_ID}
                virtualize
                virtualHeight={400}
            />,
        );
        expectIdSelectorContract(container, "virtualized");
    });
});
