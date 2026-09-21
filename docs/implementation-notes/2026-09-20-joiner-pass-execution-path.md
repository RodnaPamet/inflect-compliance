# 2026-09-20 — the joiner pass gets a caller

**Issue:** #2687. **Branch:** `feat/joiner-pass-execution`.

## Design

Phase 1 (#2638) shipped `planJoinerPass` — a pure decision core with **no
caller**. Every reference to it in `src/` was a comment or the `JOINER_MAX_MODE`
import the admin route uses for its ceiling. The leaver had four pieces the
joiner had none of, so this change mirrors that shape rather than inventing one:

| | leaver | joiner (before) | joiner (now) |
|---|---|---|---|
| IO caller | `runIdentityLeaverPass` | none | `runIdentityJoinerPass` (`usecases/identity-joiner-run.ts`) |
| executor pair | `identity-leaver-pass` + `-dispatch` | none | `identity-joiner-pass` + `-dispatch` |
| schedule | 05:00 UTC | none | 04:30 UTC |
| manual run route | `admin/identity-leaver-passes/run` | none | `admin/identity-joiner-passes/run` |

A fifth piece the issue did not name was added because without it the artefact
is unreadable from inside the product: `GET admin/identity-joiner-passes`, the
report surface the seven-day DRY_RUN window is read from.

```
04:30 UTC  identity-joiner-dispatch  ── per (tenant, writable provider) ──▶  identity-joiner-pass
                                                                              │
                              Employee(status=ONBOARDING)  ─────────────────┐ │
                              IdentityAccountLink (fresh, this provider)  ──┤ │
                              ConnectedIdentityAccount.email (enumeration) ─┤ │
                              TenantSecuritySettings (mode; map/tz absent) ─┘ │
                                                                              ▼
                                                                    planJoinerPass (pure)
                                                                              │
                                                     IntegrationExecution `<provider>.joiner_pass`
```

04:30 is after `identity-sync-dispatch` (03:00), which is what refreshes the link
freshness and the enumeration this pass reads, and before the leaver's 05:00 so
the two halves of JML never share a minute.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-joiner-run.ts` | NEW — the IO caller: assembles `JoinerPlanInput`, drives the planner, writes the artefact, exposes `listJoinerPasses` |
| `src/app-layer/jobs/identity-joiner.ts` | NEW — `runIdentityJoinerPassJob` + the `(tenant, provider)` fan-out |
| `src/app-layer/jobs/types.ts` | payload pair + `JOB_DEFAULTS` (attempts: 1 for both) |
| `src/app-layer/jobs/executor-registry.ts` | the two registrations |
| `src/app-layer/jobs/schedules.ts` | `identity-joiner-dispatch` at `30 4 * * *` |
| `src/lib/observability/integration-metrics.ts` | `recordJoinerPassOutcome` → `identity.joiner.pass` |
| `src/app/api/t/[tenantSlug]/admin/identity-joiner-passes/route.ts` | NEW — the report GET |
| `src/app/api/t/[tenantSlug]/admin/identity-joiner-passes/run/route.ts` | NEW — the off-schedule trigger |
| `src/lib/security/route-permissions.ts` | two OWNER-only rules, run-before-subtree |
| `public/openapi.json` | regenerated: the two new paths |

## Decisions

- **The IO caller is a SEPARATE module from the planner.**
  `tests/unit/identity-joiner-pass.test.ts` mocks `@/lib/prisma` and
  `@/lib/db-context` to THROW ON IMPORT, so the planner's purity is proved by
  the suite's ability to load at all. Putting a database read into that module
  would take the proof down with it.
- **The day window stays in the planner; the starter query filters on STATUS
  and nothing else.** A `startDate` predicate would delete `NOT_IN_WINDOW`,
  `REFUSED_NO_START_DATE` and `START_DATE_UNPARSEABLE` from every artefact and
  change nothing else visible — the exact shape decision 6 refuses by name.
- **No schema change, and `departmentGroups` / `defaultGroupId` / `timeZone`
  are read through one seam that returns null.** Decision 10's column does not
  exist, so every plan today refuses `NO_DEPARTMENT_MAP` — *with* the
  per-starter decisions attached, because the planner carries them on that
  refusal deliberately. Decision 9's zone does not exist either, so
  `predictionLimits` emits its UTC caveat on every run. Both are honest states
  reported by name rather than papered over.
- **The two ladder refusals write no `IntegrationExecution` row**, mirroring the
  leaver: a tenant with joiner writes off is not observing and should not accrue
  observation rows. `identity.joiner.pass` is emitted on those paths anyway, and
  that asymmetry is why the counter matters more than its leaver twin — for a
  DISABLED tenant it is the only evidence the pass fired.
- **The persisted decision keeps `intendedAddress` and scrubs `reason`.**
  `IntegrationExecution.resultJson` is not encrypted at rest, so the leaver keys
  by link id and scrubs everything. The joiner's boundary differs: `employeeId`
  is our own cuid and `intendedAddress` is derived by us from
  `Employee.workEmail` — a plain, RLS-scoped column the personnel page already
  renders — while `reason` is free text and one outcome (`ACCOUNT_OBSERVED`)
  quotes an address the customer's own enumeration holds.
- **`JOINER_MAX_MODE` is untouched**, and so is `DIRECTION_IMPLEMENTED.joiner`,
  which is still `false` and still pinned by
  `tests/unit/identity-write-policy.test.ts`. This change discharges the first
  of that flag's two stated reasons (there is now a trigger and an operator
  surface); the second — decision 10's entitlement map — still has no column.
  Flipping it is a reviewed decision and a different PR.
- **The schedule `description` makes no safety claim.** The leaver's said
  "writes nothing to any directory" and was false for four days after #2187
  moved a constant in another file. This one names `identityJoinerMode` and
  `JOINER_MAX_MODE` and tells the reader to go and read them.
