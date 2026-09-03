/* eslint-disable @typescript-eslint/no-explicit-any --
 * The `any` DEFAULT on `TValue` below is load-bearing, and it is the same
 * default this file carried under v8 (`ColumnDef<T, any>[]`). A column's
 * cell renderer reads `getValue()`, whose return type is `TValue`; with
 * `unknown` there, every `cell: ({ getValue }) => <span>{getValue()}</span>`
 * in the product stops compiling — measured at 44 errors across 15 pages.
 * Narrowing it is a real cleanup, but it is a per-column-def change on every
 * page, not part of a library migration.
 */
/**
 * Project-local, feature-bound aliases over TanStack Table's public types,
 * plus the prop contracts for `useTable` / `<Table>`.
 *
 * ── The seam ────────────────────────────────────────────────────────────
 * TanStack Table v9 made the table's FEATURE SET the first type parameter
 * of nearly every public type — `ColumnDef<TFeatures, TData, TValue>`,
 * `Row<TFeatures, TData>`, `Table<TFeatures, TData>`. Every call site that
 * wrote `ColumnDef<MyRow>` under v8 would otherwise have to write
 * `ColumnDef<typeof dataTableFeatures, MyRow>` under v9.
 *
 * This module binds `DataTableFeatures` (see `./features`) once and
 * re-exports the SAME NAMES with the v8 arity. App pages therefore change
 * their import source — `@tanstack/react-table` → `@/components/ui/table`
 * — and nothing else; the next time the library reshapes its generics,
 * this file absorbs it instead of every list page.
 *
 * These aliases are re-exported by the table barrel (`./index`), so the
 * canonical app-side import is `@/components/ui/table`.
 */
import type {
  Cell as TanstackCell,
  Column as TanstackColumn,
  ColumnDef as TanstackColumnDef,
  ColumnPinningState,
  ColumnResizeMode,
  ColumnVisibilityState,
  ExpandedState,
  PaginationState,
  RowData,
  Row as TanstackRow,
  RowSelectionState,
  Table as TanstackTable,
} from "@tanstack/react-table";
import {
  Dispatch,
  HTMLAttributes,
  MouseEvent,
  PropsWithChildren,
  ReactNode,
  SetStateAction,
} from "react";
import type { DataTableFeatures } from "./features";

/**
 * The constraint TanStack v9 places on a table's row type — an object or an
 * array, i.e. not a primitive. v8 effectively allowed anything (its `RowData`
 * widened to `unknown`), so every generic in this platform that reaches a
 * TanStack type now has to carry the bound. Concrete row types — interfaces, type
 * aliases, classes — all satisfy it; only an UNCONSTRAINED generic does not,
 * which is why the platform's own `<T>` parameters name it explicitly.
 */
export type TableRowData = RowData;

/**
 * Column definition bound to the platform's feature set.
 *
 * `TValue` defaults to `any` rather than TanStack's `unknown` — see the
 * file-header note. This preserves the exact ergonomics of the v8-era
 * `ColumnDef<T, any>` the platform used everywhere.
 */
export type ColumnDef<
  TData extends TableRowData,
  TValue = any,
> = TanstackColumnDef<DataTableFeatures, TData, TValue>;

/** A row instance bound to the platform's feature set. */
export type Row<TData extends TableRowData> = TanstackRow<
  DataTableFeatures,
  TData
>;

/** A cell instance bound to the platform's feature set. */
export type Cell<
  TData extends TableRowData,
  TValue = any,
> = TanstackCell<DataTableFeatures, TData, TValue>;

/** A column instance bound to the platform's feature set. */
export type Column<
  TData extends TableRowData,
  TValue = any,
> = TanstackColumn<DataTableFeatures, TData, TValue>;

/**
 * A table instance bound to the platform's feature set.
 *
 * Named `TableInstance`, not `Table`, because `./table` already exports a
 * `<Table>` React component and the barrel re-exports both with `export *`
 * — two `Table` exports would collide and silently drop the name.
 */
export type TableInstance<TData extends TableRowData> = TanstackTable<
  DataTableFeatures,
  TData
>;

/**
 * Un-parameterised state slices, re-exported so consumers have ONE import
 * source for the table platform. `ColumnVisibilityState` is v9's name for
 * what v8 called `VisibilityState`; the platform adopted the new name
 * rather than keeping an alias, so there is exactly one name for it.
 */
export type {
  ColumnPinningState,
  ColumnResizeMode,
  ColumnVisibilityState,
  ExpandedState,
  RowSelectionState,
};

/**
 * `PaginationState` is deliberately NOT re-exported.
 *
 * `./pagination-utils` already exports its own `PaginationState` (the
 * cursor/offset shape the list APIs return, unrelated to TanStack's
 * `{ pageIndex, pageSize }`), and the barrel re-exports both modules with
 * `export *`. Two exports of one name are ambiguous and the symbol is
 * silently dropped. The three platform modules that need TanStack's shape
 * import it from the library directly.
 */

