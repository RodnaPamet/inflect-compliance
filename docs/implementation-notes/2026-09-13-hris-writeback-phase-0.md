# 2026-09-13 — JML HRIS write-back, Phase 0: make the handle exist

**Commit:** `feat(hris): give the Employee row BambooHR's own record id`

Phase 0 of the phasing in [`docs/jml-hris-write-back-design.md`](../jml-hris-write-back-design.md).
**No write to an HRIS is added, and none becomes possible.** This is a read-path
change that makes a later phase's subject addressable, and nothing else.

## The defect, restated from the design

`src/app-layer/integrations/providers/hris/index.ts` — the BambooHR provider:

- `fetchBambooRoster` POSTed a custom-report request whose body listed ten
  fields, and `id` was not one of them.
- The mapper nonetheless read it, as the middle term of
  `externalId: r.employeeNumber || r.id || r.workEmail`.

Whether that middle term was reachable is **unresolved**, and this note does
not resolve it. It turns on whether BambooHR returns `id` to a request that did
not ask for it — Open Question 2 of `jml-hris-write-back-design.md`, filed under
a heading reading *"unresolved, and deliberately not resolved by assertion"*,
whose instruction is to check against a real tenant. There is no BambooHR tenant
to check; issue #2548 exists to create one.

So `Employee.externalId` values already on disk **may** be BambooHR row ids, and
nothing here should be read as saying otherwise.

What is settled is the part that matters for Phase 0: whatever `externalId`
holds, it is `employeeNumber`, `workEmail` or a row id chosen by a fallback —
**none of which is a dependable address for an update API**, because which one
a given row holds is not knowable from the value. That is why the handle needs
its own column. The design calls this "the first implementation task and it is a
read-path change with no write in it", and everything else is blocked on it.

The deletion of the middle term is safe under EITHER answer, but not for the
reason originally written here. It is safe because `Employee.externalId` has no
reader: `listEmployees`' projection omits it, `getEmployee` has no production
caller, no `.tsx` references it, and no `Employee` query filters on it. Had it
been read anywhere, this would have needed a backfill decision.

## The decision: a new column, not `externalId`

**`Employee.hrisRecordId String?` is new. `externalId` keeps the meaning it
already had.** The alternative — letting `id` win `externalId`'s fallback —
was rejected on four grounds, in descending order of weight:

1. **It rewrites a column already on disk.** With `id` requested and the
   fallback left in place, the next sync repoints `externalId` at the row id
   for every BambooHR row with no `employeeNumber`. That changes what an
   already-persisted value *means*, retroactively, for one provider only — so
   the column would then mean different things per provider **and** per sync
   date. A column whose meaning depends on when it was last written is not
   addressable by anything.

2. **The empty population is not the argument.** Production today holds zero
   HRIS-sourced employees — one `IntegrationConnection` (entra-id), one
   `Employee` (`source=MANUAL`, `externalId` null). So the churn costs nothing
   *right now*. That is precisely why it must not be the reason: the next
   tenant to connect BambooHR creates the population the change would run
   under, and by then the decision is made. The column split is correct
   independent of how many rows exist.

3. **Null has to be answerable per row.** The design's `REFUSED_NO_HANDLE` is
   "expected to be the most common refusal on BambooHR today". Under a merged
   column, *"is this `externalId` a row id or a payroll number?"* is
   unanswerable for any given row — there is no discriminator in the value. A
   dedicated column is null-or-the-row-id from the day it ships, so a Phase-2
   caller refuses on null with no ambiguity and no guessing.

4. **Nothing keys off `externalId` today**, which makes this cheap rather than
   safe: `grep` finds no `where: { externalId }` on `Employee` anywhere in
   `src/` — the only reads are the `select` in `usecases/personnel.ts` (a
   display field) and the two provider mappers. Cheap-today is a reason the
   split costs little, not a reason the merge would have been fine.

### The middle term was a latent rewrite, not dead code

This is the part worth carrying forward. Deleting `r.id` from the fallback is
**load-bearing, not tidying.** While `id` was unrequested the term was inert;
the moment the field list gains `id`, the same expression starts producing
values no earlier sync could have written. So "request the field" and "delete
the fallback term" are one change, not two — doing the first without the second
is the retroactive rewrite described above, arriving silently on the next
scheduled pass.

`tests/unit/hris-record-id-handle.test.ts` pins exactly that case: a row with an
`id` and **no** `employeeNumber` must yield `externalId === workEmail`. The
mutation that restores the three-term fallback reddens that one test and no
other.

