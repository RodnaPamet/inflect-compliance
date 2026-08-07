# 2026-08-06 — Controls: collapse the write contract, delete the dead surface

**Commit:** `<pending> refactor(controls): one write contract, no dead schema`

Eight items. The theme is that several Control behaviours were derived from
the REQUEST BODY or from a hand-maintained parallel declaration, rather than
from the data.

## 1. The contract derives from one source

`CreateControlSchema` / `UpdateControlSchema` move from `.strip()` to
`.strict()`, and the usecases' `data` parameters become
`z.input<typeof …Schema>` instead of hand-written inline shapes.

`.strip()` is what let three fields go missing for months:
`createControl` declared and wrote `objective` / `successCriteria` /
`testingMethodology`, the schema did not declare them, and `.strip()`
removed them silently — a 201 with `objective: null` and no signal. Strict
turns that into an immediate 400.

Deriving the parameter type closes the other half: a field the usecase reads
must be a field the schema declares, or it does not compile.

**`z.input`, not `z.infer`.** `z.infer` is the OUTPUT type, in which
`.default()`ed fields (`status`, `isCustom`) are REQUIRED. The route passes
parsed data where defaults are already applied, but internal callers
(`nis2-gap-lifecycle`, `self-assessment`) pass a raw shape and rely on the
same defaults. `z.input` describes what a caller may hand in, which is the
contract the parameter actually has. `tsc` caught this — `z.infer` broke
three call sites.

Every field the three write surfaces send was enumerated against the
declared sets before switching, rather than flipping it and seeing what
400s.

## 2. `changedFields` is diffed, not read off the body

`Object.keys(data)` made the audit trail a function of which UI the user
opened: the detail page PATCHes 10 fields and `ControlEditPanel` PATCHes 3,
so editing one field through the detail page logged nine unchanged fields as
"changed" — and the same edit through the panel logged a different set.
Now `updateControl` reads the BEFORE row and compares.

## 3. One empty-value rule

The three surfaces disagreed, so the same "clear this field" gesture had
three outcomes: `'' → null` on the detail page but unparseable → `undefined`
(key omitted, old value silently kept); `'' → null` in the panel;
`'' → undefined` in the create modal, so clearing no-opped.

The rule, in `_lib/control-write-values.ts` and used by all three:
`''` clears (`null`); an absent field is unchanged (key absent); an
unparseable value is **rejected**, never dropped — the raw string is sent so
the server's Zod fails it and the caller's existing `!res.ok` path surfaces
the error. Omitting the key told the user their edit succeeded while keeping
the old value.

## 4. Two dead columns dropped

`Control.reviewCadence` — zero reads, zero writes across `src/`, present
since init five months ago. Every `reviewCadence` hit in the repo is
`RiskAppetiteConfig.reviewCadence`. The `ReviewCadence` enum stays; that
model still uses it.

`ControlTemplate.defaultOwnerHint` — written by four fixture files and
`seed.ts`, read by no install path, repository, DTO or component. Data went
in and never came out. The seed writes are removed with the column.

## 5. `retentionUntil`: the sweep was vacuous

`Control` was in `RETENTION_MODELS` and queried on every sweep, but NOTHING
in `src/` ever set `Control.retentionUntil` — no schema, no DTO, no UI, no
job. The only writer of that column anywhere is the evidence importer,
which writes Evidence.

**Chose (b): drop it from the sweep and correct the doc.** Option (a) —
expose it on `UpdateControlSchema` and the edit UI — would build a retention
capability nobody asked for in order to justify a query. Controls are still
purged by the soft-delete path, which is now what
`docs/data-retention.md` says. A swept column with no writer is worse than
no sweep, because it reads as a control that exists.

## 6. The purge had no tenant predicate

`retention-purge.ts` is generic over all 13 `SOFT_DELETE_MODELS`, so a
Control-specific predicate would have been the wrong shape. Verified against
the schema that **`Control` is the only soft-delete model with a nullable
`tenantId`**, and added an explicit `NULLABLE_TENANT_MODELS` set — so a
future nullable-tenant model is a decision someone makes, not a default they
inherit. Without it, a soft-deleted global-library row would be hard-purged
platform-wide on one tenant's retention clock.

## 7. Index fit

- **Dropped `@@index([tenantId])`** — a strict prefix of seven composites on
  the same table. Pure write amplification.
- **Added three trigram indexes** for the `?q=` search.
  `ControlRepository:150-157` runs three unanchored `ILIKE` predicates on
  every keystroke; a leading wildcard defeats a btree entirely, so each
  keystroke was a sequential scan.

  **One index per column, not one over a concatenation.** My first version
  indexed `name || code || objective` — and Postgres only uses an expression
  index when the query matches that expression, so it would have been dead
  on arrival, which is the exact failure this migration removes elsewhere.
  `EXPLAIN` confirms the corrected form: a `BitmapOr` across all three.
- **`@@index([tenantId, category])` retained with a warning comment**,
  pending the server-side filter fix (P3.4). Dropping it now and re-adding
  it there would be churn; the comment says to drop it if that fix does not
  land.
- **Commented `[tenantId, code]`**: the list `where` is
  `OR:[{tenantId:X},{tenantId:null}]`, which one tenant-prefixed btree
  cannot satisfy. Migration `20260506020000:15` asserts the ordering is
  "covered by (tenantId, code)"; that claim ignores the OR and is wrong.

## 8. `nextDueAt` recomputes on a frequency change

It was computed only at attest time, so editing the cadence left scheduling
and the `controlsDueSoon` dashboard count running on a date derived from a
superseded frequency. Recomputed only when `frequency` actually changes —
rewriting it on every edit would silently push the due date forward whenever
someone renamed a control.

## Decisions

- **`.strict()` was verified against real callers first.** Enumerating what
  the three surfaces send beat flipping the switch and reading the 400s.
- **The unparseable-value rule rejects rather than drops.** "Reject" here
  means the server rejects it and the existing error path shows it — no new
  UI, and no silent success.
- **The trigram index was corrected after checking `EXPLAIN`.** An index the
  planner ignores is indistinguishable from a missing one, and I had written
  one.
