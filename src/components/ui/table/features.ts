/**
 * The table platform's TanStack Table **feature set** — the single place in
 * the repo where the library's feature composition is declared.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 * TanStack Table v9 replaced v8's "pass a row-model factory per capability"
 * shape (`getCoreRowModel()`, `getExpandedRowModel()`, …) with explicit
 * feature composition: you hand `useTable` a `features` object and the
 * library derives the whole typed surface — table options, table/row/column
 * APIs, state slices, and which keys a `ColumnDef` may carry — from it.
 *
 * Because that feature set is now the FIRST type parameter of nearly every
 * public type (`ColumnDef<TFeatures, TData, TValue>`,
 * `Row<TFeatures, TData>`, `Table<TFeatures, TData>`), leaving it implicit
 * would push a `dataTableFeatures` type argument onto every column
 * definition on every list page. Declaring it once here, and re-exporting
 * feature-bound aliases from `./types`, keeps that parameter inside the
 * platform: app pages write `ColumnDef<MyRow>` exactly as before, only
 * imported from `@/components/ui/table` instead of `@tanstack/react-table`.
 *
 * ── What is registered, and why ─────────────────────────────────────────
 * Each entry below is load-bearing — it is what makes a specific API the
 * platform already calls type-check and exist at runtime. Removing one
 * silently deletes the corresponding methods from the table instance:
 *
 *   columnVisibilityFeature  `column.getIsVisible/toggleVisibility`,
 *                            `row.getVisibleCells`,
 *                            `table.getVisibleLeafColumns`, the
 *                            `columnVisibility` state slice, and
 *                            `enableHiding` on a ColumnDef.
 *   columnPinningFeature     `column.getIsPinned`, the `columnPinning`
 *                            state slice (see the identity-stability note
 *                            in `table.tsx` — pinning drives the row memo).
 *   columnSizingFeature      `column.getSize/getStart/getAfter`,
 *                            `table.setColumnSizing`, `size`/`minSize`/
 *                            `maxSize` on a ColumnDef.
 *   columnResizingFeature    `column.getCanResize`, `header.getResizeHandler`,
 *                            the `enableColumnResizing` + `columnResizeMode`
 *                            options. Requires columnSizingFeature.
 *   rowSelectionFeature      `row.getIsSelected/toggleSelected`,
 *                            `table.getSelectedRowModel/
 *                            toggleAllRowsSelected/resetRowSelection`, the
 *                            `rowSelection` state slice. Selection is
 *                            DEFAULT-ON for the platform (R12-PR1), so this
 *                            is not optional.
 *   rowExpandingFeature      `row.getCanExpand/getIsExpanded/toggleExpanded`
 *                            + `getRowCanExpand`, backing the aligned
 *                            sub-row affordance.
 *   rowPaginationFeature     the `pagination` state slice and the
 *                            `manualPagination` / `rowCount` /
 *                            `onPaginationChange` options.
 *   rowSortingFeature        `enableSorting` on a ColumnDef and the
 *                            `manualSorting` option. The platform sorts
 *                            through its own props (`sortableColumns`,
 *                            `onSortChange`) rather than TanStack's sorting
 *                            state, so no `sortedRowModel` is registered —
 *                            but the ColumnDef key must still be legal.
 *
 * ── Row models ──────────────────────────────────────────────────────────
 * v9 always builds the core row model, so v8's `getCoreRowModel()` has no
 * successor and simply disappears. Only `expandedRowModel` is registered:
 * the pipeline runs core → filtering → grouping → sorting → expanding →
 * pagination, and each un-registered stage passes its input straight
 * through.
 *
 * `expandedRowModel` is INERT today, and that is deliberate — do not read it
 * as backing the expand affordance. TanStack's expanded row model only
 * flattens `row.subRows` into the row list, and nothing in this repo
 * populates `subRows` (zero references outside this file); the platform's
 * expansion is `rowExpandingFeature` state plus a consumer-rendered
 * `renderAlignedSubRows`. Removing the slot leaves every expansion test
 * green, so no test can tell it is here. It stays for v8 parity: if a
 * consumer ever does populate `subRows`, expansion flattens as it always
 * did rather than silently ignoring them. Filtering, grouping and sorting are all done outside the table
 * by the page, and pagination is `manualPagination: true`, so registering
 * their row models would be dead weight that also drags every built-in
 * filter/sort function into the bundle.
 */
import {
    columnPinningFeature,
    columnResizingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    createExpandedRowModel,
    rowExpandingFeature,
    rowPaginationFeature,
    rowSelectionFeature,
    rowSortingFeature,
    tableFeatures,
} from "@tanstack/react-table";

/**
 * The feature object handed to `useTable`. Declared at module scope (not
 * inside a component) as TanStack recommends — it is static data, and a
 * fresh object per render would rebuild the table's feature registry.
 */
export const dataTableFeatures = tableFeatures({
    columnPinningFeature,
    columnResizingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    rowExpandingFeature,
    rowPaginationFeature,
    rowSelectionFeature,
    rowSortingFeature,
    expandedRowModel: createExpandedRowModel(),
});

/**
 * The type of the platform's feature set — the `TFeatures` argument bound
 * into every alias exported from `./types`. Nothing outside this directory
 * should need to name it.
 */
export type DataTableFeatures = typeof dataTableFeatures;
