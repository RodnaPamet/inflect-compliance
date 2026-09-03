"use client";

/**
 * DataTable — the canonical reusable table component for all entity list pages.
 *
 * Built on top of the TanStack React Table `useTable` + `Table` foundation,
 * this wrapper provides a simpler, ergonomic API for the most common pattern:
 *
 *   <DataTable
 *     data={controls}
 *     columns={controlColumns}
 *     loading={isLoading}
 *     onRowClick={(row) => router.push(`/controls/${row.original.id}`)}
 *   />
 *
 * For advanced features (column resizing, pinning, edit-columns), use the
 * lower-level `useTable` + `Table` directly.
 */
import type {
  ColumnDef,
  ColumnVisibilityState,
  Row,
  RowSelectionState,
  TableInstance,
  TableRowData,
} from "./types";
// See the note in `./types`: `PaginationState` is not re-exported from the
// platform because `./pagination-utils` owns that name on the barrel.
import type { PaginationState } from "@tanstack/react-table";
import { Dispatch, HTMLAttributes, MouseEvent, ReactNode, SetStateAction, useEffect, useRef, useState } from "react";
import { type BatchAction, renderBatchActions } from "./selection-toolbar";
import { Table, useTable } from "./table";
import { cn } from "./table-utils";
import type { UseTableProps } from "./types";
import { VirtualTable } from "./virtual-table-body";
import { DataTableCards } from "./data-table-cards";
import { useIsBelowMd } from "./use-is-below-md";

// ── Public Column Helper ────────────────────────────────────────────

/**
 * `ColumnDef` is no longer re-exported from here.
 *
 * It now lives in `./types`, bound to the platform's TanStack v9 feature
 * set (`ColumnDef<TData, TValue>` → `ColumnDef<DataTableFeatures, TData,
 * TValue>`), and the barrel re-exports that one. Two `export`s of the same
 * name through `export *` would be ambiguous and silently drop the symbol,
 * so this module must not re-export it as well. Consumers import it from
 * `@/components/ui/table` exactly as before.
 */

/**
 * Helper to create a typed column array with proper inference.
 *
 * Usage:
 *   const columns = createColumns<Control>([
 *     { accessorKey: "code", header: "Code" },
 *     { accessorKey: "name", header: "Name" },
 *     { id: "actions", header: "", cell: ({ row }) => <ActionsMenu row={row} /> },
 *   ]);
 */
export function createColumns<T extends TableRowData>(
  columns: ColumnDef<T>[],
): ColumnDef<T>[] {
  return columns;
}

// ── DataTable Props ─────────────────────────────────────────────────

/**
 * How long the pointer must REST on a row before its detail route is
 * prefetched. Long enough that crossing a table on the way somewhere else
 * prefetches nothing, short enough that a deliberate hover-then-click has
 * always cleared it (a click follows a hover by ~250 ms at the very fastest).
 */
const ROW_PREFETCH_DWELL_MS = 120;

/**
 * Ceiling on the per-row prefetch-handler cache.
 *
 * Comfortably above any rendered window — the virtualizer keeps ~30 rows live
 * and the un-virtualized threshold is 1000 — so eviction only ever reaches ids
 * that scrolled out long ago, and a re-rendered row rebuilds its handler for
 * the cost of one object.
 */
const PREFETCH_HANDLER_CACHE_MAX = 2000;

/**
 * The `virtualize` prop's value. Named rather than inlined so
 * `decideVirtualization` can take it without indexing
 * `DataTableProps<…>["virtualize"]` — under TanStack v9 that index would
 * need a concrete row type to satisfy the `RowData` bound, and the option
 * does not depend on the row type at all.
 */
export type DataTableVirtualize = boolean | { threshold: number } | undefined;

export interface DataTableProps<T extends TableRowData> {
  /** The data array to render. */
  data: T[];

