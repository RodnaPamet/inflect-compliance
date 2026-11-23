/**
 * Mobile PR-2 — `<DataTable>` swaps the wide table for a stacked CARD list
 * below `md` (a phone) so nothing overflows / truncates. The swap is gated by
 * `useIsBelowMd`, which is `false` under jsdom — so the DESKTOP table is the
 * default in tests (matching every existing table/entity-page test). Forcing
 * the hook to `true` exercises the card branch.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import * as React from "react";

let mockBelowMd = false;
jest.mock("@/components/ui/table/use-is-below-md", () => ({
    useIsBelowMd: () => mockBelowMd,
}));

import { DataTable, createColumns } from "@/components/ui/table";

interface Row {
    id: string;
    name: string;
    status: string;
}

const LONG_NAME =
    "Quarterly Access Recertification for the Production Data Warehouse and Downstream Analytics Pipeline";

const columns = createColumns<Row>([
    { id: "name", header: "Name", accessorKey: "name" },
    { id: "status", header: "Status", accessorKey: "status" },
]);

const data: Row[] = [
    { id: "r1", name: LONG_NAME, status: "OPEN" },
    { id: "r2", name: "Short one", status: "CLOSED" },
];

beforeEach(() => {
    mockBelowMd = false;
});

describe("DataTable responsive rendering", () => {
    it("desktop (default): renders the table, not the card list", () => {
        render(<DataTable<Row> data={data} columns={columns} getRowId={(r) => r.id} />);
        expect(screen.queryByTestId("data-table-cards")).toBeNull();
        expect(screen.getByRole("table")).toBeInTheDocument();
    });

    it("phone: renders a card list (one card per row), not a table", () => {
        mockBelowMd = true;
        render(<DataTable<Row> data={data} columns={columns} getRowId={(r) => r.id} />);
        const cards = screen.getByTestId("data-table-cards");
        expect(within(cards).getAllByRole("listitem")).toHaveLength(2);
        expect(screen.queryByRole("table")).toBeNull();
    });

    it("phone: each column header is a field label and the full value shows", () => {
        mockBelowMd = true;
        render(<DataTable<Row> data={data} columns={columns} getRowId={(r) => r.id} />);
        const cards = screen.getByTestId("data-table-cards");
        expect(within(cards).getAllByText("Name").length).toBe(2);
        expect(within(cards).getAllByText("Status").length).toBe(2);
        // Long value renders verbatim — never truncated to fit the card.
        expect(within(cards).getByText(LONG_NAME).textContent).toBe(LONG_NAME);
    });

    it("phone + empty: keeps the table's own empty chrome (no card list)", () => {
        mockBelowMd = true;
        render(<DataTable<Row> data={[]} columns={columns} getRowId={(r) => r.id} />);
        expect(screen.queryByTestId("data-table-cards")).toBeNull();
    });
});

// ─── The card's own layout (#5818) ───────────────────────────────────

interface Ev {
    id: string;
    title: string;
    owner: string | null;
    hash: string;
    canEdit: boolean;
}

const evColumns = createColumns<Ev>([
    {
        id: "title",
        header: "Title",
        accessorKey: "title",
        cell: ({ getValue }: { getValue: () => string }) => (
            <span className="truncate">{getValue()}</span>
        ),
    },
    {
        id: "owner",
        header: "Owner",
        accessorFn: (r) => r.owner ?? "—",
        cell: ({ getValue }: { getValue: () => string }) => <span>{getValue()}</span>,
    },
    {
        id: "hash",
        header: "Last reviewed by the second line",
        accessorKey: "hash",
        cell: ({ getValue }: { getValue: () => string }) => (
            <span className="truncate">{getValue()}</span>
        ),
    },
    {
        id: "edit",
        header: "",
        meta: { cardAction: true },
        cell: ({ row }: { row: { original: Ev } }) =>
            row.original.canEdit ? (
                <button type="button" aria-label={`Edit ${row.original.title}`} onClick={(e) => e.stopPropagation()}>
                    <svg aria-hidden="true" />
                </button>
            ) : null,
    },
    {
        id: "archive",
        header: "",
        meta: { cardAction: true },
        cell: ({ row }: { row: { original: Ev } }) =>
            row.original.canEdit ? (
                <button type="button" aria-label="Archive" onClick={(e) => e.stopPropagation()}>
                    <svg aria-hidden="true" />
                </button>
            ) : null,
    },
]);

const evData: Ev[] = [
    { id: "e1", title: "SOC 2 report", owner: null, hash: "a".repeat(80), canEdit: true },
    { id: "e2", title: "Pen test", owner: "Ana", hash: "b".repeat(80), canEdit: false },
];

function cardFor(id: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
    if (!el) throw new Error(`no card for ${id}`);
    return el;
}

describe("DataTable phone cards — layout", () => {
    beforeEach(() => {
        mockBelowMd = true;
    });

    it("a read-only list (nothing acts on a selection) offers no checkbox", () => {
        render(<DataTable<Ev> data={evData} columns={evColumns} getRowId={(r) => r.id} />);
        const cards = screen.getByTestId("data-table-cards");
        expect(within(cards).queryAllByRole("checkbox")).toHaveLength(0);
        expect(screen.queryByTestId("data-table-card-select")).toBeNull();
    });

    it("a list with bulk actions puts the checkbox INLINE with the title, in a 44px hit area", () => {
        render(
            <DataTable<Ev>
                data={evData}
                columns={evColumns}
                getRowId={(r) => r.id}
                batchActions={[{ label: "Export", onClick: () => undefined }]}
            />,
        );
        const card = cardFor("e1");
        const titleRow = within(card).getByTestId("data-table-card-title-row");
        const select = within(titleRow).getByTestId("data-table-card-select");
        expect(within(select).getByRole("checkbox")).toBeInTheDocument();
        expect(within(titleRow).getByText("SOC 2 report")).toBeInTheDocument();
        expect(select).toHaveClass("size-11", "shrink-0");
        // Faint-proof in the light theme: the strong border token, 20px.
        expect(select.className).toContain("[&_[role=checkbox]]:border-border-strong");
        expect(select.className).toContain("[&_[role=checkbox]]:size-5");
    });

    it("ticking the checkbox selects the row and does not open it", () => {
        const onRowClick = jest.fn();
        const onRowSelectionChange = jest.fn();
        render(
            <DataTable<Ev>
                data={evData}
                columns={evColumns}
                getRowId={(r) => r.id}
                onRowClick={onRowClick}
                onRowSelectionChange={onRowSelectionChange}
            />,
        );
        fireEvent.click(within(cardFor("e1")).getByTestId("data-table-card-select").firstElementChild!);
        expect(onRowClick).not.toHaveBeenCalled();
        const last = onRowSelectionChange.mock.calls.at(-1)?.[0] ?? [];
        expect(last.map((r: { id: string }) => r.id)).toEqual(["e1"]);
    });

    it("a field that renders only a dash is left out; one with a value stays", () => {
        render(<DataTable<Ev> data={evData} columns={evColumns} getRowId={(r) => r.id} />);
        const fieldWithLabel = (card: HTMLElement, label: string) =>
            within(card).getByText(label).closest<HTMLElement>("[data-card-field]")!;
        expect(fieldWithLabel(cardFor("e1"), "Owner")).not.toBeVisible();
        expect(fieldWithLabel(cardFor("e2"), "Owner")).toBeVisible();
        expect(within(cardFor("e2")).getByText("Ana")).toBeVisible();
    });

    it("below sm the label sits above its value, so a long label cannot squeeze the value", () => {
        render(<DataTable<Ev> data={evData} columns={evColumns} getRowId={(r) => r.id} />);
        const label = within(cardFor("e1")).getByText("Last reviewed by the second line");
        const field = label.closest<HTMLElement>("[data-card-field]")!;
        expect(field).toHaveClass("flex-col", "sm:flex-row");
        expect(label).not.toHaveClass("shrink-0");
        expect(label).toHaveClass("sm:shrink-0", "sm:max-w-[40%]");
    });

    it("a page's inline `truncate` span becomes a real, block-level ellipsis", () => {
        render(<DataTable<Ev> data={evData} columns={evColumns} getRowId={(r) => r.id} />);
        const span = within(cardFor("e1")).getByText("a".repeat(80));
        expect(span).toHaveClass("truncate");
        const value = span.closest<HTMLElement>("[data-card-value]")!;
        expect(value).toHaveClass("min-w-0", "max-w-full", "[&_.truncate]:block", "[&_.truncate]:max-w-full");
        expect(value).not.toHaveClass("[&_.truncate]:whitespace-normal");
    });

    it("the title identifies the row, so a truncating title cell wraps in full instead", () => {
        render(<DataTable<Ev> data={evData} columns={evColumns} getRowId={(r) => r.id} />);
        const title = within(cardFor("e1")).getByText("SOC 2 report");
        expect(title.closest("[data-testid='data-table-card-title-row']")).not.toBeNull();
        const value = title.closest<HTMLElement>("[data-card-value]")!;
        expect(value).toHaveClass("[&_.truncate]:block", "[&_.truncate]:whitespace-normal");
    });

    it("icon-only actions collapse into a labelled ⋯ menu whose items carry their names", async () => {
        const onRowClick = jest.fn();
        render(
            <DataTable<Ev>
                data={evData}
                columns={evColumns}
                getRowId={(r) => r.id}
                onRowClick={onRowClick}
            />,
        );
        const card = cardFor("e1");
        // Not stacked on rows of their own: closed, the actions are not shown.
        expect(within(card).queryByRole("button", { name: "Edit SOC 2 report" })).toBeNull();
        const trigger = within(card).getByRole("button", { name: "Row actions" });
        expect(trigger).toHaveClass("size-11");

        fireEvent.click(trigger);
        expect(onRowClick).not.toHaveBeenCalled();
        const menu = await screen.findByTestId("data-table-card-actions-menu");
        expect(menu).toHaveAttribute("aria-label", "Actions");
        const edit = within(menu).getByRole("button", { name: "Edit SOC 2 report" });
        expect(within(menu).getByRole("button", { name: "Archive" })).toBeInTheDocument();
        // Each icon-only control paints its accessible name as visible text,
        // as a full-width 44px row.
        expect(menu.className).toContain("[&_[aria-label]]:after:content-[attr(aria-label)]");
        expect(menu.className).toContain("[&_:is(button,a,[aria-label])]:min-h-11");

        fireEvent.click(edit);
        expect(onRowClick).not.toHaveBeenCalled();
    });

    it("a row with no applicable action shows no ⋯ trigger", () => {
        render(<DataTable<Ev> data={evData} columns={evColumns} getRowId={(r) => r.id} onRowClick={jest.fn()} />);
        expect(within(cardFor("e2")).getByTestId("data-table-card-actions")).not.toBeVisible();
        expect(within(cardFor("e1")).getByTestId("data-table-card-actions")).toBeVisible();
        expect(within(cardFor("e1")).getByRole("button", { name: "Row actions" })).toBeVisible();
    });
});
