# 2026-08-05 — `criticality` means one thing: the stored band

**Commit:** `<pending> fix(assets): make stored criticality the single source of truth`

`Asset.criticality` was **both** stored and re-derived client-side, so the
same value had two implementations that could disagree — and one write path
could leave the stored copy stale. This picks stored, deletes the read-side
re-derivation, and turns the stale-write hazard into a compile error.

## The decision, and why it was not a preference

Consumers of the stored enum:

| Consumer | Where |
| --- | --- |
| list filter — `where.criticality` | `AssetRepository.ts:110` (SQL) |
| dashboard KPI — `count({ criticality: { in: ['HIGH','CRITICAL'] } })` | `DashboardRepository.ts:661` (SQL) |
| the Assets KPI card | `AssetsClient.tsx:506` |
| the detail meta bar | `assets/[id]/page.tsx:552` |

Consumers that re-derived from the C/I/A triad: the table cell, the table
sort accessor, and the detail badge.

**Stored wins because the first two cannot move.** They execute in Postgres.
A value that only exists after a client-side computation cannot appear in a
`WHERE` clause or a `COUNT`, short of reading every row into the app tier and
filtering there — which is exactly the unbounded read the query guardrails
exist to prevent.

The user-visible symptom of the split: filter the list to HIGH, and a cell
that recomputes its own answer could render "Medium" on a row the server
matched as HIGH. The filter and the column were answering the same question
from different implementations.

## The stale-write hazard, now a type error

`AssetRepository.bulkUpdate` accepted
`Omit<Prisma.AssetUncheckedUpdateInput, 'tenantId'>` and passed it straight
to `updateMany`. `updateMany` **never reads the rows it writes**, so it
cannot re-derive criticality: given a new `confidentiality` it has no idea
what the other two dimensions are. A bulk write touching any of the four
columns would silently leave `criticality` stale.

Nothing was broken, because today's callers set only `status` and
`ownerUserId`. But "safe because of what the callers happen to pass" is not a
property the compiler checks, and the next bulk action to touch a CIA field
would have shipped a data bug that surfaces as a filter disagreeing with a
badge — hard to attribute, easy to miss.

The parameter type now excludes `criticality`, `confidentiality`, `integrity`
and `availability`. A future bulk write of those is a **type error at the
call site**. Anything that must change the triad goes through `updateAsset`,
which re-derives per asset.

## Where derivation still belongs

On the **write** path (`criticalityToEnum` at create/update/import), and in
the two **pre-write previews** where no stored value exists yet:

- `AssetCriticalityFields` — the create/edit form, deriving live as the
  sliders move.
- `assets/import/page.tsx` — the CSV preview table, rows not yet persisted.

`AssetCriticalityBadge` now takes an optional `storedCriticality` that wins
when present. Read surfaces pass it; the form has none to pass. That prop is
the distinction between "showing a saved asset" and "previewing an unsaved
one", made explicit at the call site.

## Files

| File | Role |
| --- | --- |
| `src/lib/asset-criticality.ts` | adds `CRITICALITY_PRESENTATION` + `presentCriticality` — the inverse of the write mapping |
| `src/app-layer/repositories/AssetRepository.ts` | `bulkUpdate` excludes criticality + the triad by type |
| `assets/AssetsClient.tsx` | table cell + sort accessor read the stored band |
| `assets/[id]/page.tsx` | detail badge passes `storedCriticality` |
| `assets/_form/AssetCriticalityFields.tsx` | badge prefers the stored band when given one |
| `tests/unit/asset-criticality-single-source.test.ts` | pins the inverse-mapping invariant |

## Decisions

- **The presentation table is the inverse of the write mapping, and a test
  proves it exhaustively.** All 125 C/I/A triads are checked: the label the
  write path stores and the label a read surface renders must be the same
  string. Two hand-maintained tables that "obviously agree" are how the
  original split happened.
- **Unrecognised stored values render an em-dash, not a guess.** Inventing a
  band for an unknown enum member would resurrect the disagreement.
- **Sorting uses a band `rank`, not the 1-5 score.** The score is a property
  of the triad; the rank is a property of the band being displayed. Sorting
  on the score could order rows by a value the filter never used.
- **The two SQL backfills are left alone.** `20260713100100` and
  `20260716120000` carry `CASE` statements that had to "replicate
  getAssetCriticality EXACTLY". They are executed history — editing them
  changes nothing about the current data, and the forward fix is that the TS
  module is now the only live implementation. A future banding change needs a
  new backfill, not an edit to those.