  /** TanStack column definitions. Use `createColumns<T>()` for type safety. */
  columns: ColumnDef<T>[];

  /** Show a loading overlay. */
  loading?: boolean;

  /** Error message to display instead of the table. */
  error?: string;

  /** Custom empty state content. */
  emptyState?: ReactNode;

  /** Human-readable resource name for empty/pagination text. */
  resourceName?: (plural: boolean) => string;

  // ── Sorting ──

  /** Column IDs that support sorting. */
  sortableColumns?: string[];

  /** Currently sorted column ID. */
  sortBy?: string;

  /** Current sort direction. */
  sortOrder?: "asc" | "desc";

  /** Callback when sort changes. */
  onSortChange?: (props: { sortBy?: string; sortOrder?: "asc" | "desc" }) => void;

  // ── Row interaction ──

  /** Callback when a row is clicked. */
  onRowClick?: (row: Row<T>, e: MouseEvent) => void;

  /**
   * Called once, on the FIRST pointer-enter of each row, to warm that row's
   * detail route — the consumer does `router.prefetch(href)` so the chunk +
   * RSC payload are in flight before the click (navigation feels instant).
   * Deduped per row, so it fires at most once per row. The callback lives in
   * the consumer (which already holds the router) so the table primitive
   * stays free of a `useRouter` dependency — rendering a DataTable never
   * requires an app-router context. Complements `onRowClick`.
   */
  onRowPrefetch?: (row: Row<T>) => void;

  /** Unique row ID extractor (required for selection). */
  getRowId?: (row: T) => string;

  /**
   * Expandable rows. `getRowCanExpand(row)` → true shows a leading chevron;
   * toggling renders `renderAlignedSubRows(row, columnIds)` beneath it.
   * Default off (no chevron / no behaviour change). Not supported in the
   * virtualized branch — a consumer using expansion should keep the table
   * non-virtualized (`virtualize={false}` or under the threshold).
   */
  getRowCanExpand?: (row: Row<T>) => boolean;
  /**
   * Aligned expandable sub-rows — real `<tr>`/`<td>` rows whose cells align
   * with the parent columns (one `<td>` per visible column id). See the
   * `BaseTableProps` doc, which also records why the parallel
   * `renderExpandedRow` slot was removed. Forces the non-virtualized
   * `<Table>`.
   */
  renderAlignedSubRows?: (row: Row<T>, columnIds: string[]) => React.ReactNode;
  /**
   * Infinite-scroll (load-on-scroll). Pair with `useThresholdLoadMore`:
   * `onReachEnd={hasMore ? loadMore : undefined}`. Replaces the
   * `<TableLoadMoreFooter>` button.
   *
   * Honoured by BOTH renderers, which matters because load-on-scroll
   * is exactly what carries a table ACROSS the virtualization
   * threshold: appending 50 rows at a time, a list that starts at 50
   * eventually passes `VIRTUALIZE_DEFAULT_THRESHOLD` and swaps to
   * `<VirtualTable>` mid-session. When only `<Table>` was wired, that
   * crossing silently ended load-on-scroll and the rows past the
   * threshold became unreachable.
   *
   * The two renderers detect "at the end" differently — `<Table>`
   * renders an `<InfiniteScrollSentinel>` in its scroll wrapper,
   * `<VirtualTable>` reads react-window's reported visible range (see
   * the note in `virtual-table-body.tsx`) — but the consumer contract
   * is identical: fired when the user nears the last row, once per
   * batch, and the parent stops passing the callback when the data is
   * exhausted.
   */
  onReachEnd?: () => void;

  // ── Selection ──

  /** Callback when selected rows change. Enables selection checkboxes. */
  onRowSelectionChange?: (rows: Row<T>[]) => void;

  /** Externally controlled selection state. */
  selectedRows?: RowSelectionState;

  /** Custom toolbar rendered when rows are selected. */
  selectionControls?: (table: TableInstance<T>) => ReactNode;

