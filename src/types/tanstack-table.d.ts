/**
 * Module augmentation for @tanstack/react-table — extends `ColumnMeta`
 * with the custom fields read by the DataTable / Table primitives
 * (`src/components/ui/table/`).
 *
 * Lives in `src/types/` alongside the other ambient declarations
 * (`globals.d.ts`): a `.d.ts` carries no runtime exports, so it must
 * stay out of the table directory — the table-platform barrel
 * guardrails require every `.ts`/`.tsx` file there to be re-exported
 * from `index.ts`, which an ambient declaration cannot be.
 *
 * v9 note — the interface gained a leading `TFeatures` parameter (and
 * explicit `in out` variance annotations on the first two). Declaration
 * merging requires the type parameter list to match the library's
 * ORIGINAL declaration exactly: same names, same constraints, same
 * defaults, same variance annotations. A mismatch is TS2428
 * ("All declarations of 'ColumnMeta' must have identical type
 * parameters"), not a silent no-op, so this list is copied verbatim from
 * `@tanstack/table-core/dist/types/ColumnDef.d.ts` and must be updated
 * with it.
 *
 * v9 also offers a per-table alternative — a `columnMeta` type-only slot
 * on the `tableFeatures({ … })` object in
 * `src/components/ui/table/features.ts`. The global augmentation is kept
 * instead because it applies to EVERY table, including any built with a
 * different feature set, and because `ExtractColumnMeta` falls back to
 * this interface precisely when the slot is absent. Do not declare both:
 * the feature slot silently wins and these fields would vanish.
 */
import "@tanstack/react-table";
import type { CellData, RowData, TableFeatures } from "@tanstack/react-table";

declare module "@tanstack/react-table" {
    interface ColumnMeta<
        in out TFeatures extends TableFeatures,
        in out TData extends RowData,
        TValue extends CellData = CellData,
    > {
        /** When true, the cell text will NOT be clipped with a truncation ellipsis. */
        disableTruncate?: boolean;
        /** Optional tooltip text rendered next to the column header label. */
        headerTooltip?: string;
    }
}
