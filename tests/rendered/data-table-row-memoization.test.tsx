/** @jest-environment jsdom */

/**
 * #101 — the standard table row is memoized, and the memo actually bites.
 *
 * ─── Why the row needed memoizing ───────────────────────────────────
 *
 * `ResizableTableRow` only ever mounts when `enableColumnResizing &&
 * sizingFrozen`, and column resizing has been default-off since
 * 2026-06-04. So before `TableBodyRow` existed, EVERY production table
 * re-rendered every `<tr>`, every `<td>` and every consumer cell
 * renderer on any ancestor re-render — across the whole accumulated row
 * set, which load-on-scroll grows past 400 on the heavy list pages.
 * The memo'd row component that was supposed to prevent that was
 * unreachable dead code.
 *
 * Windowing does not cover this. `VIRTUALIZE_DEFAULT_THRESHOLD` is
 * 1000, and the Controls page pins `virtualize: false` as a documented
 * Epic 68 contract — memoization is the only lever there.
 *
 * ─── Why extracting the row was not enough ──────────────────────────
 *
 * `TableBodyRow` compares props shallowly, and one prop churned on
 * every render: `cells`. `row.getVisibleCells()` is TanStack-memoized
 * on `[getStartVisibleCells(), getCenterVisibleCells(),
 * getEndVisibleCells()]`, and each of those is in turn memoized on
 * `table.state.columnPinning.start` / `.end` (TanStack v9 renamed the
 * physical left/right pin regions to the logical start/end pair).
 * `useTable` built that state inline — `columnPinning: { start: [],
 * end: [], ...columnPinning }` — so `.start` was a FRESH `[]` every render,
 * every cells memo missed, and the row got a new array every time.
 * One useMemo in `useTable` fixed it. `getVisibleCellsIdentity` below
 * is the regression lock on exactly that.
 *
 * ─── What these tests count ─────────────────────────────────────────
 *
 * A bare render count is not enough: React batches inside `act()`, so
 * a count can stay flat because the table never re-rendered at all.
 * So every cost assertion here is paired with a HEADER render count.
 * Headers are deliberately NOT memoized, so a growing header count is
 * positive proof the table subtree really did re-render while the rows
 * bailed out. Both numbers appear in every assertion.
 */

import * as React from "react";
import { render, act, fireEvent, screen } from "@testing-library/react";

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

import { DataTable, createColumns, useTable } from "@/components/ui/table";

interface Thing {
    id: string;
    name: string;
}

/**
 * 40 rows and 3 ancestor re-renders. Unmemoized that is 40 + 3 × 40 =
 * 160 consumer cell renders; memoized it is 40. The gap is wide enough
 * that a partial regression (one prop churning again) is unmistakable
 * rather than a one-or-two-render judgement call.
 */
const ROW_COUNT = 40;
const ANCESTOR_RENDERS = 3;

const ROWS: Thing[] = Array.from({ length: ROW_COUNT }, (_, i) => ({
    id: `r${i}`,
    name: `Item ${i}`,
}));

let cellRenders = 0;
let headerRenders = 0;

const columns = createColumns<Thing>([
    {
        accessorKey: "name",
        header: () => {
            headerRenders += 1;
            return <span>Name</span>;
        },
        cell: ({ row }) => {
            cellRenders += 1;
            return <span>{row.original.name}</span>;
        },
    },
]);

function resetCounters() {
    cellRenders = 0;
    headerRenders = 0;
}

/** Parent that re-renders for its OWN reason, table data untouched. */
function Harness({
    rows = ROWS,
    selectionEnabled = false,
}: {
    rows?: Thing[];
    selectionEnabled?: boolean;
}) {
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
                selectionEnabled={selectionEnabled}
            />
        </div>
    );
}

function bump(times: number) {
    const button = screen.getByRole("button", { name: /bump/ });
    for (let i = 0; i < times; i++) {
        // fireEvent inside act(), NOT node.click() — a bare .click() does
        // not flush the state update here, so the table subtree would
        // never re-render and a cost assertion would pass with no memo
        // at all.
        act(() => {
            fireEvent.click(button);
        });
    }
    return button;
}

