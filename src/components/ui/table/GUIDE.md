# DataTable Platform — Developer Guide

> **This is the canonical table system for all list pages in Inflect Compliance.**
> Do NOT create new `<table>` elements in list-page components.
> Use `<DataTable>` from `@/components/ui/table` instead.

---

## Quick Start — Adding a New List Page

```tsx
'use client';
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, createColumns } from '@/components/ui/table';

interface Policy {
  id: string;
  title: string;
  status: string;
}

const STATUS_BADGE: Record<string, string> = {
  DRAFT: 'badge-neutral',
  PUBLISHED: 'badge-success',
};

export function PoliciesTable({ policies }: { policies: Policy[] }) {
  const router = useRouter();

  // ① Define columns with useMemo (MUST be outside JSX)
  const columns = useMemo(() => createColumns<Policy>([
    {
      accessorKey: 'title',
      header: 'Title',
      cell: ({ getValue }) => (
        <span className="font-medium text-content-emphasis">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <StatusBadge variant={STATUS_BADGE[row.original.status]}>
          {row.original.status}
        </StatusBadge>
      ),
    },
  ]), []);

  // ② Render DataTable
  return (
    <DataTable
      data={policies}
      columns={columns}
      getRowId={(p) => p.id}
      onRowClick={(row) => router.push(`/policies/${row.original.id}`)}
      emptyState="No policies found"
      resourceName={(plural) => plural ? 'policies' : 'policy'}
      data-testid="policies-table"
    />
  );
}
```

---

## Column Definition Patterns

### Simple text column
```tsx
{ accessorKey: 'name', header: 'Name' }
```

### Computed accessor
```tsx
{
  id: 'owner',
  header: 'Owner',
  accessorFn: (row) => row.owner?.name || '—',
}
```

### Badge / status column
```tsx
{
  accessorKey: 'status',
  header: 'Status',
  cell: ({ row }) => (
    <StatusBadge variant={STATUS_BADGE[row.original.status]}>
      {row.original.status}
    </StatusBadge>
  ),
}
```

### Actions column (non-hideable)
```tsx
{
  id: 'actions',
  header: 'Actions',
  enableHiding: false,
  cell: ({ row }) => (
    <div className="flex gap-1" onClick={e => e.stopPropagation()}>
      <button onClick={() => deleteItem(row.original.id)}>
        Delete
      </button>
    </div>
  ),
}
```

### Date column with overdue indicator
```tsx
{
  id: 'dueAt',
  header: 'Due Date',
  cell: ({ row }) => {
    const d = row.original.dueAt;
    if (!d) return <span className="text-slate-400">—</span>;
    return (
      <span className="text-xs">
        {formatDate(d)}
        {new Date(d) < new Date() && (
          <StatusBadge variant="error" className="ml-1">Overdue</StatusBadge>
        )}
      </span>
    );
  },
}
```

---

## Key Rules

### ✅ DO
- Define columns with `useMemo` at the **top level** of your component
- Use `createColumns<T>()` for type safety
- Pass `getRowId` for selection, keying, and identity
- Use `emptyState` prop instead of manual empty-state `<div>`
- Use `loading` prop instead of `SkeletonTableRow`
- Use `onRowClick` for row-level navigation
- Add `data-testid` for E2E targeting
- Use `enableHiding: false` on action columns

### ❌ DON'T
- Do **NOT** use `<table>` elements in list-page client components
- Do **NOT** import `SkeletonTableRow` — `DataTable` handles loading internally
- Do **NOT** define columns inside JSX/IIFEs — this violates React hooks rules
- Do **NOT** create ad-hoc loading/empty states — use `DataTable` props instead

---

## Available Features

### Loading & Empty States
```tsx
<DataTable
  data={items}
  columns={columns}
  loading={isLoading}
  emptyState="No items yet"
/>
```

### Row Click Navigation
```tsx
<DataTable
  onRowClick={(row) => router.push(`/items/${row.original.id}`)}
/>
```

### Batch Selection
```tsx
<DataTable
  batchActions={[
    { label: 'Export', icon: <Download />, onClick: (rows) => exportRows(rows) },
    { label: 'Delete', variant: 'danger', onClick: (rows) => deleteRows(rows) },
  ]}
/>
```

