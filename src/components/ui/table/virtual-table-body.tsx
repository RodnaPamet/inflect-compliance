"use client";

/**
 * Epic 68 — `<VirtualTable>` (filename: `virtual-table-body.tsx`).
 *
 * Replacement for the standard `<Table>` component when row counts
 * are large enough to benefit from windowed rendering. DataTable
 * routes here when `virtualize` is enabled (see DataTable's
 * threshold logic) and falls back to the standard `<Table>`
 * otherwise.
 *
 * Why a sibling component instead of in-place virtualization:
 *   - The standard `<Table>` uses real `<table>` / `<thead>` /
 *     `<tbody>` with sticky-header logic that's tightly coupled to
 *     the whole-row clip ResizeObserver. Bolting react-window into
 *     a `<tbody>` requires `display: block` on table elements + a
 *     full rewrite of the column-width inference. The risk of
 *     subtly breaking the existing 80+ tables is too high.
 *   - This component uses `display: grid` for headers + rows. Same
 *     visual contract (sticky header, hover, selection background,
 *     sort buttons, click handlers, selection-column checkboxes)
 *     reproduced via div semantics.
 *   - Column alignment is enforced via a single `gridTemplateColumns`
 *     value derived from `column.getSize()` — both the header and
 *     every body row use the same template so they cannot drift.
 *
 * Limitations vs `<Table>` (DataTable falls back to non-virtual when
 * any of these are needed):
 *   - column resizing
 *   - column pinning
 *   - server-side pagination footer (virtualization is the replacement)
 *
 * Preserved from `<Table>`:
 *   - sticky header at the top of the scroll container
 *   - sortable columns with sort indicator
 *   - selection (checkbox column flows through `getVisibleLeafColumns`)
 *   - hover + selected backgrounds
 *   - row click + middle-click handlers, with interactive-child guard
 *   - keyboard reachability (scroll container is `tabIndex=0` +
 *     `role=region` with an aria-label)
 *   - load-on-scroll (`onReachEnd`) — see the note below on why this
 *     one is implemented differently here
 *
 * Load-on-scroll: `<Table>` renders an `<InfiniteScrollSentinel>` at
 * the bottom of its scroll wrapper. That does not transplant here —
 * react-window absolutely-positions every child inside an inner
 * element sized to `itemCount * itemSize`, so a sentinel appended to
 * the scroll container sits at the TOP of the scrolled content (it
 * would intersect immediately and fire forever) unless it is manually
 * positioned at the computed content height, which then has to be
 * recomputed on every append. The windowing library already reports
 * exactly what the sentinel exists to infer, so this component reads
 * `onItemsRendered`'s `visibleStopIndex` instead.
 */
import * as React from "react";
import { flexRender } from "@tanstack/react-table";
import type { Row, TableInstance, TableRowData } from "./types";
import { FixedSizeList } from "react-window";
import { AutoSizer } from "react-virtualized-auto-sizer";

import { SortOrder } from "../icons";
import { Tooltip } from "../tooltip";
import { cn, isClickOnInteractiveChild } from "./table-utils";

export const DEFAULT_VIRTUAL_ROW_HEIGHT = 44;

/**
 * How close to the end of the data the visible window must get before
 * `onReachEnd` fires, in rows.
 *
 * Calibrated against the non-virtualized path: `<InfiniteScrollSentinel>`
 * pre-loads with a 320px bottom `rootMargin`, which at the default 44px
 * row height is ~7 rows. 10 keeps the same "load before the user gets
 * there" feel on the taller row heights some tables configure.
 */
export const VIRTUAL_REACH_END_ROW_MARGIN = 10;