  /**
   * R12-PR1 — opt out of the default-on select column. Pass `false`
   * for read-only tables that don't surface selection (sub-component
   * sub-tables that the parent doesn't bulk-select, dashboard
   * digests, etc.). Default is `true`.
   */
  selectionEnabled?: boolean;

  /**
   * Declarative batch actions — a simpler alternative to `selectionControls`.
   * When provided, automatically enables selection and renders a batch action bar.
   *
   * Usage:
   *   <DataTable
   *     batchActions={[
   *       { label: "Export", icon: <Download />, onClick: (rows) => exportRows(rows) },
   *       { label: "Delete", variant: "danger", onClick: (rows) => deleteRows(rows) },
   *     ]}
   *   />
   */
  batchActions?: BatchAction<T>[];

  // ── Column visibility ──

  /** Column visibility state. */
  columnVisibility?: ColumnVisibilityState;

  /** Callback when column visibility changes. */
  onColumnVisibilityChange?: (visibility: ColumnVisibilityState) => void;

  // ── Pagination ──

  /** Pagination state. Enables paginated mode. */
  pagination?: PaginationState;

  /** Pagination change handler. */
  onPaginationChange?: Dispatch<SetStateAction<PaginationState>>;

  /** Total row count (required for pagination). */
  rowCount?: number;

  // ── Column resizing (B2) ──

  /**
   * User-controlled column resizing. **On by default** for the
   * non-virtualized table: every column carries a drag handle on its
   * right edge and the user can adjust widths with the mouse.
   *
   * Widths are NOT uniform — on mount the table renders one
   * auto-layout frame, measures each column's content width, seeds
   * those widths, then switches to `table-layout: fixed` (see the
   * measure-then-fix block in `table.tsx`). The result is visually
   * identical to the old auto-sized table plus drag handles.
   *
   * Resizing is force-disabled for virtualized tables (the grid
   * renderer reads `getSize()` directly with no measure step, so it
   * would collapse to a uniform width).
   *
   * Default OFF as of 2026-06-04 (shelved — the fixed layout it
   * requires caused a horizontal scrollbar on some tables). Pass
   * `enableColumnResizing` to opt a specific table back in.
   */
  enableColumnResizing?: boolean;

  // ── Styling ──

  /** Additional class for the outer container. */
  className?: string;

  /** Additional class for the scroll wrapper. */
  scrollWrapperClassName?: string;

  /**
   * Make the table fill its parent's flex space and provide its own
   * internal vertical scroll instead of growing arbitrarily.
   *
   * Use inside `<ListPageShell.Body>` (or any flex column with
   * `min-h-0` set) to keep the page header / filter toolbar /
   * pagination footer anchored while only the table body scrolls.
   *
   * On mobile (<md) this is a no-op — the table grows naturally and
   * the document scrolls.
   *
   * Default: `false` (legacy behaviour).
   */
  fillBody?: boolean;

  /** Test ID for automated testing. */
  "data-testid"?: string;

  // ── Virtualization (Epic 68) ──

  /**
   * Enable react-window-backed row virtualization for large data.
   *
   * Behaviour:
   *   - `undefined` (default) — auto: virtualize when `data.length`
   *     exceeds the default threshold (`VIRTUALIZE_DEFAULT_THRESHOLD`,
   *     currently 100). Pages opt in by doing nothing.
   *   - `true`               — force virtualization on regardless of
   *                            row count.
   *   - `false`              — force virtualization OFF. Use this on
   *                            pages where the existing
   *                            non-virtualized layout is intentionally
   *                            preserved (e.g. the Controls page,
   *                            where bespoke row affordances rely on
   *                            the standard `<table>` layout).
   *   - `{ threshold: N }`   — auto with a custom threshold.
   *
   * When virtualization is on, the table renders via `<VirtualTable>`
   * which uses `display: grid` for headers + rows (column alignment
   * is enforced by a single `gridTemplateColumns` value). Column
   * resizing, column pinning, and the standard pagination footer are
   * not supported in virtualized mode — DataTable falls back to the
   * non-virtualized `<Table>` automatically when those features are
   * requested.
   */
  virtualize?: DataTableVirtualize;