type BaseTableProps<T extends TableRowData> = {
  columns: ColumnDef<T>[];
  data: T[];
  loading?: boolean;
  error?: string;
  emptyState?: ReactNode;
  resourceName?: (plural: boolean) => string;

  defaultColumn?: Partial<ColumnDef<T>>;
  columnPinning?: ColumnPinningState;
  cellRight?: (cell: Cell<T>) => ReactNode;

  // Sorting
  sortableColumns?: string[];
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  onSortChange?: (props: {
    sortBy?: string;
    sortOrder?: "asc" | "desc";
  }) => void;

  // Column resizing
  enableColumnResizing?: boolean;
  columnResizeMode?: ColumnResizeMode;

  // Column visibility
  columnVisibility?: ColumnVisibilityState;
  onColumnVisibilityChange?: (visibility: ColumnVisibilityState) => void;

  // Row selection — R12-PR1 made the select column DEFAULT-ON. Pages
  // opt out by passing `selectionEnabled={false}` (rare: card-list
  // dashboards, single-row admin panels). Bulk actions still wire
  // through `selectionControls`; without them, the checkboxes just
  // toggle row state. Premium products (Linear, Stripe, Vercel)
  // always render the select column on row-record tables so the
  // selection affordance is at least visible.
  getRowId?: (row: T) => string;
  onRowSelectionChange?: (rows: Row<T>[]) => void;
  selectedRows?: RowSelectionState;
  selectionControls?: (table: TableInstance<T>) => ReactNode;
  /**
   * Opt out of the default-on select column. Pass `false` for tables
   * that are deliberately read-only at the row level (sub-component
   * sub-tables that the parent doesn't bulk-select, etc.).
   */
  selectionEnabled?: boolean;

  // Misc. row props
  onRowClick?: (row: Row<T>, e: MouseEvent) => void;
  onRowAuxClick?: (row: Row<T>, e: MouseEvent) => void;
  /**
   * Expandable rows. When `getRowCanExpand(row)` returns true the row shows a
   * leading chevron; toggling it renders `renderAlignedSubRows(row, ...)`
   * beneath it. Default OFF — without `renderAlignedSubRows` no chevron
   * renders and behaviour is unchanged, so every existing table is unaffected.
   */
  getRowCanExpand?: (row: Row<T>) => boolean;
  /**
   * Aligned expandable sub-rows: the consumer returns real `<tr>`/`<td>` rows
   * rendered as direct `<tbody>` siblings, so the browser's table layout
   * aligns their cells with the parent COLUMNS. `columnIds` is the ordered
   * list of currently-visible column ids — render one `<td>` per id so the
   * sub-row cells land under the matching columns (empty `<td>` for columns
   * a sub-row has no value for). Used by Controls to nest task rows that
   * align on category / status / owner / evidence.
   *
   * There used to be a SECOND expansion slot, `renderExpandedRow`, which
   * rendered one full-width `colSpan` cell. It had no consumer in the product
   * — this one exists precisely because a colSpan cell cannot align with the
   * columns — so it was two mechanisms and one behaviour. Removed 2026-08-08
   * (roadmap P3.2). If a full-width slot is genuinely wanted again, a consumer
   * can render a single `<td colSpan>` row from here.
   */
  renderAlignedSubRows?: (row: Row<T>, columnIds: string[]) => ReactNode;
  /**
   * Infinite-scroll (load-on-scroll). When set, a zero-height sentinel
   * renders inside the scroll wrapper at the bottom of the rows; it
   * fires `onReachEnd` when scrolled into view (with a pre-load margin)
   * so the consumer's windowing hook can append the next batch. Pass
   * `onReachEnd={hasMore ? loadMore : undefined}` so the sentinel — and
   * its observer — go away at the end of the data. Replaces the manual
   * `<TableLoadMoreFooter>` "Load more" button.
   */
  onReachEnd?: () => void;
  rowProps?:
    | HTMLAttributes<HTMLTableRowElement>
    | ((row: Row<T>) => HTMLAttributes<HTMLTableRowElement>);

  // Table styles
  className?: string;
  containerClassName?: string;
  scrollWrapperClassName?: string;
  emptyWrapperClassName?: string;
  thClassName?: string | ((columnId: string) => string);
  tdClassName?: string | ((columnId: string, row: Row<T>) => string);
};

export type UseTableProps<T extends TableRowData> = BaseTableProps<T> &
  (
    | {
        pagination?: PaginationState;
        onPaginationChange?: Dispatch<SetStateAction<PaginationState>>;
        rowCount: number;
      }
    | { pagination?: never; onPaginationChange?: never; rowCount?: never }
  );

export type TableProps<T extends TableRowData> = BaseTableProps<T> &
  PropsWithChildren<{
    table: TableInstance<T>;
  }> &
  (
    | {
        pagination?: PaginationState;
        paginationAllRowsHref?: string;
        rowCount: number;
      }
    | { pagination?: never; paginationAllRowsHref?: never; rowCount?: never }
  );