export interface VirtualTableProps<T extends TableRowData> {
    /** TanStack table instance from `useTable`. */
    table: TableInstance<T>;
    /**
     * Explicit body height in pixels. When omitted the component
     * fills its parent via AutoSizer — the parent MUST have a
     * determinate height (e.g. ListPageShell.Body's flex chain).
     */
    height?: number;
    /**
     * Pixel height of each row. Default 44 matches the standard
     * Table's `py-2.5` row geometry. Override when row content is
     * taller (e.g. multi-line cells).
     */
    rowHeight?: number;
    /**
     * Extra rows rendered above/below the visible window. Default 5
     * is generous enough that fast keyboard scroll keeps content
     * smooth; bump higher for very dense lists.
     */
    overscanCount?: number;
    /** Row click handler. Mirrors the standard `<Table>` semantics. */
    onRowClick?: (row: Row<T>, e: React.MouseEvent) => void;
    /** Middle-click / aux-click handler. */
    onRowAuxClick?: (row: Row<T>, e: React.MouseEvent) => void;
    /**
     * Whether the select column is mounted (R12-PR1 default-on). When
     * true, single click on the row body toggles selection; mirrors
     * the standard `<Table>` semantics added in R13-PR14.
     */
    selectionEnabled?: boolean;
    /** Sortable column ids (mirrors `<Table>`). */
    sortableColumns?: string[];
    /** Currently-sorted column id. */
    sortBy?: string;
    /** Currently-sorted direction. */
    sortOrder?: "asc" | "desc";
    /** Sort change callback. */
    onSortChange?: (props: {
        sortBy?: string;
        sortOrder?: "asc" | "desc";
    }) => void;
    /**
     * Infinite-scroll (load-on-scroll). Fires when the windowed
     * viewport comes within {@link VIRTUAL_REACH_END_ROW_MARGIN} rows
     * of the last row, at most ONCE per row count — so a load that
     * appends rows re-arms it, and a load that appends nothing does
     * not spin.
     *
     * Same consumer contract as the non-virtualized `<Table>`: the
     * PARENT owns "is there more", by passing
     * `onReachEnd={hasMore ? loadMore : undefined}`.
     */
    onReachEnd?: () => void;
    /** Class on the outer container (mirrors `Table`'s `containerClassName`). */
    containerClassName?: string;
    /** Class on the inner scroll container. */
    scrollWrapperClassName?: string;
    /** Accessible label on the scroll container. */
    "aria-label"?: string;
    /** Test id forwarded to the outer wrapper. */
    "data-testid"?: string;
}

const SELECT_COLUMN_WIDTH = 48;
const MENU_COLUMN_WIDTH = 40;

const headerCellClassName = (columnId: string, hasSelectBefore: boolean) =>
    cn(
        "border-l border-b border-border-subtle text-left text-xs font-semibold",
        "uppercase tracking-wider whitespace-nowrap text-content-muted",
        "bg-bg-muted select-none",
        columnId === "select" && "px-0",
        columnId === "menu" && "px-1",
        !["select", "menu"].includes(columnId) &&
            (hasSelectBefore ? "pl-1 pr-4 py-2.5" : "px-4 py-2.5"),
    );

const bodyCellClassName = (
    columnId: string,
    clickable: boolean,
    hasSelectBefore: boolean,
    isFirstContent: boolean,
) =>
    cn(
        "border-l border-b border-border-subtle text-sm leading-6 whitespace-nowrap text-content-default",
        columnId === "select" && "px-0 py-0",
        columnId === "menu" && "px-1 bg-bg-page border-l-transparent py-0",
        !["select", "menu"].includes(columnId) &&
            (hasSelectBefore ? "pl-1 pr-4 py-2.5" : "px-4 py-2.5"),
        clickable && "group-hover/row:bg-bg-subtle transition-colors duration-75",
        // R13-PR15 — brand-coloured 2-px left-edge accent on hover,
        // gated on `isFirstContent` (computed at render time as the
        // first non-utility column id) instead of `:first-of-type`.
        // Mirrors the table.tsx recipe — `:first-of-type` silently
        // broke once R12-PR1 made the select column default-on and
        // it became the first `<td>`/`<div role="cell">`.
        isFirstContent &&
            clickable &&
            "group-hover/row:shadow-[inset_2px_0_0_var(--brand-default)]",
        "group-data-[selected=true]/row:bg-[var(--brand-subtle)]",
    );

function buildGridTemplate<T extends TableRowData>(table: TableInstance<T>): string {
    return table
        .getVisibleLeafColumns()
        .map((col) => {
            // Utility columns get their fixed pixel widths; matches the
            // standard Table's `getUtilityColumnWidth` behaviour so the
            // checkbox/menu columns line up with the rest of the cell
            // content above and below.
            if (col.id === "select") return `${SELECT_COLUMN_WIDTH}px`;
            if (col.id === "menu") return `${MENU_COLUMN_WIDTH}px`;
            const explicit = col.columnDef.size;
            if (typeof explicit === "number" && explicit > 0) {
                return `${explicit}px`;
            }
            return "minmax(0, 1fr)";
        })
        .join(" ");
}

interface RowItemData<T extends TableRowData> {
    rows: ReadonlyArray<Row<T>>;
    gridTemplate: string;
    onRowClick?: (row: Row<T>, e: React.MouseEvent) => void;
    onRowAuxClick?: (row: Row<T>, e: React.MouseEvent) => void;
    selectionEnabled: boolean;
    columnsAfterSelect: ReadonlySet<string>;
    /** Column id that carries the brand-edge accent (first non-utility column). */
    firstContentColumnId: string | undefined;
}