  /**
   * Pixel height of each row when virtualization is on. Default 44
   * matches the standard table's row geometry. Override only when
   * row content is intentionally taller (multi-line cells).
   */
  virtualRowHeight?: number;

  /**
   * Explicit body height (px) when virtualization is on. When
   * omitted, the body fills its parent via AutoSizer — which is the
   * production default (use inside `<ListPageShell.Body>` or any
   * sized flex parent). Set this only when AutoSizer can't reach a
   * sized ancestor (e.g. test harnesses, or ad-hoc layouts).
   */
  virtualHeight?: number;
}

/**
 * Default row count above which DataTable auto-virtualizes. Exported
 * so structural ratchets and rollout tests can assert against the
 * same value the runtime uses.
 *
 * History — Epic 68 originally shipped with threshold 100 but the
 * auto-virtualize kicked in too aggressively for medium-sized tables
 * (100-1000 rows). Two concrete fallouts:
 *   - E2E tests that accumulate rows from prior tests crossed 100
 *     and then failed Playwright clicks because the virtualized div
 *     wrapper intercepted pointer events on row interactions.
 *   - The virtualized branch's keyboard / focus contract for table
 *     bodies (vs. the standard <table>) needs more bake time before
 *     it's right for medium-traffic tables.
 *
 * Threshold raised to 1000 to scope auto-virtualization to genuinely
 * large unpaginated tables. Pages that legitimately need it for
 * smaller datasets can opt in with `virtualize={true}` or
 * `virtualize={{ threshold: N }}`. The Controls opt-out
 * (`virtualize={false}`) stays as documented.
 */
export const VIRTUALIZE_DEFAULT_THRESHOLD = 1000;

// ── DataTable Component ─────────────────────────────────────────────

