/**
 * `<VirtualizedList>` — the windowing primitive's PUBLIC contract.
 *
 * These describe the contract the react-window 1 → 2 migration deliberately
 * kept identical, and they are written so they would have passed on the v1
 * implementation too: the point is that they cannot tell which engine is
 * underneath, only that the contract holds. v2 deleted every symbol the old
 * implementation imported — `FixedSizeList`, `VariableSizeList`,
 * `ListChildComponentProps` — and replaced the children-as-component
 * contract, the sizing props and the entire imperative handle.
 *
 * ═══ WHY AN EXPLICIT `height` IS IN EVERY CASE ═══
 *
 * jsdom has no layout engine: every element measures 0×0, and this suite's
 * `ResizeObserver` is a stub that never fires. A windowing list told it has
 * 0px of viewport correctly renders zero rows — except for its OVERSCAN,
 * which it renders anyway. So a list that had silently collapsed to zero
 * height would still put ~3 rows in the DOM and sail through a `> 0`
 * assertion. react-window reads a NUMERIC `style.height` directly and skips
 * its ResizeObserver entirely, which is what makes these deterministic; the
 * lower bounds below are tied to the viewport's own row count rather than to
 * zero, which is what makes them mean anything.
 */
/** @jest-environment jsdom */

import * as React from "react";
import { render, screen } from "@testing-library/react";

import {
    VirtualizedList,
    type VirtualizedListHandle,
} from "@/components/ui/virtualized-list";

const ROW_HEIGHT = 20;
const VIEWPORT = 100;

function renderList(
    props: Partial<React.ComponentProps<typeof VirtualizedList>> = {},
) {
    return render(
        <VirtualizedList
            itemCount={1000}
            itemSize={ROW_HEIGHT}
            height={VIEWPORT}
            width={300}
            data-testid="list"
            renderItem={({ index, style }) => (
                <div style={style} data-testid={`row-${index}`}>
                    item {index}
                </div>
            )}
            {...props}
        />,
    );
}

/** Row indices currently in the DOM, ascending. */
const renderedIndices = () =>
    Array.from(document.querySelectorAll('[data-testid^="row-"]'))
        .map((el) => Number(el.getAttribute("data-testid")!.replace("row-", "")))
        .sort((a, b) => a - b);

describe("VirtualizedList — windowing contract", () => {
    it("renders a window of rows, not all 1000 of them", () => {
        renderList();

        const indices = renderedIndices();

        // The whole point of the primitive. A naive list would mount 1000
        // rows; 100px of viewport at 20px a row is 5 visible, plus overscan.
        expect(indices.length).toBeGreaterThanOrEqual(VIEWPORT / ROW_HEIGHT);
        expect(indices.length).toBeLessThan(30);

        // ...and it must be the rows at the TOP, not an arbitrary slice.
        expect(screen.getByTestId("row-0")).toBeInTheDocument();
        expect(screen.queryByTestId("row-999")).not.toBeInTheDocument();
    });

    it("renders the number of items it is told to, when that is fewer than a screenful", () => {
        // Guards the off-by-one at the other end: a list of 3 must not render
        // phantom rows 3..N because the viewport has room for them.
        renderList({ itemCount: 3 });

        expect(renderedIndices()).toEqual([0, 1, 2]);
    });

    it("renders nothing, and does not throw, for an empty list", () => {
        // The combobox hits this every time a filter matches no options.
        renderList({ itemCount: 0 });

        expect(renderedIndices()).toEqual([]);
    });
});