function VirtualRow<T extends TableRowData>({
    index,
    style,
    data,
}: {
    index: number;
    style: React.CSSProperties;
    data: RowItemData<T>;
}) {
    const { rows, gridTemplate, onRowClick, onRowAuxClick, selectionEnabled, columnsAfterSelect, firstContentColumnId } = data;
    const row = rows[index];
    if (!row) return null;

    return (
        <div
            role="row"
            data-selected={row.getIsSelected()}
            data-virtual-row-index={index}
            className={cn(
                "group/row grid",
                // R13-PR13 — the 2-px brand-coloured left edge moved
                // to the first non-utility cell in `bodyCellClassName`
                // so all three row paths (resizable, non-resizable,
                // virtualized) carry the accent identically and paint
                // on the cell's own paint context. Row keeps cursor +
                // colour transition only.
                //
                // R13-PR14 — selection-enabled rows also get cursor-
                // pointer because click toggles selection (onClick
                // below). Mirrors the standard `<Table>` behaviour.
                (onRowClick || selectionEnabled) &&
                    "cursor-pointer select-none transition-colors duration-150 ease-out",
                "data-[selected=true]:bg-[var(--brand-subtle)]",
            )}
            style={{
                ...style,
                display: "grid",
                gridTemplateColumns: gridTemplate,
            }}
            // R13-PR14 — single click toggles selection. See
            // `ResizableTableRow` in `table.tsx` for the full
            // single-vs-double-click semantics rationale.
            onClick={
                selectionEnabled
                    ? (e) => {
                          if (isClickOnInteractiveChild(e)) return;
                          row.toggleSelected();
                      }
                    : // Selection off → single click runs the row action
                      // (mirrors ResizableTableRow in table.tsx).
                      onRowClick
                      ? (e) => {
                            if (isClickOnInteractiveChild(e)) return;
                            onRowClick(row, e);
                        }
                      : undefined
            }
            onDoubleClick={
                selectionEnabled && onRowClick
                    ? (e) => {
                          if (isClickOnInteractiveChild(e)) return;
                          onRowClick(row, e);
                      }
                    : undefined
            }
            onAuxClick={
                onRowAuxClick
                    ? (e) => {
                          if (isClickOnInteractiveChild(e)) return;
                          onRowAuxClick(row, e);
                      }
                    : undefined
            }
        >
            {row.getVisibleCells().map((cell) => {
                const isUtility = ["select", "menu"].includes(cell.column.id);
                const isSelect = cell.column.id === "select";
                const hasSelectBefore = columnsAfterSelect.has(cell.column.id);
                const isFirstContent = cell.column.id === firstContentColumnId;
                return (
                    <div
                        key={cell.id}
                        role="cell"
                        className={bodyCellClassName(
                            cell.column.id,
                            !!onRowClick,
                            hasSelectBefore,
                            isFirstContent,
                        )}
                    >
                        {isSelect ? (
                            <div className="flex size-full items-center justify-center">
                                {flexRender(
                                    cell.column.columnDef.cell,
                                    cell.getContext(),
                                )}
                            </div>
                        ) : (
                            <div
                                className={cn(
                                    "flex items-center",
                                    isUtility ? "justify-center" : "w-full",
                                    !isUtility && "min-w-0 truncate",
                                )}
                            >
                                {flexRender(
                                    cell.column.columnDef.cell,
                                    cell.getContext(),
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

export function VirtualTable<T extends TableRowData>({
    table,
    height,
    rowHeight = DEFAULT_VIRTUAL_ROW_HEIGHT,
    overscanCount = 5,
    onRowClick,
    onRowAuxClick,
    selectionEnabled = true,
    sortableColumns = [],
    sortBy,
    sortOrder,
    onSortChange,
    onReachEnd,
    containerClassName,
    scrollWrapperClassName,
    "aria-label": ariaLabel = "Table contents (scrollable)",
    "data-testid": testId,
}: VirtualTableProps<T>) {
    const rows = table.getRowModel().rows;
    const visibleColumns = table.getVisibleLeafColumns();

    // Set of columns that follow the select column — used to drop the
    // double-padding between the checkbox cell and the next column.
    const columnsAfterSelect = React.useMemo(() => {
        const set = new Set<string>();
        for (let i = 1; i < visibleColumns.length; i++) {
            if (visibleColumns[i - 1].id === "select") {
                set.add(visibleColumns[i].id);
            }
        }
        return set;
    }, [visibleColumns]);

    // R13-PR15 — id of the first non-utility column. Carries the
    // brand-edge hover/selected accent.
    const firstContentColumnId = React.useMemo(
        () =>
            visibleColumns.find(
                (c) => !["select", "menu"].includes(c.id),
            )?.id,
        [visibleColumns],
    );

    // visibleColumns identity changes when columns add/remove or
    // visibility flips — those are the inputs the template depends on.
    // `table` is stable across renders. Extract the column-id key into
    // a const so the deps array is "simple expressions" only.
    const visibleColumnsKey = visibleColumns.map((c) => c.id).join(",");
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const gridTemplate = React.useMemo(() => buildGridTemplate(table), [visibleColumnsKey, table]);

    // Stable `itemData` keeps react-window from re-rendering rows when
    // the row click handler is the same reference between renders.
    const itemData = React.useMemo<RowItemData<T>>(
        () => ({
            rows,
            gridTemplate,
            onRowClick,
            onRowAuxClick,
            selectionEnabled,
            columnsAfterSelect,
            firstContentColumnId,
        }),
        [rows, gridTemplate, onRowClick, onRowAuxClick, selectionEnabled, columnsAfterSelect, firstContentColumnId],
    );

    // OuterElement must keep a stable reference across renders;
    // react-window remounts its scroll container whenever
    // outerElementType changes, which would reset scroll position
    // every time props update. We build it once with useMemo([])
    // and pipe latest header state through a ref so the header
    // re-renders without recreating the outer component itself.
    const headerStateRef = React.useRef({
        table,
        gridTemplate,
        sortableColumns,
        sortBy,
        sortOrder,
        onSortChange,
        columnsAfterSelect,
        ariaLabel,
        scrollWrapperClassName,
    });
    // "ref-as-mailbox" — the OuterElement below is React.useMemo'd to satisfy
    // react-window's stable-component contract; reading header state through this
    // ref keeps the outer wrapper from needing to re-memoise on every render.
    // eslint-disable-next-line react-hooks/refs
    headerStateRef.current = {
        table,
        gridTemplate,
        sortableColumns,
        sortBy,
        sortOrder,
        onSortChange,
        columnsAfterSelect,
        ariaLabel,
        scrollWrapperClassName,
    };

    // The OuterElement closure captures `headerStateRef`, which the
    // refs rule flags as "passing a ref to a function may read its
    // value during render". The capture is intentional — the
    // virtualizer mounts this forwardRef inside an effect-driven path,
    // not in the outer component's render. Disable the entire useMemo
    // so the closure's ref read doesn't fire either.
    /* eslint-disable react-hooks/refs */
    const OuterElement = React.useMemo(() => {
        const Component = React.forwardRef<
            HTMLDivElement,
            React.HTMLAttributes<HTMLDivElement>
        >(function VirtualTableOuter({ children, className, ...rest }, ref) {
            const state = headerStateRef.current;
            return (
                <div
                    ref={ref}
                    {...rest}
                    role="region"
                    aria-label={state.ariaLabel}
                    tabIndex={0}
                    className={cn(
                        className,
                        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)]/40",
                        state.scrollWrapperClassName,
                    )}
                >
                    <VirtualTableHeader
                        table={state.table}
                        gridTemplate={state.gridTemplate}
                        sortableColumns={state.sortableColumns}
                        sortBy={state.sortBy}
                        sortOrder={state.sortOrder}
                        onSortChange={state.onSortChange}
                        columnsAfterSelect={state.columnsAfterSelect}
                    />
                    {children}
                </div>
            );
        });
        return Component;
        // Empty deps — OuterElement is intentionally stable for the
        // life of the VirtualTable instance. State flows through the
        // ref above which is updated on every render.

    }, []);
    /* eslint-enable react-hooks/refs */

    // Load-on-scroll. `firedForRowCountRef` is what keeps this to one
    // call per batch: react-window re-reports the rendered range on
    // every window change, so without it a user parked at the bottom
    // would re-fire `onReachEnd` on each nudge. Keying the guard on
    // the ROW COUNT (rather than a plain boolean) is what re-arms it:
    // a load that appends rows changes the count and unlocks the next
    // fire, while a load that appends nothing leaves it latched — no
    // request loop at the true end of the data.
    const firedForRowCountRef = React.useRef<number | null>(null);
    const rowCount = rows.length;
    const handleItemsRendered = React.useCallback(
        ({ visibleStopIndex }: { visibleStopIndex: number }) => {
            if (!onReachEnd || rowCount === 0) return;
            if (visibleStopIndex < rowCount - 1 - VIRTUAL_REACH_END_ROW_MARGIN) {
                return;
            }
            if (firedForRowCountRef.current === rowCount) return;
            firedForRowCountRef.current = rowCount;
            onReachEnd();
        },
        [onReachEnd, rowCount],
    );

    const renderInner = (h: number, w: number | string) => (
        <FixedSizeList
            height={h}
            width={w}
            itemCount={rows.length}
            itemSize={rowHeight}
            overscanCount={overscanCount}
            outerElementType={OuterElement}
            itemData={itemData}
            onItemsRendered={onReachEnd ? handleItemsRendered : undefined}
        >
            {VirtualRow as React.ComponentType<{
                index: number;
                style: React.CSSProperties;
                data: RowItemData<T>;
            }>}
        </FixedSizeList>
    );

    if (typeof height === "number") {
        return (
            <div
                data-virtual-table=""
                data-testid={testId}
                className={cn(
                    "border-border-subtle bg-bg-default relative z-0 rounded-lg border overflow-hidden",
                    containerClassName,
                )}
                style={{ height }}
            >
                {renderInner(height, "100%")}
            </div>
        );
    }

    return (
        <div
            data-virtual-table=""
            data-testid={testId}
            className={cn(
                "border-border-subtle bg-bg-default relative z-0 rounded-lg border overflow-hidden",
                "h-full w-full",
                containerClassName,
            )}
            style={{ minHeight: 0 }}
        >
            {/*
                react-virtualized-auto-sizer v2.x — `renderProp`
                replaces function-as-children. Same callback
                shape; width/height arrive as `number | undefined`
                during the initial pre-measure render, hence the
                falsy guard.
            */}
            <AutoSizer
                renderProp={({ height: h, width: w }) => {
                    if (!h || !w) return null;
                    return renderInner(h, w);
                }}
            />
        </div>
    );
}

function HeaderContent({
    children,
    tooltip,
}: {
    children: React.ReactNode;
    tooltip?: string;
}) {
    if (!tooltip) return <>{children}</>;
    return (
        <Tooltip content={tooltip}>
            <span className="cursor-help underline decoration-dotted underline-offset-2">
                {children}
            </span>
        </Tooltip>
    );
}

interface VirtualTableHeaderProps<T extends TableRowData> {
    table: TableInstance<T>;
    gridTemplate: string;
    sortableColumns: string[];
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    onSortChange?: (props: {
        sortBy?: string;
        sortOrder?: "asc" | "desc";
    }) => void;
    columnsAfterSelect: ReadonlySet<string>;
}

function VirtualTableHeader<T extends TableRowData>({
    table,
    gridTemplate,
    sortableColumns,
    sortBy,
    sortOrder,
    onSortChange,
    columnsAfterSelect,
}: VirtualTableHeaderProps<T>) {
    return (
        <div
            role="rowgroup"
            data-virtual-table-header=""
            className="sticky top-0 z-20 bg-bg-muted"
            style={{ display: "grid", gridTemplateColumns: gridTemplate }}
        >
            {table.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => {
                    const isSortable = sortableColumns.includes(header.column.id);
                    const isSelect = header.column.id === "select";
                    const hasSelectBefore = columnsAfterSelect.has(header.column.id);
                    const headerTooltip = (header.column.columnDef.meta as
                        | { headerTooltip?: string }
                        | undefined)?.headerTooltip;

                    const labelContent = header.isPlaceholder
                        ? null
                        : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                          );

                    return (
                        <div
                            key={header.id}
                            role="columnheader"
                            className={headerCellClassName(
                                header.column.id,
                                hasSelectBefore,
                            )}
                        >
                            {isSelect ? (
                                <div className="flex size-full items-center justify-center">
                                    {labelContent}
                                </div>
                            ) : (
                                <div className="flex items-center justify-between gap-tight">
                                    {isSortable ? (
                                        <button
                                            type="button"
                                            aria-label="Sort by column"
                                            className="flex items-center gap-tight"
                                            onClick={() =>
                                                onSortChange?.({
                                                    sortBy: header.column.id,
                                                    sortOrder:
                                                        sortBy !== header.column.id
                                                            ? "desc"
                                                            : sortOrder === "asc"
                                                              ? "desc"
                                                              : "asc",
                                                })
                                            }
                                        >
                                            <HeaderContent tooltip={headerTooltip}>
                                                {labelContent}
                                            </HeaderContent>
                                            {sortBy === header.column.id && (
                                                <SortOrder
                                                    className="h-3 w-3 shrink-0"
                                                    order={sortOrder ?? "desc"}
                                                />
                                            )}
                                        </button>
                                    ) : (
                                        <HeaderContent tooltip={headerTooltip}>
                                            {labelContent}
                                        </HeaderContent>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                }),
            )}
        </div>
    );
}
