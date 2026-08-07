# 2026-08-07 — The Risks list's Asset column had no data behind it

**Commit:** _(see branch `test/risk-filter-extraction`)_

Box 1's B1-3. A one-field defect with a disproportionate effect, plus a
declined extraction from B3-5 recorded so the reasoning survives.

## Design

The Risks list has rendered an **Asset** column since it shipped —
sortable, toggleable, with an i18n key and a `colVis` entry — while
`riskListSelect` in `RiskRepository.ts` selected no asset at all. Every row
showed `—`, and sorting by the column was a no-op.

That is worse than having no column. An empty Asset column is not a missing
feature; it is a **false claim about the tenant's data**: "no risk here is
linked to an asset." A user auditing coverage would read it and believe it.

Nothing caught it because every layer was individually coherent — the column
def, the sort accessor, the i18n key, and a type declaring
`asset: { name: string } | null` all existed and agreed with each other. Only
reading a row back from the repository shows the field was never populated.

It could not have been populated as typed, either: **`Risk` has no singular
asset relation.** The real one is the many-to-many `AssetRiskLink`. So the
declared shape was wrong as well as unfilled — the type described a product
that does not exist.

### The shape that replaces it

```
assetLinks: { select: { asset: { select: { id, name } } }, orderBy: { createdAt: 'asc' }, take: 1 },
_count:     { select: { assetLinks: true } },
```

`take: 1` keeps a risk wired to fifty assets from fanning the list query out;
`_count` supplies the honest total. The cell renders `Payroll DB +2` rather
than naming one asset as though it were the only one — the failure mode a
naive `assetLinks[0].asset.name` would have introduced while looking correct
in every test with a single link.

The same helper is the sort accessor, so ordering follows the first-linked
asset and unlinked rows sort together under the em-dash.

No new index was needed: `AssetRiskLink` already carries
`@@index([tenantId, riskId])`.

## Why the filter-bar extraction was declined

B3-5 lists three components to extract from `RisksClient`: the ALE chip
(done, #1801), the collision callouts (done, #1802), and **the filter bar**.
The third should not be done:

- `RisksFilterToolbar` is already a self-contained 40-line component in the
  file. It composes `buildRiskFilters` and `FilterToolbar` and has no
  behaviour of its own.
- Both halves are already covered — `tests/unit/risks-filter-defs.test.ts`
  and `tests/rendered/filter-toolbar-live-search.test.tsx`. A rendered test
  of the composition would assert nothing new.
- Moving it out would **break** `tests/guards/r14-no-page-searchbars.test.ts`,
  which requires `searchId` + `searchPlaceholder` to appear in
  `RisksClient.tsx` itself and applies the same rule to all seven list
  clients. Extraction would force either a red guard or a per-entity
  carve-out in a set-completeness check.

The first two extractions were worth it because the markup was inline and
its behaviour untestable. This one is neither.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/repositories/RiskRepository.ts` | Selects the bounded asset link + count |
| `src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx` | Correct row type; `assetCellLabel` helper doubles as the sort accessor |
| `tests/integration/risks-list-asset-column.test.ts` | NEW — the column carries data, bounds the fetch, stays tenant-scoped |

## Decisions

- **Fixed rather than removed.** The column, its sort accessor, its filter
  and its `colVis` entry all already existed; only the data was missing, and
  the relation is real product data. Deleting would have thrown away a
  useful list dimension to resolve a one-line omission.
- **`take: 1` + `_count`, not an unbounded include.** The obvious fix —
  selecting every link — turns one list query into a fan-out proportional to
  link density, on the page most likely to hold thousands of rows.
- **A cross-tenant case is asserted.** `AssetRiskLink` carries its own
  `tenantId`, so a link row belonging to another tenant but pointing at our
  risk is representable. The test creates exactly that and asserts it does
  not surface.
- **Verified by mutation.** Removing the select makes all four tests fail;
  they were not written to pass against the code as it already stood.