export function DataTable<T extends TableRowData>({
  data,
  columns,
  loading,
  error,
  emptyState,
  resourceName,
  sortableColumns,
  sortBy,
  sortOrder,
  onSortChange,
  onRowClick,
  onRowPrefetch,
  getRowId,
  getRowCanExpand,
  renderAlignedSubRows,
  onReachEnd,
  onRowSelectionChange,
  selectedRows,
  selectionControls,
  selectionEnabled,
  batchActions,
  columnVisibility,
  onColumnVisibilityChange,
  pagination,
  onPaginationChange,
  rowCount,
  className,
  scrollWrapperClassName,
  fillBody,
  "data-testid": dataTestId,
  virtualize,
  virtualRowHeight,
  virtualHeight,
  // Default OFF (2026-06-04). Column resizing switched the table to a
  // fixed layout seeded from measured widths, which on some tables
  // summed wider than the card and left a horizontal scrollbar. The
  // feature is shelved (default-off) until that's reworked; pass
  // `enableColumnResizing` to opt a specific table back in. With it
  // off the table is plain auto-layout (width 100%, cells truncate) —
  // no fixed layout, no measure-freeze, no horizontal scroll.
  enableColumnResizing = false,
}: DataTableProps<T>) {
  // Compose the viewport-fill classes onto the existing className /
  // scrollWrapperClassName slots. Tailwind's `md:` prefixes mean
  // mobile keeps natural document scroll; desktop gets the flex
  // chain that lets the table body scroll within its parent.
  const filledContainerClassName = fillBody
    ? cn(
        // Container is a flex column that sizes to its content
        // (= the scroll wrapper inside) but is capped by the parent
        // (ListPageShell.Body). `max-h-full` is the cap;
        // `min-h-0` allows shrinking. NO `flex-1` — that would
        // force the card to fill the parent even when the scroll
        // wrapper inside is short (Evidence with 1 row, empty
        // state, etc.). Result: card grows with content up to
        // viewport, then stops; smaller content = smaller card.
        "md:flex md:flex-col md:max-h-full md:min-h-0 md:overflow-hidden",
        className,
      )
    : className;
  const filledScrollWrapperClassName = fillBody
    ? cn(
        // Wrapper sizes to content, capped at parent (the card).
        // The JS whole-row clip in table.tsx adds an inline
        // max-height when content exceeds the viewport allocation,
        // overriding this max-h-full to a row-aligned value.
        // `overscroll-contain`: this wrapper scrolls INSIDE AppShell's own
        // `md:overflow-y-auto` content div, so without containment a wheel
        // gesture that reaches either end chains outward and starts moving
        // the page behind the table. Set here rather than only in table.tsx
        // so the VirtualTable branch is covered by the same rule.
        "md:max-h-full md:min-h-0 md:overflow-y-auto overscroll-contain",
        scrollWrapperClassName,
      )
    : scrollWrapperClassName;
  // Auto-manage selection state when batchActions are provided
  // without explicit selection handlers. The setter is unwired —
  // batch-mode without explicit selection is currently a
  // visual-affordance-only path; selection mutation flows through
  // the explicit `onRowSelectionChange` prop when wired.
  const [internalSelection] = useState<RowSelectionState>({});
  const hasExplicitSelection = !!onRowSelectionChange || !!selectionControls;
  const hasBatchActions = batchActions && batchActions.length > 0;

  // Determine effective selection props
  const effectiveOnRowSelectionChange = onRowSelectionChange ?? (hasBatchActions ? (() => {}) : undefined);
  const effectiveSelectedRows = selectedRows ?? (hasBatchActions && !hasExplicitSelection ? internalSelection : undefined);
  const effectiveSelectionControls = selectionControls ?? (hasBatchActions ? renderBatchActions(batchActions!) : undefined);
  // Column resizing lives on the non-virtualized <Table> only — its
  // measure-then-fix step seeds each column's content width before
  // switching to fixed layout. VirtualTable reads getSize() straight
  // into its grid template with no measure step, so handing it the
  // resizing defaults would collapse every column to the uniform
  // default width. Compute the virtualization decision up-front (the
  // resolver is a pure, hoisted function) and gate resizing on it.
  const willVirtualizeEarly =
    decideVirtualization(virtualize, data.length) &&
    data.length > 0 &&
    !error &&
    !loading &&
    // Expandable rows (either mode) need the real <Table> — the virtualized
    // grid can't host colSpan slots or aligned sub-rows.
    !renderAlignedSubRows &&
    !(!!pagination && !!onPaginationChange && rowCount !== undefined);
  const resizingEnabled = enableColumnResizing && !willVirtualizeEarly;

  // Build the useTable props, handling the pagination discriminated union
  const tableProps = pagination && onPaginationChange && rowCount !== undefined
    ? {
        data,
        columns,
        loading,
        error,
        emptyState,
        resourceName,
        sortableColumns,
        sortBy,
        sortOrder,
        onSortChange,
        onRowClick,
        getRowId,
        getRowCanExpand,
        renderAlignedSubRows,
        onRowSelectionChange: effectiveOnRowSelectionChange,
        selectedRows: effectiveSelectedRows,
        selectionControls: effectiveSelectionControls,
        selectionEnabled,
        columnVisibility,
        onColumnVisibilityChange,
        pagination,
        onPaginationChange,
        rowCount,
        enableColumnResizing: resizingEnabled,
        containerClassName: filledContainerClassName,
        scrollWrapperClassName: filledScrollWrapperClassName,
      }
    : {
        data,
        columns,
        loading,
        error,
        emptyState,
        resourceName,
        sortableColumns,
        sortBy,
        sortOrder,
        onSortChange,
        onRowClick,
        getRowId,
        getRowCanExpand,
        renderAlignedSubRows,
        onRowSelectionChange: effectiveOnRowSelectionChange,
        selectedRows: effectiveSelectedRows,
        selectionControls: effectiveSelectionControls,
        selectionEnabled,
        columnVisibility,
        onColumnVisibilityChange,
        enableColumnResizing: resizingEnabled,
        containerClassName: filledContainerClassName,
        scrollWrapperClassName: filledScrollWrapperClassName,
      };

  // `tableProps` is one branch of a discriminated union (paginated vs. not);
  // TypeScript can't unify the branches through the spread, so we narrow to
  // the exact target type. `UseTableProps<T>` is the correct shape here —
  // this is NOT a loose cast.
  const { table, ...rest } = useTable(tableProps as unknown as UseTableProps<T>);

  // Hover-prefetch — fire the consumer's `onRowPrefetch` once per row so it
  // can warm that row's detail route before the click. Reuses the standard
  // <Table>'s per-row `rowProps` hook; deduped by row id via a ref. The router
  // lives in the consumer, NOT here, so a DataTable can render without an
  // app-router context. Entity lists render ≤ the windowed row set (well under
  // the virtualization threshold), so they take the standard <Table> path this
  // attaches to.
  //
  // The DWELL is the important part. This used to fire on bare
  // `onMouseEnter`, so moving the pointer from the filter bar to a row near
  // the bottom prefetched every row it crossed on the way — fifty route
  // prefetches for one intended click. Requiring the pointer to REST on a row
  // first turns "passed over" into "looking at", which is the signal we
  // actually wanted; a genuine hover-then-click clears 120 ms long before the
  // click lands.
  const prefetchedRows = useRef<Set<string>>(new Set());
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (dwellTimer.current) clearTimeout(dwellTimer.current);
    },
    [],
  );
  // <Table> memoizes each row and compares `rowProps` by identity, so a
  // fresh `{ onMouseEnter, onMouseLeave }` per render would re-render
  // every row on every parent render — the exact cost that memo exists
  // to remove, on the seven list pages that wire prefetch. Hand back
  // ONE handler object per row id instead.
  //
  // Nothing captured in that object is allowed to go stale: the entry
  // holds the CURRENT `Row` (refreshed on each lookup below) and the
  // handlers read `onRowPrefetchRef`, so a cached handler always fires
  // against this render's row and this render's callback.
  const onRowPrefetchRef = useRef(onRowPrefetch);
  useEffect(() => {
    onRowPrefetchRef.current = onRowPrefetch;
  });
  // Keyed by row id so a row keeps ONE handler identity across renders —
  // that stability is what lets the memo below actually bite.
  //
  // Bounded on purpose. Without a cap this grows one entry per row id ever
  // seen for the lifetime of the mount, which on an infinite-scroll list is
  // unbounded retention introduced by a performance change — the wrong trade
  // to make while fixing re-renders. The cap is generous relative to any
  // rendered window, so eviction only reaches ids that scrolled out long ago;
  // an evicted row simply builds a fresh handler next time it is rendered,
  // which costs one object and is correct either way.
  const prefetchHandlers = useRef(
    new Map<
      string,
      { row: Row<T>; props: HTMLAttributes<HTMLTableRowElement> }
    >(),
  );
  const prefetchRowProps = onRowPrefetch
    ? (row: Row<T>) => {
        const cached = prefetchHandlers.current.get(row.id);
        if (cached) {
          cached.row = row;
          return cached.props;
        }
        if (prefetchHandlers.current.size >= PREFETCH_HANDLER_CACHE_MAX) {
          // Map iterates in insertion order, so this drops the oldest ids —
          // the ones furthest from the current window.
          const oldest = prefetchHandlers.current.keys().next();
          if (!oldest.done) prefetchHandlers.current.delete(oldest.value);
        }
        const entry: {
          row: Row<T>;
          props: HTMLAttributes<HTMLTableRowElement>;
        } = { row, props: {} };
        entry.props = {
          onMouseEnter: () => {
            if (prefetchedRows.current.has(entry.row.id)) return;
            if (dwellTimer.current) clearTimeout(dwellTimer.current);
            dwellTimer.current = setTimeout(() => {
              prefetchedRows.current.add(entry.row.id);
              onRowPrefetchRef.current?.(entry.row);
            }, ROW_PREFETCH_DWELL_MS);
          },
          onMouseLeave: () => {
            // Left before the dwell elapsed — the pointer was passing through.
            if (dwellTimer.current) clearTimeout(dwellTimer.current);
          },
        };
        prefetchHandlers.current.set(row.id, entry);
        return entry.props;
      }
    : undefined;

  // The outermost wrapper exists for the dataTestId / id hooks the
  // E2E suite uses. When fillBody is on it participates in the
  // flex chain (max-h-full + flex flex-col + overflow-hidden) so
  // the inner card's max-h-full can resolve to a finite parent
  // height. NO flex-1 — see filledContainerClassName comment.
  const wrapperClassName = fillBody
    ? "md:flex md:flex-col md:max-h-full md:min-h-0 md:overflow-hidden"
    : undefined;

  // Epic 68 — auto-virtualize above the threshold unless the caller
  // overrides. Virtualization is force-disabled when features
  // unsupported by the virtualized renderer are requested:
  //   - server-side pagination (the footer + page buttons live on
  //     <Table> only; virtualization replaces pagination by rendering
  //     the full row set with a windowed viewport)
  //   - error / empty / loading rendering paths still need <Table>
  //     today — when no rows exist there's nothing to virtualize, so
  //     <Table>'s richer empty/error chrome is the correct surface.
  const useVirtual = willVirtualizeEarly;

  // Mobile PR-2 — below `md` (a phone) swap the wide table for a stacked card
  // list so nothing overflows / truncates. Only when there are real rows;
  // loading / error / empty keep the <Table>'s own chrome. `useIsBelowMd`
  // resolves to `false` on SSR/first-render and under jsdom, so the desktop
  // table is the default everywhere except a real narrow viewport.
  const belowMd = useIsBelowMd();
  if (belowMd && data.length > 0 && !error && !loading) {
    return (
      <div id={dataTestId} data-testid={dataTestId} className={wrapperClassName}>
        <DataTableCards<T> table={table} onRowClick={onRowClick} />
      </div>
    );
  }

  if (useVirtual) {
    return (
      <div id={dataTestId} data-testid={dataTestId} className={wrapperClassName}>
        <VirtualTable<T>
          table={table}
          rowHeight={virtualRowHeight}
          height={virtualHeight}
          onRowClick={onRowClick}
          selectionEnabled={selectionEnabled}
          sortableColumns={sortableColumns}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSortChange={onSortChange}
          onReachEnd={onReachEnd}
          containerClassName={filledContainerClassName}
          scrollWrapperClassName={filledScrollWrapperClassName}
        />
      </div>
    );
  }

  return (
    <div id={dataTestId} data-testid={dataTestId} className={wrapperClassName}>
      <Table
        {...rest}
        table={table}
        data={data}
        rowProps={prefetchRowProps}
        onReachEnd={onReachEnd}
      />
    </div>
  );
}

/**
 * Resolve the `virtualize` prop into a boolean. Pure function, also
 * exported for direct test coverage of the threshold contract.
 */
export function decideVirtualization(
  virtualize: DataTableVirtualize,
  rowCount: number,
): boolean {
  if (virtualize === false) return false;
  if (virtualize === true) return true;
  const threshold =
    typeof virtualize === "object" && virtualize !== null
      ? virtualize.threshold
      : VIRTUALIZE_DEFAULT_THRESHOLD;
  return rowCount > threshold;
}
