# 2026-08-05 — Assets surface: seven contained defects

**Commit:** `<pending>` fix(assets): the seven defects on the Assets surface

Roadmap prompt 1 of 3. All seven were verified against `main` before any
edit; two of the reported details were wrong in ways worth recording.

## What each was

**1. `updateAsset` silently dropped `status`.** `UpdateAssetSchema`
accepted it, the payload built for the repository listed twenty fields
and omitted it. The detail-page control and the edit modal both returned
200 OK and changed nothing — no error anywhere, because the write simply
was not in the patch. `createAsset` and `bulkSetAssetStatus` always wrote
it, which is why the field looked supported.

**2. Silent truncation at 1000 rows.** `AssetRepository.list` capped at a
hard internal 1000 and the route returned a BARE ARRAY, so a tenant over
the cap got a short list with nothing saying so — and the KPI tiles
counted the clipped array. Nine sibling surfaces already returned
`{ rows, truncated }` and rendered `<TruncationBanner>`.

The repository now takes an optional `take`, which is what makes
truncation *detectable*: a hard cap returns exactly N rows whether the
tenant has N or N+5000, so the caller cannot tell the two apart. The
route asks for `LIST_BACKFILL_CAP + 1`.

**3. `type` was `z.string()` against a NOT NULL enum.** Three
declarations of one field disagreed: the Zod schema said `z.string()`,
the hand-written `CreateAssetInput` said `string`, and the payload cast
to `AssetType`. Agreeing only that the value was unchecked, they let
`{"type":"FOO"}` reach the driver, where it became a
`PrismaClientValidationError` → 500. `status`, in the same schema object,
was already `z.enum`.

Fixed at all three: `z.nativeEnum(AssetType)` on create/update/bulk, the
interface field typed, the cast deleted.

**4. The name-uniqueness constraint is invisible to Prisma — and cannot
be declared.** Migration `20260312210616` created a PARTIAL unique index
on `(tenantId, name) WHERE "deletedAt" IS NULL`, verified still live in
the database. Prisma has no syntax for a filtered index, so declaring
`@@unique([tenantId, name])` would be worse than silence: the next
`migrate dev` would replace the partial index with an unconditional one
and break name reuse after a soft delete — the very thing the migration
existed to allow. (`Policy` carries the identical situation from the same
migration.) It is documented on the model instead.

Behind the invisibility was a live bug: `bulkImportAssets` built its
dedupe set from ALL rows including soft-deleted ones, so re-importing the
name of a deleted asset was skipped as "existing" — refusing an insert
the database would have accepted. The read now filters `deletedAt: null`,
matching the constraint it stands in for.

**5. Ungated create button and bulk bar.** Both rendered unconditionally
while every sibling gates them — and Assets already gated its import
link, its deleted-view toggle and its empty-state CTA, so this was
oversight, not policy. A READER saw a button that always 403'd. Row
SELECTION stays available to readers (it drives the quick-look panel);
only the mutating bar is gated.

**6. The edit form wrote `''` where create wrote NULL.** The edit form
sends every field on every submit with `''` defaults; the create form
omits empties. Clearing any of eleven nullable columns therefore stored
`''`, so "no location" had two representations and `IS NULL` filters
missed the edited rows. One `emptyToNull` helper at the usecase boundary,
preserving the three-state contract (`undefined` = untouched).

**7. Duplication and dead code.** The hand-rolled `parseCsvLine` (whose
own comment conceded that a quoted newline was "out of scope", so any
multi-line description cell produced garbage) is replaced by the shared
`parseCsvRecords` the risk importer already uses. Two dead props removed.

## Two reported details that were wrong

- **P2002 mapping already existed.** The prompt asked to add
  `P2002`/`PrismaClientValidationError` mapping to `src/lib/errors/api.ts`
  as "currently absent". `P2002` → 409 has been mapped since forever, in
  `types.ts::toApiErrorResponse`, not `api.ts`. Only
  `PrismaClientValidationError` was genuinely unmapped — it carries no
  `code`, so it fell through to the generic 500.

  It is now mapped, but deliberately **still 5xx**, with a distinct
  `INVALID_QUERY` code. A 400 would be a lie: by the time a value reaches
  the driver it has passed the route's Zod schema, so this error means
  OUR query construction is wrong, not that the caller sent a bad
  request. Answering 400 would blame the client for a server defect and
  bury the bug. The distinct code makes the next one greppable.

- **The stale comment was stale about the mechanism, not the file.** It
  claimed a file-level `any` disable in `AssetsClient.tsx`. There is
  none — but there are two `eslint-disable-next-line` directives for the
  SWR-migration hook rules, so the comment is rewritten rather than
  deleted.

## Decisions

- **Case semantics: the import stays stricter than the database, on
  purpose.** The constraint is case-SENSITIVE; the import dedupes
  case-INSENSITIVELY. Being stricter can only skip a row — reported back
  to the user — never corrupt one, whereas matching the DB exactly would
  let an import create "Prod DB" beside an existing "prod db". The
  asymmetry is documented at both ends. `createAsset` takes the other
  side of the trade: no dedupe, and the constraint answers with a 409.
- **`CreateAssetInput` stays hand-written** for now, with the enum fixed.
  Deriving it from the Zod schema is the real repair and belongs with the
  asset-DTO rehoming (prompt 3), where the DTO home is being settled.
