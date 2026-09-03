# 2026-09-03 — TanStack Table v8 → v9 (feature composition at the platform boundary)

**Commit:** `<pending>` feat(table): migrate @tanstack/react-table v8.21.3 → v9.2.4 (#2263)
**Branch:** `feat/react-table-v9`

Closes #2263. Dependabot proposed this twice as a plain version bump (#2199,
#2259); both were correctly rejected — v9 is an API rewrite, not a bump.

## Design

### What actually changed in the library

Two changes, and the second is the one that produced the reported
"220 typecheck errors across 17 files".

**1. Capabilities are composed, not requested per row model.** v8 accepted a
row-model factory per capability (`getCoreRowModel()`,
`getExpandedRowModel()`, …). v9 removes `useReactTable`, `getCoreRowModel`
and `getExpandedRowModel` entirely and takes a `features` object built by
`tableFeatures({ … })`; the hook is now `useTable`. The core row model is
always built, so v8's `getCoreRowModel()` has no successor at all, and
`getExpandedRowModel()` becomes the `expandedRowModel` slot on that object.

**2. The feature set is the FIRST type parameter of every public type.**
`ColumnDef<TData, TValue>` became `ColumnDef<TFeatures, TData, TValue>`;
likewise `Row`, `Cell`, `Column`, `Table`. The platform spelled its aliases
`ColumnDef<T, any>` everywhere, so under v9 that binds `T` to `TFeatures`
and `any` to `TData` — it still COMPILES, and `row.original` silently
becomes `any`/`unknown` at the cell renderers. That is what the 46 × TS2322,
39 × TS7006 and 18 × TS18046 all are: one defect with a long tail, reported
everywhere except at the import that caused it. (A single-argument
`ColumnDef<MyRow>` is the loud case — TS2707, "requires between 2 and 3
type arguments".)

Three smaller renames rode along, each a real semantic change rather than a
spelling one:

| v8 | v9 | consequence |
| --- | --- | --- |
| `VisibilityState` | `ColumnVisibilityState` | same `Record<string, boolean>`; rename only |
| `RowSelectionState = Record<string, boolean>` | `Record<string, true>` | deselect by REMOVING the key, never by writing `false` |
| `ColumnPinningState { left, right }` | `{ start, end }` (and `ColumnPinningPosition` `'left' \| 'right'` → `'start' \| 'end'`) | logical, RTL-aware regions |

### v9 is ESM-only, and that is a test-harness break

Not a type change and not visible to `tsc`: v8 shipped a CommonJS build, v9
does not. Both `@tanstack/react-table` and `@tanstack/table-core` are
`"type": "module"` with an `exports` map carrying **no `require` condition
and no `main`**. Next handles that fine — `next build --webpack` in the CI
shape (`SKIP_ENV_VALIDATION=1`) succeeds — but Jest's CJS runtime cannot
load it at all.

The symptom is misleading twice over. It reports as

```
Must use import to load ES Module: node_modules/@tanstack/react-table/dist/index.js
  at Object.<anonymous> (src/components/ui/table/table.tsx:19:1)
```

— naming the file that *imported* the module, not the module at fault. And
it is invisible to any suite that only imports TYPES from the platform,
because those imports are erased: the source-contract suites
(`tests/unit/data-table.test.ts`, the table guards) stayed green while **11
of the 15 rendered table/combobox suites failed to RUN**. A "failed to run"
suite reports zero failing tests, so the summary line reads
`Tests: 36 passed` next to `Test Suites: 11 failed`.

Fix: both projects in `jest.config.js` allowlist
`@tanstack/(?:react-table|table-core)` for transform. Only those two —
`@tanstack/react-store` and `@tanstack/store` arrive as new transitive deps
of v9 but ship DUAL builds (`exports.require` → `dist/index.cjs`), so Jest
resolves them to CommonJS already and transforming them would be wasted
work.

### The seam

17 files imported `@tanstack/react-table`; 13 of them are the platform
(`src/components/ui/table/`). The other four are app-side and import TYPES
ONLY. So the whole migration is absorbed at the platform boundary:

```
src/components/ui/table/features.ts   ← tableFeatures({ … })  (NEW, the only
                                        place the library's composition is
                                        declared)
src/components/ui/table/types.ts      ← binds that feature set into
                                        ColumnDef / Row / Cell / Column /
                                        TableInstance and re-exports them at
                                        the v8 ARITY
src/components/ui/table/index.ts      ← barrel; app pages import from here
```

App pages changed their **import source** and nothing else:

```diff
-import type { ColumnDef } from '@tanstack/react-table';
+import type { ColumnDef } from '@/components/ui/table';
```

`ColumnDef<MyRow>` still reads `ColumnDef<MyRow>` at all 10 sites. The next
time TanStack reshapes its generics, `types.ts` absorbs it instead of every
list page.

### What still leaks past the platform directory

Being precise, because "the seam holds" is a claim worth quantifying. The
`@tanstack/react-table` import count went 17 files → 10, and 8 of those 10
are inside `src/components/ui/table/`. Zero app pages and zero tests import
the library any more. Three things cross the boundary, all of them
mechanical:

1. **Four app files + two tests swapped their import source** (five lines).
   No type arguments changed.
2. **`src/components/layout/EntityListPage.tsx`** — its `<TRow>` parameter is
   forwarded into `DataTableProps<TRow>`, so it needed `extends TableRowData`.
   v9 constrains a row type to *object or array* (v8's `RowData` widened to
   `unknown`, so anything went). Only *unconstrained generics* fail that
   bound; every concrete row type — interface, type alias, class — satisfies
   it, so no page that names its row type was touched. This is the one shape
   of change a future generic component will also have to make, which is why
   `TableRowData` is exported from the barrel and documented in `GUIDE.md`.
3. **`src/components/ui/hooks/use-column-visibility.ts`** still imports
   `ColumnVisibilityState` from the library. Deliberate: the table platform
   already imports *from* the hooks directory (`use-columns-dropdown` →
   `../hooks`), so pointing this file at the table barrel closes an import
   cycle. The type carries no feature parameter, so there is nothing for the
   seam to bind.

`src/types/tanstack-table.d.ts` stays where it is, for the reason it was put
there: the barrel guardrail requires every `.ts`/`.tsx` under
`src/components/ui/table/` to be re-exported from `index.ts`, and an ambient
declaration has no runtime exports. Its `ColumnMeta` augmentation gained the
leading `TFeatures` parameter and the library's `in out` variance
annotations — declaration merging requires the parameter list to match the
original **exactly**, so a mismatch is TS2428, not a silent no-op.

## Files

| File | Role |
| --- | --- |
| `package.json`, `package-lock.json` | `^8.21.3` → `^9.2.4`; two transitive additions (`@tanstack/react-store`, `@tanstack/store`), three changed entries, nothing removed |
| `jest.config.js` | allowlists the two ESM-only TanStack packages for transform on BOTH projects — see above; without it every runtime importer of the table platform fails to load |
| `src/components/ui/table/features.ts` | **new** — `tableFeatures({ … })`; the sole declaration of what these tables can do, with a per-feature note on which API each one keeps alive |
| `src/components/ui/table/types.ts` | binds `DataTableFeatures` into the public type aliases; adds `TableRowData`; renames `VisibilityState` → `ColumnVisibilityState` |
| `src/components/ui/table/table.tsx` | `useReactTable` → `useTable as useTanstackTable`; row-model factories → `features:`; pinning `left/right` → `start/end`; range-select rewritten for `Record<string, true>` |
| `src/components/ui/table/data-table.tsx` | drops its duplicate `ColumnDef` re-export (`types.ts` owns it now — two `export *` sources for one name silently drop the symbol); adds the named `DataTableVirtualize` type |
| `src/components/ui/table/{virtual-table-body,data-table-cards,selection-toolbar,edit-columns-button,column-visibility-utils,use-columns-dropdown,use-table-pagination,use-list-pagination}` | import from `./types` instead of the library; generics gain the `TableRowData` bound |
| `src/components/ui/table/index.ts` | re-exports `./features` (barrel rule) |
| `src/components/ui/table/GUIDE.md` | new section: where the feature set lives, and why an app page must never import a table type from the library |
| `src/types/tanstack-table.d.ts` | `ColumnMeta` augmentation updated to v9's parameter list |
| `src/components/layout/EntityListPage.tsx` | `<TRow extends TableRowData>` |
| `src/components/ui/hooks/use-column-visibility.ts` | `VisibilityState` → `ColumnVisibilityState` |
| 4 app clients, 3 tests | import-source swap + the two encoding contracts below |

## Decisions

- **`TValue` keeps an `any` default on the platform's `ColumnDef` alias.**
  This is the one place the migration deliberately did NOT tighten. v9's own
  default is `unknown`; the platform's v8-era alias was `ColumnDef<T, any>`
  at every site, and `TValue` is what `getValue()` returns. Defaulting to
  `unknown` produced **44 errors across 15 pages** — every
  `cell: ({ getValue }) => <span>{getValue()}</span>` in the product. Fixing
  those is a real cleanup, but it is a per-column-def change on 15 pages and
  has nothing to do with the library version; bundling it here would have
  turned an import-source migration into a product-wide edit. The `any` sits
  in ONE place with a written rationale, which is strictly better than the
  v8 state where it was spelled at every alias site.

- **Composed the features explicitly rather than using `useLegacyTable`.**
  v9 ships a compat layer at `@tanstack/react-table/legacy` (`useLegacyTable`,
  `getCoreRowModel`, `LegacyColumnDef<TData, TValue>`) that would have made
  this a near-zero diff. Rejected: every symbol on it is `@deprecated`, it
  registers the FULL `StockFeatures` set (defeating the tree-shaking that is
  v9's headline change, and pulling every built-in filter/sort/aggregation
  function into the bundle), and it will be removed in a future major — so it
  buys a smaller diff today in exchange for doing this migration twice. The
  explicit composition is ~40 lines in one new file.

- **Registered eight features plus one row-model slot, not `stockFeatures`.** Each entry in
  `features.ts` is justified by an API the platform actually calls, listed in
  that file's header. `rowSortingFeature` is registered even though the
  platform sorts through its own props (`sortableColumns` / `onSortChange`
  and `sort-rows.ts`) and registers no `sortedRowModel`: without it,
  `enableSorting` is not a legal `ColumnDef` key, and four call sites use it —
  including the row-chevron column that
  `tests/guards/datatable-row-chevron-affordance.test.ts` pins.

- **Named the table-instance alias `TableInstance`, not `Table`.**
  `./table` already exports a `<Table>` React component and the barrel
  re-exports both with `export *`. Two exports of one name are ambiguous and
  the symbol is silently dropped — a runtime-shaped failure from a
  type-shaped edit.

- **`PaginationState` is deliberately NOT re-exported from `types.ts`.**
  `./pagination-utils` already owns that name on the barrel with a different
  shape (the cursor/offset envelope the list APIs return, not TanStack's
  `{ pageIndex, pageSize }`). The three platform modules that need TanStack's
  import it from the library directly.

- **Kept the global `ColumnMeta` augmentation instead of moving to v9's
  per-table `columnMeta` slot.** v9 lets a feature set declare
  `columnMeta: {} as MyMeta` and that type then wins. The global augmentation
  was kept because it applies to every table regardless of feature set, and
  because `ExtractColumnMeta` falls back to it precisely when the slot is
  absent. Declaring both is the trap — the slot silently wins and
  `disableTruncate` / `headerTooltip` would vanish from the type without an
  error anywhere. The `.d.ts` says so.

- **Row deselection is now key removal.** `RowSelectionState` narrowing to
  `Record<string, true>` is not cosmetic: the shift-click range handler in
  `table.tsx` used to write `false` for a deselecting range. Both encodings
  READ the same (`row.getIsSelected()` is truthiness), so behaviour is
  unchanged — but the write had to move to `delete next[id]`. The
  `tests/unit/data-table.test.ts` selection contracts were rewritten to
  assert the absent-key encoding rather than edited until they compiled.

- **Column pinning is now logical (`start`/`end`), and the CSS mapping is an
  explicit LTR assumption.** `getCommonPinningStyles` maps `start → left`
  and `end → right`, which is what v8 did unconditionally. The comment says
  so, so an RTL effort has one place to look. Also note the identity-stability
  lesson recorded in `table.tsx` survives verbatim under the new key names:
  `columnPinningState` must stay a `useMemo`, because TanStack compares the
  slice by identity and a fresh literal makes the row memo inert.

- **`table.getIsSomeRowsSelected()` changed meaning, and it happens not to
  matter here.** v8 returned "some but NOT all"; v9 returns "at least one"
  (`getSelectedRowIds().length > 0`). Both call sites — the select-all header
  cell in `table.tsx` and the toolbar checkbox in `selection-toolbar.tsx` —
  read it only in the ternary's second arm, after
  `getIsAllRowsSelected()` has already short-circuited the all-selected case,
  so within that branch the two definitions coincide and the indeterminate
  state is unchanged. Worth writing down because the next caller may not be
  guarded the same way: reading `getIsSomeRowsSelected()` on its own now
  returns `true` when everything is selected.

- **No new import-ban guard was added, deliberately.** The obvious ratchet
  ("no app page imports a table type from `@tanstack/react-table`") would
  duplicate a check the compiler already performs: `ColumnDef<MyRow>` against
  the library type binds `MyRow` to `TFeatures`, leaves `TData` unbound and
  fails to compile at the call site. Per the epic-ratchet lifecycle rule, a
  guard whose true-positive rate is structurally zero is not worth its
  maintenance. The residual case a guard WOULD catch — someone writing
  `ColumnDef<typeof dataTableFeatures, MyRow>` by hand to route around the
  seam — is visible in review and has never occurred. `GUIDE.md` documents
  the rule where a contributor will read it.
