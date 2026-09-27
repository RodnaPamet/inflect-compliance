# 2026-09-27 — storage and the setter for the external-write ladder (#2861, slice two)

**Commit:** `<pending> feat(agentic): store the external-write rung per connection`

## Design

#2933 landed the ladder with no storage, and said why: "adding
`externalWriteMode` columns now would be a migration for a mechanism with no
reader and no writer". This is that reader and writer — two columns on
`IntegrationConnection`, an OWNER-gated setter, and an admin surface.

```
DISABLED  →  DRY_RUN  →  PROPOSE_ONLY  →  AUTOMATIC
             ^^^^^^^
             EXTERNAL_MAX_MODE — the ceiling this build honours
```

**It changes no agent behaviour.** Nothing in the funnel consults the rung yet,
so a connection at `DRY_RUN` and one at `DISABLED` are treated identically by
every tool call. That is the point rather than a shortfall: #2241's lesson is
what a rung costs when it arrives *after* the authority it governs, so the
control is built first and the write path cannot be born ungated.

`EXTERNAL_MAX_MODE` is `DRY_RUN` for the same reason. The two rungs above it name
authorities this build cannot exercise, and publishing a rung a tenant can select
and the product then ignores is exactly what #2241 deleted.

## Files

| file | role |
| --- | --- |
| `prisma/schema/automation.prisma` | `externalWriteMode` + `externalWriteModeSince` on `IntegrationConnection` |
| `prisma/migrations/20260927150000_external_write_mode_per_connection/` | the two columns, TEXT not enum |
| `src/lib/integrations/external-write-ladder.ts` | `EXTERNAL_MAX_MODE`, `EXTERNAL_WRITE_AUTOMATION_SUFFIX` |
| `src/app-layer/usecases/external-write-policy.ts` | read (coerced) + set (clamped, laddered, audited) |
| `src/app/api/t/[tenantSlug]/admin/external-write-policy/[connectionId]/route.ts` | GET + PUT, `admin.tenant_lifecycle` |
| `src/lib/security/route-permissions.ts` | the rule for that path |
| `tests/integration/external-write-policy.test.ts` | 16 assertions against a real row |

## Decisions

- **TEXT, not a Postgres enum.** The identity ladder's scar: an enum value cannot
  be dropped without recreating the type, and an `ALTER TYPE` mid-rolling-deploy
  makes still-running OLD containers fail with SQLSTATE 42704 — which is why
  `IdentityWriteMode` still carries a retired `PROPOSE` that no rung maps to.
  `external-write-ladder.ts` was written for a string: `coerceStoredMode` takes
  `string | null | undefined` and fails CLOSED to `DISABLED`. A retired rung
  therefore costs a source constant, not a migration.

- **No backfill, and that is not an omission.** NULL coerces to `DISABLED`, which
  is what every existing connection should read as. Writing `DISABLED` into every
  row would change nothing and would make "never set" indistinguishable from
  "deliberately off" — a distinction the ladder uses, because it refuses to widen
  off a rung with no recorded start.

- **A SIBLING route, not `admin/integrations/<id>/…`.** Route-permission matching
  is FIRST-MATCH-WINS and `^…/admin/integrations(/.*)?$` resolves to
  `admin.manage`. Nesting would have documented a weaker gate than the handler
  enforces — the trap `admin/identity-leaver-passes` and
  `admin/identity-write-journal` each state in their own notes, having been made
  siblings for exactly this reason. Caught by writing the permission rule, not by
  a test.

- **`clamp` is a REQUIRED parameter**, copied from `setIdentityWriteMode`
  including its reasoning: the value comes from outside the file, and an optional
  parameter that callers forget is indistinguishable from a check that was never
  written. The route passes the same constant it publishes as `honoured.maxMode`,
  so the published ceiling and the enforced ceiling are one value by construction.

- **The clamp is checked BEFORE the ladder.** It is the stronger claim — the
  ladder says "not yet", the clamp says "not in this build at all" — and telling
  an operator to wait seven days for a rung that would still be refused afterwards
  is the refusal #2843 finding 31 called worse than a vaguer one.

- **Evidence is a real query, not a literal `0`.** `countRecordedIntents` counts
  `IntegrationExecution` rows under `EXTERNAL_WRITE_AUTOMATION_SUFFIX`. Nothing
  writes them yet, so it returns 0 and the ladder refuses to widen off `DRY_RUN`
  on evidence — correct today. A literal `0` would refuse identically now and go
  on refusing after the dispatch shipped, silently, until somebody remembered the
  line. The suffix lives beside the rung it gates so the reader and the future
  writer cannot disagree about the string.

- **No second gate in the usecase.** OWNER-only at the route via
  `requirePermission('admin.tenant_lifecycle')`, not repeated as an
  `assertCanAdmin` — the identity policy's stated reason applies unchanged: a
  second, weaker gate is how a route ends up looking protected while granting
  more than the route said, and an `assertCanAdmin` denial writes no
  `AUTHZ_DENIED` row.

## One behaviour PINNED rather than endorsed, and it wants a decision

A connection that was never set has `modeSince = null`, and `refusalForMove`
refuses any widen while that is null. So the **first** move on every connection is
refused, pointing the operator at a no-op re-selection of `DISABLED` to open the
window — followed by seven days before `DRY_RUN` can be selected.

That may be a deliberate cooling-off before any external-write authority. It may
also be the general rule catching a rung it was not aimed at: the dwell's stated
purpose is "time for what this rung records to be read before a wider one acts on
it", and `DISABLED` records nothing by construction — `MODE_MIN_EVIDENCE` exempts
it for exactly that reason, so the author had considered `DISABLED` as a special
case on the adjacent axis.

The ladder's own tests do not settle it: they assert the `!modeSince` refusal from
`DRY_RUN`, never from `DISABLED`. It is asserted here so it cannot change
silently, and changing it is a decision about #2933 rather than about this
storage.

## Risk assessment and rollback

STANDARD, and unusually contained for a migration: two NULLABLE columns added to
an existing table, no backfill, no data rewritten, no index. Every existing row
reads exactly as it did. One new route, gated by the OWNER-only key, whose
handlers cannot change anything an agent does because nothing reads the column
yet.

Rollback is reverting the commit; the columns can be left in place (they are
nullable and unread) or dropped in a follow-up, since nothing outside this diff
references them.
