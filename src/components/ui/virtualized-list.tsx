"use client";

/**
 * Epic 68 — `<VirtualizedList>` primitive.
 *
 * Reusable foundation for windowed rendering across the app. Wraps
 * `react-window` behind an ergonomic, react-window-agnostic API so
 * consumers (DataTable bodies, Combobox dropdowns, CardList grids,
 * future surfaces) never import react-window directly. If we replace
 * react-window with a different windowing engine later, the swap
 * happens in one file — and the v1 → v2 migration is the proof that
 * the indirection earns its keep: react-window 2 deleted every symbol
 * the old implementation imported, and only this file changed shape.
 *
 * Contract — only THREE props are required:
 *   - `itemCount`     — total number of logical items
 *   - `itemSize`      — fixed pixel height OR `(index) => height` for
 *                       variable rows
 *   - `renderItem`    — `({ index, style }) => ReactNode`. The `style`
 *                       MUST be applied to the rendered row's outer
 *                       element so react-window can absolute-position
 *                       it inside the scroll viewport.
 *
 * ═══ SIZING, AND WHY AutoSizer IS GONE ═══
 *
 * v1 could not size itself: `FixedSizeList` demanded literal `height`
 * and `width` numbers, so this file carried a four-branch AutoSizer
 * matrix to measure whichever dimension the caller had not supplied.
 *
 * v2's `List` IS the scroll container and sizes itself — its root
 * carries `maxHeight: 100%; flex-grow: 1; overflow-y: auto` and it
 * observes its own box. So:
 *
 *   - `height` given   → forwarded as `style.height`. react-window
 *                        reads a numeric style height DIRECTLY and
 *                        skips the ResizeObserver entirely, which is
 *                        what makes this deterministic under jsdom.
 *   - `height` omitted → the list fills its parent. The parent MUST
 *                        have a determinate size (flex-1, fixed
 *                        height, or position constraints) or the list
 *                        collapses to 0px, exactly as before.
 *
 * `react-virtualized-auto-sizer` is no longer a dependency of this
 * primitive, or of the app.
 *
 * What this is NOT — a 2D grid virtualizer (use react-window's `Grid`
 * for those rare cases) and not a way to defer rendering items by
 * index range (it's a viewport-driven window, not a paginator).
 * Card-list rollouts that want to virtualize a 3-column responsive
 * grid group cards into rows-of-N before passing to this primitive.
 */
import * as React from "react";
import {
    List,
    type ListImperativeAPI,
    type RowComponentProps,
} from "react-window";

export interface VirtualizedListRenderArgs {
    /** Logical index of the item being rendered. */
    index: number;
    /** Absolute-positioning style — MUST be spread onto the outer element. */
    style: React.CSSProperties;
}

export interface VirtualizedListProps {
    /** Total number of items in the windowed list. */
    itemCount: number;
    /**
     * Pixel height of each row. Pass a number for uniform rows or a
     * function `(index) => number` for rows whose height varies by
     * index but is deterministic. For dynamically-MEASURED rows use
     * react-window's `useDynamicRowHeight` directly.
     */
    itemSize: number | ((index: number) => number);
    /** Render the row at `index`. Spread `style` onto the outer element. */
    renderItem: (args: VirtualizedListRenderArgs) => React.ReactNode;
    /**
     * Explicit viewport height in pixels. When provided, react-window
     * uses it verbatim instead of measuring — required under jsdom,
     * which has no layout engine.
     */
    height?: number;
    /**
     * Explicit width. Strings (e.g. `"100%"`) are forwarded verbatim.
     * Purely cosmetic for a vertical list: react-window windows on the
     * vertical axis only and never reads this for row math.
     */
    width?: number | string;
    /**
     * Extra rows rendered above/below the visible window. Default
     * matches react-window's default of 2; bump to ~5 for surfaces
     * with fast keyboard navigation (combobox) so options pre-render
     * before the user scrolls them into view.
     */
    overscanCount?: number;
    /**
     * Stable per-index key for React reconciliation. Default is the
     * index itself, which is fine for static lists; pass a function
     * when items can shuffle / sort so React doesn't tear down rows
     * unnecessarily.
     */
    itemKey?: (index: number) => string | number;
    /** Class on the outer wrapper. */
    className?: string;
    /** Class on the inner scroll viewport (the react-window div). */
    innerClassName?: string;
    /** Accessible label, forwarded to the outer wrapper. */
    "aria-label"?: string;
    /**
     * ARIA role for the inner scroll viewport.
     *
     * react-window 2 puts `role="list"` on its scroller; v1 set no role
     * at all. That default is wrong inside a surface with its own
     * semantics — the combobox wraps this in `role="listbox"`, and a
     * `list` between a `listbox` and its `option`s is invalid ARIA that
     * breaks the option count screen readers announce.
     *
     * Consumers that own their semantics pass `"presentation"` to erase
     * it. Left undefined, react-window's `list` stands, which is right
     * for a plain scrolling list.
     */
    role?: React.AriaRole;
    /** Optional `data-testid` for the outer wrapper. */
    "data-testid"?: string;
}

