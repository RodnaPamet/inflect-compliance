/**
 * The bulk-action bar and load-on-scroll follow the rows into every
 * renderer `<DataTable>` picks (#5229, #5230).
 *
 * Only `<Table>` mounted the `<SelectionToolbar>` and the
 * `<InfiniteScrollSentinel>`. On a phone (the card list) a ticked row had no
 * bar to act on it and the list stopped after its first batch; once a
 * load-on-scroll list passed the virtualization threshold mid-session, the
 * bar the user was working with disappeared.
 */
import { render, screen } from "@testing-library/react";
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
const data: Row[] = [
    { id: "r1", name: "First" },
    { id: "r2", name: "Second" },
];

const bulkBar = () => <button type="button">Bulk delete</button>;

beforeEach(() => {
    mockBelowMd = false;
});

describe("phone (card list)", () => {
    beforeEach(() => {
        mockBelowMd = true;
    });

    it("mounts the bulk-action bar", () => {
        render(
            <DataTable<Row>
                data={data}
                columns={columns}
                getRowId={(r) => r.id}
                selectionControls={bulkBar}
            />,
        );
        expect(screen.getByTestId("data-table-cards")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Bulk delete", hidden: true })).toBeInTheDocument();
    });

    it("renders the load-on-scroll sentinel while there is more to load", () => {
        render(
            <DataTable<Row>
                data={data}
                columns={columns}
                getRowId={(r) => r.id}
                onReachEnd={() => undefined}
            />,
        );
        expect(screen.getByTestId("cards-infinite-scroll-sentinel")).toBeInTheDocument();
    });

    it("renders no sentinel once the list is complete", () => {
        render(<DataTable<Row> data={data} columns={columns} getRowId={(r) => r.id} />);
        expect(screen.queryByTestId("cards-infinite-scroll-sentinel")).toBeNull();
    });

    it("renders no bar when selection is switched off", () => {
        render(
            <DataTable<Row>
                data={data}
                columns={columns}
                getRowId={(r) => r.id}
                selectionEnabled={false}
                selectionControls={bulkBar}
            />,
        );
        expect(screen.queryByRole("button", { name: "Bulk delete", hidden: true })).toBeNull();
    });
});

describe("virtualized", () => {
    it("mounts the bulk-action bar", () => {
        const { container } = render(
            <DataTable<Row>
                data={data}
                columns={columns}
                getRowId={(r) => r.id}
                virtualize
                selectionControls={bulkBar}
            />,
        );
        expect(container.querySelector("[data-virtual-table]")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Bulk delete", hidden: true })).toBeInTheDocument();
    });
});