describe("DataTable — body rows are memoized (#101)", () => {
    it("charges nothing per ancestor re-render, while the table itself re-renders", () => {
        resetCounters();
        render(<Harness />);

        expect(cellRenders).toBe(ROW_COUNT); // initial paint
        const headersAfterMount = headerRenders;
        expect(headersAfterMount).toBeGreaterThan(0);

        const button = bump(ANCESTOR_RENDERS);

        // Positive control #1 — the parent really did re-render.
        expect(button.textContent).toContain(String(ANCESTOR_RENDERS));
        // Positive control #2 — and so did the TABLE. Headers are not
        // memoized, so this count MUST grow. Without it, `cellRenders`
        // staying flat would be indistinguishable from the table
        // subtree never rendering.
        expect(headerRenders).toBeGreaterThan(headersAfterMount);
        // Positive control #3 — the rows are actually on screen, so
        // "no cell renders" is not "no cells".
        expect(document.querySelectorAll("tbody tr").length).toBe(ROW_COUNT);

        // The measurement: three ancestor re-renders, zero extra row work.
        // Unmemoized this is ROW_COUNT * (1 + ANCESTOR_RENDERS) = 160.
        expect(cellRenders).toBe(ROW_COUNT);
    });

    it("keeps the per-row cost independent of how many times the ancestor renders", () => {
        resetCounters();
        render(<Harness />);
        bump(12);

        // Four times the ancestor churn, same row cost. Unmemoized this
        // would be 13 × ROW_COUNT = 520.
        expect(headerRenders).toBeGreaterThan(12);
        expect(cellRenders).toBe(ROW_COUNT);
    });

    it("hands the row a stable `cells` array — the prop the memo turns on", () => {
        // The root-cause lock. `TableBodyRow` receives
        // `row.getVisibleCells()`; if `useTable` goes back to building a
        // fresh `columnPinning` state object per render, TanStack's cells
        // memo misses and the row gets a new array every time — the memo
        // is then present but inert, which is exactly the state this
        // branch sat in. Independent of React's bail-out behaviour.
        // One outer array, pushed to — NOT a counter reassigned from inside
        // the component. `renders += 1` inside a component body is a
        // reassignment of an outer binding, which the React Compiler lint rule
        // refuses; `seen.push(...)` is a mutation of an outer object, which it
        // allows. `seen.length` IS the render count, so nothing is lost.
        const seen: unknown[] = [];

        function CellsProbe() {
            const [tick, setTick] = React.useState(0);
            const { table } = useTable<Thing>({
                data: ROWS,
                columns,
                getRowId: (r) => r.id,
            });
            seen.push(table.getRowModel().rows[0].getVisibleCells());
            return (
                <button type="button" onClick={() => setTick((v) => v + 1)}>
                    bump {tick}
                </button>
            );
        }

        render(<CellsProbe />);
        bump(ANCESTOR_RENDERS);

        // Positive first: the probe really did re-render more times than we
        // bumped it, so the identity assertion below is about a live component
        // and not about a component that never ran.
        expect(seen.length).toBeGreaterThan(ANCESTOR_RENDERS);
        expect(seen[0]).toBeDefined();
        expect(new Set(seen).size).toBe(1); // one array identity, every render
    });

    describe("staleness — a stale row is far worse than a slow one", () => {
        it("repaints when the row data actually changes", () => {
            resetCounters();
            const { rerender } = render(<Harness />);
            expect(cellRenders).toBe(ROW_COUNT);

            const changed = ROWS.map((r) =>
                r.id === "r2" ? { ...r, name: "RENAMED" } : r,
            );
            rerender(<Harness rows={changed} />);

            expect(cellRenders).toBeGreaterThan(ROW_COUNT);
            expect(screen.getByText("RENAMED")).toBeInTheDocument();
        });

        it("repaints the row it selects, and leaves the others alone", () => {
            resetCounters();
            render(<Harness selectionEnabled />);
            const before = cellRenders;

            const firstRow = document.querySelectorAll("tbody tr")[0];
            expect(firstRow.getAttribute("data-selected")).toBe("false");

            act(() => {
                fireEvent.click(firstRow);
            });

            // The selected row repainted — `data-selected` is live, not
            // frozen behind the memo.
            expect(firstRow.getAttribute("data-selected")).toBe("true");
            // …and it cost one row's worth of cell work, not forty.
            // (2 columns render per row: the select column's cell is
            // TanStack's own, so only the consumer cell is counted.)
            expect(cellRenders).toBe(before + 1);
        });

        it("repaints when the row expands", () => {
            resetCounters();
            render(
                <DataTable<Thing>
                    data={ROWS.slice(0, 2)}
                    columns={columns}
                    getRowId={(r) => r.id}
                    selectionEnabled={false}
                    getRowCanExpand={() => true}
                    renderAlignedSubRows={(row, columnIds) => (
                        <tr key={`sub-${row.id}`}>
                            {columnIds.map((columnId) => (
                                <td key={columnId}>sub {row.id}</td>
                            ))}
                        </tr>
                    )}
                />,
            );

            const toggle = screen.getAllByRole("button", {
                name: /expand row/i,
            })[0];
            const before = cellRenders;
            act(() => {
                fireEvent.click(toggle);
            });

            // aria-expanded is painted from the `isExpanded` SNAPSHOT
            // prop; if it were read live inside the memo it would stay
            // stale here.
            expect(
                screen.getAllByRole("button", { name: /collapse row/i }).length,
            ).toBe(1);
            expect(cellRenders).toBeGreaterThan(before);
        });
    });
});