/**
 * What travels to every row through react-window's `rowProps` channel.
 *
 * v1 had an `itemData` prop that consumers could fill; this primitive
 * deliberately never exposed it, because closing over data in
 * `renderItem` is simpler. v2 makes `rowProps` REQUIRED, and it is
 * load-bearing for a second reason: react-window keys its row-size
 * cache on this object's identity, so a change here is what
 * invalidates measurements. That is the v2 replacement for v1's
 * imperative `resetAfterIndex`.
 */
type VirtualizedRowProps = {
    renderItem: (args: VirtualizedListRenderArgs) => React.ReactNode;
    /**
     * Bumped by the caller-facing `resetAfterIndex()` shim. Its only job
     * is to change `rowProps` identity so the size cache is discarded.
     */
    sizeEpoch: number;
};

function VirtualizedListRow({
    index,
    style,
    renderItem,
}: RowComponentProps<VirtualizedRowProps>) {
    return <>{renderItem({ index, style })}</>;
}

/**
 * Imperative handle exposed via `ref={...}`. Primary use case is
 * scroll-to-active for keyboard-driven surfaces (combobox, menu).
 *
 * The shape is unchanged from v1 on purpose — `virtualized-options`
 * calls all three — even though v2's own API differs in all three.
 */
export interface VirtualizedListHandle {
    /** Scroll to bring item at `index` into the visible window. */
    scrollToItem: (
        index: number,
        align?: "auto" | "smart" | "center" | "end" | "start",
    ) => void;
    /** Scroll the viewport to a specific pixel offset. */
    scrollTo: (offset: number) => void;
    /**
     * Discard cached row-size measurements.
     *
     * v1 had `VariableSizeList.resetAfterIndex(index)`, which dropped
     * the cache from `index` onward. v2 has no imperative equivalent:
     * it re-derives sizes when `rowProps` identity changes. So this
     * bumps an epoch counter that flows through `rowProps`, which
     * invalidates the whole cache.
     *
     * The `index` argument is therefore accepted and IGNORED — every
     * reset is a full reset. That is a strictly wider invalidation than
     * v1's, so no caller can be under-invalidated by the change; the
     * cost is recomputing sizes below `index`, which is a pure function
     * call per row.
     */
    resetAfterIndex: (index: number) => void;
}

export const VirtualizedList = React.forwardRef<
    VirtualizedListHandle,
    VirtualizedListProps
>(function VirtualizedList(
    {
        itemCount,
        itemSize,
        renderItem,
        height,
        width,
        overscanCount = 2,
        itemKey,
        className,
        innerClassName,
        "aria-label": ariaLabel,
        "data-testid": testId,
        role,
    },
    ref,
) {
    const listRef = React.useRef<ListImperativeAPI>(null);
    const [sizeEpoch, setSizeEpoch] = React.useState(0);

    React.useImperativeHandle(
        ref,
        () => ({
            scrollToItem: (index, align) => {
                // v2 throws a RangeError rather than clamping. A combobox
                // scrolling to its active index while the option list is
                // being filtered underneath it hits this routinely, and an
                // exception from a scroll effect would take the whole panel
                // down.
                if (index < 0 || index >= itemCount) return;
                listRef.current?.scrollToRow({ index, align });
            },
            // v2 dropped `scrollTo(offset)`. Its handle exposes the root
            // element, which IS the scroller, so the offset is a plain
            // assignment — no behavioural difference.
            scrollTo: (offset) => {
                const el = listRef.current?.element;
                if (el) el.scrollTop = offset;
            },
            resetAfterIndex: () => setSizeEpoch((n) => n + 1),
        }),
        [itemCount],
    );

    const rowProps = React.useMemo<VirtualizedRowProps>(
        () => ({ renderItem, sizeEpoch }),
        [renderItem, sizeEpoch],
    );

    // v2 calls the size function with `(index, rowProps)`; this
    // primitive's contract is index-only, so the second argument is
    // dropped here rather than leaking react-window's shape to callers.
    const rowHeight = React.useMemo(
        () =>
            typeof itemSize === "function"
                ? (index: number) => itemSize(index)
                : itemSize,
        [itemSize],
    );

    // v2's `rowKey` receives `(index, rowProps)` and must be stable —
    // react-window calls it during render, so an inline arrow would
    // re-key every row on every render.
    const rowKey = React.useCallback(
        (index: number) => itemKey?.(index) ?? index,
        [itemKey],
    );

    return (
        <div
            data-virtualized-list=""
            data-testid={testId}
            aria-label={ariaLabel}
            className={className}
            style={{
                width: typeof width !== "undefined" ? width : "100%",
                height: typeof height === "number" ? height : "100%",
                minHeight: 0,
            }}
        >
            <List<VirtualizedRowProps>
                listRef={listRef}
                className={innerClassName}
                rowCount={itemCount}
                rowHeight={rowHeight}
                rowComponent={VirtualizedListRow}
                rowProps={rowProps}
                rowKey={rowKey}
                overscanCount={overscanCount}
                // CONDITIONAL spread, not `role={role}`. react-window builds
                // its root as `{ role: 'list', ...rest }`, so a `role` key
                // present with an undefined value wins the spread and erases
                // the default — the list would silently lose its role for
                // every consumer that never asked to change it.
                {...(role ? { role } : {})}
                // A numeric height here is read verbatim and suppresses the
                // ResizeObserver path — the difference between a
                // deterministic list and one that renders nothing under
                // jsdom.
                style={typeof height === "number" ? { height } : undefined}
            />
        </div>
    );
});