### `hrisRecordId` is last-write-wins, and null beats stale

Both arms of the upsert write `hrisRecordId: e.hrisRecordId ?? null`, like every
other mirrored column on the row. A row that stops reporting an id goes back to
null rather than keeping the handle it had. That direction is deliberate: a
Phase-2 write would happily *address* a stale handle, where null refuses.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/personnel.prisma` | `Employee.hrisRecordId String?`, plus the docblock on `externalId` recording that it is provenance and never an address |
| `prisma/migrations/20260913030000_employee_hris_record_id/migration.sql` | `ADD COLUMN IF NOT EXISTS "hrisRecordId" TEXT` — nullable, no default, no backfill, no index |
| `src/app-layer/integrations/providers/hris/index.ts` | `'id'` added to the report field list; `r.id` removed from `externalId`'s fallback; `hrisRecordId: r.id \|\| null` added; `NormalizedEmployee.hrisRecordId?: string \| null` |
| `src/app-layer/usecases/hris-sync.ts` | the column named in both arms of the existing upsert, as an inline literal |
| `tests/unit/hris-record-id-handle.test.ts` | the behavioural proof, against a faked BambooHR response |

## Decisions

- **No index on the new column.** Nothing queries by it; it is carried by a row
  already located through `@@unique([tenantId, workEmail])`. An index would be a
  second B-tree on a table written once per employee per sync, supporting a read
  that does not exist. `Employee` is already triaged in
  `LIST_MODELS_TENANT_INDEX_SUFFICIENT`, and a nullable non-FK scalar moves
  none of the four index layers. When a Phase-2 pass needs a lookup, the index
  lands with the query that needs it.

- **Persisted from `hris-sync.ts`, which is already a write seam.**
  `tests/guards/employee-status-single-write-seam.test.ts` asserts by exact
  equality that exactly two files write an `Employee` row — *"a third writer is
  a finding to fix, never an entry to add"*. Adding a column to an existing
  seam's upsert is allowed; a new writer file would not have been. The same
  guard censuses **which columns** each write names and treats an opaque column
  map (a spread, or a variable) as a possible `status` write, so both arms stay
  an inline object literal spelling every column.

- **Workday is knowingly left alone.** `workday/roster.ts` carries the
  identical shape (`row.employeeId || row.workerId || workEmail`), but its
  source is a **customer-authored** RaaS report template, so what any column
  holds is per-tenant and unknowable from this repo. `NormalizedEmployee`
  therefore declares `hrisRecordId` **optional**, Workday sets nothing, and the
  upsert coalesces to null. A guessed handle would be worse than none. This is
  the design's own reading, and it is open question 6 there.

- **Nothing from Phase 1 is present, deliberately.** No `writeBackEnabled`, no
  credential preflight, no `WRITE_BACK_WORK_EMAIL` enum member, no `'writeback'`
  metric label, no `HRIS_WRITEBACK_MAX_MODE`, no pass. Each would be a flag or
  constant that nothing consumes — the shape #1970 deleted from this repo, and
  the cost `lib/identity/write-ladder.ts` records in its own deletion docblock
  (*"a clamp constant with no pass reading it is a fourth thing to keep in
  sync"*). Phase 1 lands with the thing that reads it, which is Phase 2, which
  the design blocks until the joiner settles what a pre-hire is.

- **The three drops of an email-less row are asserted unchanged.**
  `Employee.workEmail` is `NOT NULL` and `@@unique([tenantId, workEmail])` — the
  work email *is* the row's identity — and three layers independently drop a row
  without one. A read-path change that accidentally admitted a pre-hire would not
  create a pre-hire; it would break the primary key. All three drops carry a test
  here, and the `hris-sync` one asserts the guard sits **before** the upsert
  rather than merely existing: the mutation that MOVES it below the write leaves
  it present and still reddens the test.

## What Phase 0 does not do

It creates no HRIS write and makes none reachable. It does not decide whether
BambooHR exposes an employee-update API at the same gateway base under the same
Basic auth — the design's open question 1, on which its provider ordering rests
entirely, and for which there is no call site in this repo. It does not make a
pre-hire representable; that belongs to the joiner. It does not populate the
column for Workday. And it does not backfill: every existing row keeps
`hrisRecordId` null until its next roster read supplies one, which for a
BambooHR tenant is the next nightly sync and for everyone else is never.