### Column Visibility Persistence
```tsx
import {
  readPersistedVisibility,
  writePersistedVisibility,
  mergeVisibility,
  type ColumnVisibilityConfig,
} from '@/components/ui/table';

const VIS_CONFIG: ColumnVisibilityConfig = {
  all: ['name', 'status', 'owner', 'updatedAt'],
  defaultVisible: ['name', 'status'],
  fixed: ['name'],
};

// In your component:
const [visibility, setVisibility] = useState(() =>
  mergeVisibility(readPersistedVisibility('controls'), VIS_CONFIG)
);

<DataTable
  columnVisibility={visibility}
  onColumnVisibilityChange={(v) => {
    setVisibility(v);
    writePersistedVisibility('controls', v);
  }}
/>
```

### Pagination
```tsx
const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });

<DataTable
  pagination={pagination}
  onPaginationChange={setPagination}
  rowCount={totalCount}
/>
```

---

## Barrel Export

All public APIs come from `@/components/ui/table`:

```tsx
import {
  DataTable,
  createColumns,
  type ColumnDef,
  type ColumnVisibilityConfig,
  mergeVisibility,
  getDefaultVisibility,
  readPersistedVisibility,
  writePersistedVisibility,
  EditColumnsButton,
  PaginationControls,
  TableEmptyState,
} from '@/components/ui/table';
```

---

## TanStack Table v9 — where the feature set lives

The platform is built on TanStack Table **v9**, which composes capabilities
explicitly instead of accepting one row-model factory per capability. Two
things follow, and both are absorbed inside this directory:

1. **`features.ts` is the single declaration of what these tables can do.**
   Every method the platform calls on `table` / `row` / `column` / `header`
   exists because a feature registered there put it on the instance. Need a
   capability the platform does not have yet (grouping, column ordering,
   client-side filtering)? Add its feature to `tableFeatures({ … })` there —
   not to a call site.

2. **Type arguments stay inside the platform.** v9's public types take the
   feature set FIRST — `ColumnDef<TFeatures, TData, TValue>`. `types.ts`
   binds that argument once and re-exports the same names at the arity call
   sites already use, so a page writes `ColumnDef<MyRow>` and imports it
   from `@/components/ui/table`:

   ```tsx
   import { createColumns, type ColumnDef, type Row } from '@/components/ui/table';
   ```

   **Never import a table type from `@tanstack/react-table` in an app page.**
   One type argument fails outright — `Generic type 'ColumnDef' requires
   between 2 and 3 type arguments` (TS2707), `Row` likewise (TS2314). Two
   arguments is the dangerous one: `ColumnDef<MyRow, MyValue>` binds `MyRow`
   to the FEATURE slot and `MyValue` to the row slot, compiles, and then
   `row.original` is whatever `MyValue` was — which surfaces as a spray of
   unrelated-looking errors in the cell renderers rather than at the import.

A generic component that forwards a row type to `<DataTable>` needs the
`TableRowData` bound (v9 requires a row type to be an object or an array):
`function MyList<TRow extends TableRowData>(…)`. `TableRowData` is exported
from the barrel too.

---

## Architecture Compliance

Architecture compliance tests in `tests/unit/data-table.test.ts` enforce:

1. **No ad-hoc `<table>` in migrated pages** — every `*Client.tsx` must use `DataTable`
2. **No `SkeletonTableRow` imports** — `DataTable` handles loading
3. **Excluded pages are documented** — `SoAClient` and `AuditsClient` are intentional exceptions

If CI fails with "uses DataTable (not ad-hoc `<table>`)", migrate the offending page.

---

## Remaining `.data-table` CSS Usage

The `.data-table` CSS class in `globals.css` is still used by:
- **Detail page sub-tables** (control detail tasks/evidence/mappings)
- **Admin sub-pages** (members, API keys, roles, integrations, etc.)
- **SoAClient** (intentional exclusion — expandable rows)
- **Risk import preview** page

These are **secondary tables embedded in detail views**, not primary list pages.
They can be migrated in future work but are lower priority.
The `.data-table` CSS class should NOT be removed until these are migrated.
