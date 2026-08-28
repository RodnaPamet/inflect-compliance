# 2026-08-29 — the mixed-module write verbs, and pinning the parseJsonBody composition

**Commit:** `(this PR)` fix(authz): audit the three tenant PATCH verbs that sat beside a gated DELETE

## Design

Tranches 1–5 of #2117 moved destructive routes onto `requirePermission` /
`requireOrgPermission` so their refusals reach the audit trail. They were driven
by a census guard that asked, per route FILE, "does a gate appear anywhere in
here?"

That question has a blind spot. A file exporting a **gated DELETE beside an
ungated PATCH** answers "yes" and reads as covered. Seven modules were in that
state. Their PATCH still refused correctly — the usecase `assertCan*` runs — but
`assertCan*` throws `forbidden(...)` and writes nothing, so editing a KRI, a
risk-hierarchy node or a report schedule could be turned away and leave no
record at all.

This diff gates the three tenant ones. Each takes the key its own file's DELETE
already uses, which is also the key its usecase assert already implies —
`risks.edit`, mirroring `assertCanWrite` in `updateNode` / `updateKri` /
`updateSchedule`. No key was invented and no caller's authority changed.

The composition that deferred these for five tranches was `withValidatedBody`:
its handler takes the parsed body as the third argument, which is where
`requirePermission` passes `ctx`, so the two cannot stack. Two route docblocks
said so in as many words. `parseJsonBody(req, schema)` — already in the same
module, already used by 58 routes — is the documented answer. Identical error
semantics, and moving the read inside the handler puts authorization BEFORE body
parsing.

## Files

| File | Role |
| --- | --- |
| `risks/hierarchy/[nodeId]/route.ts` | PATCH gated `risks.edit`; the docblock claiming PATCH was deliberately deferred on composition grounds is rewritten, because it is no longer true |
| `risks/kri/[kriId]/route.ts` | PATCH gated `risks.edit` |
| `risks/reports/schedules/[scheduleId]/route.ts` | PATCH gated `risks.edit`; records that `reports.schedule_external` still governs off-tenant recipients inside the usecase, which the route gate neither moves nor weakens |
| `t/[tenantSlug]/processes/[id]/route.ts` | Docblock only — records why its PUT/PATCH stay ungated |
| `tests/unit/security/mixed-module-write-denial-audit.test.ts` | New — four assertions per gated verb |

## Decisions

- **`processes/[id]` PUT and PATCH were triaged and deliberately left ungated.**
  There is no permission key meaning "write a process map": `PermissionSet` has
  no `processes` domain, `route-permissions.ts` has no entry, and the collection
  POST is ungated for the same reason. Both available moves are wrong. Reusing
  `admin.manage` (what its DELETE uses) mirrors `assertCanAdmin`, a strictly
  higher bar than the `assertCanWrite` these verbs enforce — it would refuse
  every EDITOR who can legitimately save a process map, which is a behavioural
  regression wearing an audit fix's clothes. Inventing `processes.edit` is an
  authorization-model change touching role resolution, custom-role overrides and
  the UI, and belongs in a diff reviewed as such. The finding is recorded in the
  route's docblock rather than silently carried, because the next person to read
  that file will otherwise ask the same question and reach the same dead end.

- **The test pins the composition from BOTH sides, and that is the point.** An
  unauthorized caller sending unparseable JSON must get 403, not 400 — reverting
  to `withValidatedBody` parses first and fails this. An authorized caller
  sending a type-invalid body must get 400 — dropping the schema while keeping
  the gate fails this. A gate-only assertion would have survived both
  regressions, which is why the file exists separately from the census.

- **Three sessions converged on this work independently, and two got there
  first.** While this branch was in progress, #2167 gated the two ORG mixed
  modules (widgets, initiatives) and #2168 made the census per-handler. Both
  reached essentially the shape drafted here — #2167 even landed the same
  `requireOrgPermission` + `parseJsonBody` rewrite with the same type name. Those
  changes were therefore dropped from this branch rather than rebased on top of,
  and only the three tenant routes remain. The org routes stay in this diff's
  TEST, because #2167's table asserts the denial pair but not the ordering or the
  schema-validation property, which are the two assertions this file is for.

- **The census needed no edit.** Under the per-handler rule that #2168 landed, a
  PATCH counts as destructive only on a path whose segment says so, so gating
  these three does not move the declared list. The list is unchanged in this
  diff, and that is the correct outcome rather than an omission.