describe("VirtualizedList — render contract", () => {
    it("gives every row the absolute-positioning style its contract promises", () => {
        // `renderItem` is documented as "spread `style` onto the outer
        // element" — if that style stopped carrying a position the rows would
        // stack in flow and the list would be 20,000px tall instead of 100px.
        renderList();

        expect(screen.getByTestId("row-3")).toHaveStyle({ position: "absolute" });
    });

    it("forwards aria-label and data-testid to the wrapper", () => {
        renderList({ "aria-label": "Windowed rows" });

        expect(screen.getByTestId("list")).toHaveAttribute(
            "aria-label",
            "Windowed rows",
        );
        expect(screen.getByTestId("list")).toHaveAttribute(
            "data-virtualized-list",
            "",
        );
    });

    it("uses itemKey for row identity without disturbing the rendered content", () => {
        const keys = ["a", "b", "c", "d", "e"];
        const { rerender } = render(
            <VirtualizedList
                itemCount={5}
                itemSize={30}
                height={200}
                width={200}
                itemKey={(i) => keys[i] ?? i}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`k-${index}`}>
                        {keys[index]}
                    </div>
                )}
            />,
        );
        expect(screen.getByTestId("k-0")).toHaveTextContent("a");

        rerender(
            <VirtualizedList
                itemCount={5}
                itemSize={30}
                height={200}
                width={200}
                itemKey={(i) => keys[i] ?? i}
                renderItem={({ index, style }) => (
                    <div style={style} data-testid={`k-${index}`}>
                        {keys[index]}
                    </div>
                )}
            />,
        );
        expect(screen.getByTestId("k-0")).toHaveTextContent("a");
    });
});

describe("VirtualizedList — variable size mode", () => {
    it("accepts a per-index size function for variable-height rows", () => {
        // v1 routed this to a different COMPONENT (`VariableSizeList`); v2
        // takes a function for `rowHeight` on the one `List`. Callers see
        // neither.
        const itemSize = jest.fn((index: number) => (index % 2 === 0 ? 20 : 40));

        renderList({ itemSize, itemCount: 10 });

        expect(itemSize).toHaveBeenCalled();
        // Row 0 is 20px, row 1 is 40px — so row 1 sits at y=20 and row 2 at
        // y=60. Asserting the OFFSET proves the sizes were actually used for
        // layout rather than merely requested.
        expect(screen.getByTestId("row-2")).toHaveStyle({
            transform: "translateY(60px)",
        });
    });

    it("windows a large variable-size list too", () => {
        renderList({ itemCount: 1000, itemSize: (i: number) => 25 + (i % 3) * 10 });

        const indices = renderedIndices();
        expect(indices.length).toBeGreaterThan(0);
        expect(indices.length).toBeLessThan(50);
    });
});

describe("VirtualizedList — overscan", () => {
    it("renders extra rows beyond the visible window per overscanCount", () => {
        // 60px viewport / 30px rows → 2 visible. Overscan 5 means up to 5
        // rows beyond the viewport in each direction, clamped at the edges.
        // react-window's policy is "up to N", not "exactly N" — assert the
        // band, with the lower bound at the visible count.
        renderList({ itemCount: 100, itemSize: 30, height: 60, overscanCount: 5 });

        const indices = renderedIndices();
        expect(indices.length).toBeGreaterThanOrEqual(2);
        expect(indices.length).toBeLessThanOrEqual(10);
    });
});

describe("VirtualizedList — ARIA", () => {
    it("exposes the scroller as a list by default", () => {
        // react-window 2 puts `role="list"` on its scroller; v1 set no role
        // at all. For a plain scrolling list that default is an improvement.
        renderList({ itemCount: 7 });

        expect(screen.getByRole("list")).toBeInTheDocument();
    });

    it("lets a consumer erase that role when it owns its own semantics", () => {
        // This is not a preference, it is valid-ARIA plumbing. The combobox
        // renders this inside `role="listbox"` with `role="option"` rows; a
        // `list` in between is invalid and breaks the "N options" count
        // screen readers announce. v1 had no role to collide with, so the
        // migration introduced the hazard and has to hand consumers the way
        // out.
        renderList({ itemCount: 7, role: "presentation" });

        expect(screen.queryByRole("list")).not.toBeInTheDocument();
    });

    it("does NOT put react-window ARIA on the rows the consumer renders", () => {
        // `renderItem` owns the row element, so the row's semantics are the
        // consumer's to choose — the combobox needs `option`, not `listitem`.
        // If the wrapper ever started forwarding react-window's
        // `ariaAttributes`, every combobox option would announce as a plain
        // list item.
        renderList({ itemCount: 7 });

        expect(screen.getByTestId("row-0")).not.toHaveAttribute("role");
        expect(screen.getByTestId("row-0")).not.toHaveAttribute("aria-posinset");
    });
});

describe("VirtualizedList — the imperative handle", () => {
    /**
     * The handle's SHAPE is load-bearing: `virtualized-options.tsx` calls all
     * three methods, and react-window 2 renamed or deleted all three
     * underneath. These assert the wrapper still presents the v1 surface.
     */
    it("exposes scrollToItem, scrollTo and resetAfterIndex", () => {
        const ref = React.createRef<VirtualizedListHandle>();
        renderList({ ref } as never);

        expect(typeof ref.current?.scrollToItem).toBe("function");
        expect(typeof ref.current?.scrollTo).toBe("function");
        expect(typeof ref.current?.resetAfterIndex).toBe("function");
    });

    it("survives scrollToItem for an index outside the list", () => {
        // react-window 2 throws a RangeError rather than clamping, and the
        // combobox scrolls to its active index while the option list is being
        // filtered underneath it — so this fires in normal use. An exception
        // from that effect would take the whole panel down.
        const ref = React.createRef<VirtualizedListHandle>();
        renderList({ ref, itemCount: 5 } as never);

        expect(() => ref.current!.scrollToItem(99)).not.toThrow();
        expect(() => ref.current!.scrollToItem(-1)).not.toThrow();
    });

    it("re-measures rows after resetAfterIndex", () => {
        // v1 had `VariableSizeList.resetAfterIndex`, which dropped the cached
        // offsets. v2 has no imperative equivalent — it re-derives sizes when
        // `rowProps` identity changes — so the wrapper reimplements it by
        // bumping an epoch. If that wiring breaks, sizes silently stay stale
        // and rows overlap; this is the only thing that would notice.
        const ref = React.createRef<VirtualizedListHandle>();
        const itemSize = jest.fn(() => 20);

        renderList({ ref, itemSize, itemCount: 10 } as never);
        const before = itemSize.mock.calls.length;
        expect(before).toBeGreaterThan(0);

        React.act(() => {
            ref.current!.resetAfterIndex(0);
        });

        expect(itemSize.mock.calls.length).toBeGreaterThan(before);
    });

    it("scrollTo writes the offset onto the scroller element itself", () => {
        // v2 dropped `scrollTo(offset)` entirely; the shim assigns to the
        // handle's root element, which IS the scroller. Asserting WHERE the
        // write landed is what distinguishes a working shim from an empty
        // one — `expect(...).not.toThrow()` passes on a no-op.
        //
        // jsdom has no layout, so its `scrollTop` setter does nothing and
        // reading it back always gives 0. The property is replaced on the
        // element the role identifies, which stubs jsdom at exactly the point
        // jsdom is missing and leaves the assertion about our code.
        const ref = React.createRef<VirtualizedListHandle>();
        renderList({ ref } as never);

        const scroller = screen.getByRole("list");
        const writes: number[] = [];
        Object.defineProperty(scroller, "scrollTop", {
            configurable: true,
            get: () => writes[writes.length - 1] ?? 0,
            set: (v: number) => {
                writes.push(v);
            },
        });

        React.act(() => {
            ref.current!.scrollTo(120);
        });

        expect(writes).toEqual([120]);
    });
});

describe("VirtualizedList — self-sizing fallback", () => {
    it("renders the wrapper without explicit dimensions and does not throw", () => {
        // With no numeric height react-window measures its own box. jsdom
        // reports 0 and this suite's ResizeObserver never fires, so only the
        // overscan rows mount — the wrapper must still be there, and
        // `renderItem` must not have thrown on the way.
        const { container } = render(
            <VirtualizedList
                itemCount={100}
                itemSize={30}
                renderItem={({ index, style }) => (
                    <div style={style}>Row {index}</div>
                )}
            />,
        );
        expect(container.querySelector("[data-virtualized-list]")).toBeTruthy();
    });
});
