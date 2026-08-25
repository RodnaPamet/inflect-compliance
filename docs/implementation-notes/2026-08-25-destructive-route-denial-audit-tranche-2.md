# 2026-08-25 — Destructive-route denial audit, second tranche (#2117)

**Issue:** #2117 — "Destructive routes authorize via usecase asserts, so refusals
write no AUTHZ_DENIED row". The first tranche landed as #2121; this is the
follow-up tranche and its residual census.

## Design

`AUTHZ_DENIED` is written in exactly one place — `auditPermissionDenied` inside
`requirePermission` (`src/lib/security/permission-middleware.ts`). A usecase
`assertCan*` throws `forbidden(...)` and writes nothing. So a route that
authorizes only in the usecase refuses correctly and records nothing, which in a
compliance product is a hole in the one artefact the product exists to produce.

Every migration keeps the usecase assert. The usecase is what protects non-HTTP
callers (jobs, scripts, the MCP surface); the route gate is what makes the
refusal visible. Belt and braces, not a move.

### The census (the denominator, so it is auditable)

Population: every `src/app/api/**/route.ts` from `git ls-files`, kept if the file
exports a `DELETE` handler **or** its path carries a destructive verb segment
(`purge|restore|delete|archive|revoke|wipe|deactivate|disable|remove|reset`).
Classified on whether the comment-stripped source contains a literal
`requirePermission(` / `requireAnyPermission(` / `requireAllPermissions(` — the
last two delegate to the first, so they audit identically.

| | before | after |
| --- | ---: | ---: |
| destructive route files | 87 | 87 |
| route-level gate present | 44 | **50** |
| no route-level gate | 43 | **37** |

### Migrated here (6)

| route | verb | key | why that key |
| --- | --- | --- | --- |
| `vendors/[vendorId]/documents/[docId]` | DELETE | `vendors.edit` | `assertCanManageVendorDocs` reads `appPermissions.vendors.edit` |
| `vendors/[vendorId]/links/[linkId]` | DELETE | `vendors.edit` | `assertCanManageVendors` reads the same flag |
| `vendor-assessment-reviews/[assessmentId]/revoke` | POST | `vendors.edit` | `assertCanRunAssessment` reads the same flag |
| `policies/[id]/archive` | POST | `admin.manage` + `policies.edit` | `archivePolicy` asserts `assertCanAdminPolicies`, a conjunction — same two keys its already-gated `bulk/archive` twin declares |
| `loss-events/[id]` | DELETE | `admin.manage` | `deleteLossEvent` asserts `assertCanAdmin` |
| `processes/[id]` | DELETE | `admin.manage` | `deleteProcessMap` asserts `assertCanAdmin` |

The three vendor rows are the strongest available form of "mirror the assert":
route gate and usecase gate evaluate the **same object and the same flag**, so
the caller set is provably unchanged and only the recording layer moves.

## Files

| file | role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/vendors/[vendorId]/documents/[docId]/route.ts` | DELETE gated on `vendors.edit` |
| `src/app/api/t/[tenantSlug]/vendors/[vendorId]/links/[linkId]/route.ts` | DELETE gated on `vendors.edit` |
| `src/app/api/t/[tenantSlug]/vendor-assessment-reviews/[assessmentId]/revoke/route.ts` | POST gated on `vendors.edit` |
| `src/app/api/t/[tenantSlug]/policies/[id]/archive/route.ts` | POST gated on the two-key conjunction |
| `src/app/api/t/[tenantSlug]/loss-events/[id]/route.ts` | DELETE gated on `admin.manage` |
| `src/app/api/t/[tenantSlug]/processes/[id]/route.ts` | DELETE only; GET/PUT/PATCH untouched |
| `src/lib/security/route-permissions.ts` | five new rules (documents+extract, links, revoke, policy archive, loss-events) |
| `tests/guardrails/api-permission-coverage.test.ts` | five new narrow leaf `PRIVILEGED_ROOTS` |
| `tests/guardrails/bulk-and-lifecycle-routes-audit-denials.test.ts` | `policies/[id]/archive` joins `GATED_MULTI` |
| `tests/unit/security/destructive-route-denial-audit.test.ts` | six new behavioural rows; table generalised over HTTP method and role pair |

## Decisions

- **`admin.manage` over `assertCanAdmin` is a one-directional imprecision, and
  it is accepted knowingly.** The assert reads role-derived
  `ctx.permissions.canAdmin`; the middleware reads custom-role-aware
  `ctx.appPermissions.admin.manage`. `parsePermissionsJson` falls back to the
  base role per key, so they diverge for exactly one caller: a custom role on an
  ADMIN/OWNER base whose `permissionsJson` sets `admin.manage: false`. That
  caller is now refused at the route rather than admitted. The role revoked the
  flag deliberately, and this is the same tightening every already-migrated
  purge route carries (#2111, #2121).

- **`processes/[id]` gets the gate but NO registry entry.** Registering it would
  put the whole file in the coverage guardrail's population, and that guardrail
  is satisfied by `requirePermission` appearing *anywhere* in a file — so GET /
  PUT / PATCH, which were not triaged and still authorize through `getTenantCtx`
  + a usecase assert, would be counted as covered. The audit row does not depend
  on registration. Same reasoning, and the same shape, as
  `calendar/connections/route.ts`.

- **`policies/[id]/archive` takes two keys, not one.** Its purge/restore
  siblings take `admin.manage` alone because `purgeEntity`/`restoreEntity` never
  reach `assertCanAdminPolicies`. `archivePolicy` does. Copying the sibling's
  one-key rule would have admitted a role holding `admin.manage` without
  `policies.edit` — refused by the usecase, writing nothing, which is the exact
  defect in a new place. The behavioural test asserts that caller is refused at
  archive AND admitted at purge, so the asymmetry is a decision rather than an
  accident.

- **The behavioural test extends the existing file rather than starting a new
  one.** It already proves the mechanism directly (`assertCanAdmin` writes
  nothing where the middleware writes one, on the same context, in one test).
  Splitting would have duplicated that proof or, worse, left the new rows
  asserting a mechanism nobody demonstrated in their file.

- **The test's allowed/denied role pair is per route.** EDITOR is the
  *authorized* role on the three `vendors.edit` routes, so the inherited
  ADMIN/EDITOR default would have asserted a denial that never happens. Those
  rows run EDITOR-allowed / READER-refused instead, which also states the thing
  worth stating: the population that legitimately calls these routes is
  unaffected.

- **HTTP method became a parameter of the fixture.** `auditPermissionDenied`
  copies `req.method` into the row. A hard-coded `POST` would have made every
  DELETE row assert a method the request never carries — passing, and describing
  a request nobody makes.

## Residual — 37 destructive route files still without a route gate

Named rather than summarised, because "a coherent subset" is only honest if the
remainder is legible. Counts sum to 37.

**(a) Not tenant-role authorization — 10.** `account/avatar`, `sso`,
`scim/v2/Users/[id]`, and seven under `org/[orgSlug]/**` (initiatives ×2,
invites, members, tenants, dashboard widgets ×2). `requirePermission` resolves a
*tenant* role; these resolve an org membership, a SCIM bearer token, or the
session's own user. A different mechanism is needed, not this one.

**(b) Link / detach verbs at EDITOR tier — 16.** `assets/[id]/{controls,risks,
evidence}`, `business-continuity/[id]/dependencies/[depId]`,
`controls/[controlId]/{assets,contributors,evidence,requirements,risks}`,
`evidence/[id]/controls/[controlId]`, `policies/[id]/control-links`,
`risks/[id]/evidence/attached`, `risks/correlations`,
`risks/hierarchy/[nodeId]/links`, `tests/runs/[runId]/evidence/[linkId]`,
`vendors/[vendorId]/bundles/[bundleId]`. Each detaches an edge rather than
destroying a record, and each is recoverable by re-linking. Lower value per
migration than tranche 1 or 2 — worth a third pass, not worth bundling here.

**(c) Whole-entity destruction on a coarse `assertCanWrite` — 8.**
`automation/rules/[id]`, `business-continuity/[id]`, `evidence/[id]/archive`,
`processes/[id]/snapshots/[version]/restore`, `risks/hierarchy/[nodeId]`,
`risks/kri/[kriId]`, `risks/reports/schedules/[scheduleId]`,
`risks/scenarios/[scenarioId]`. `PermissionSet` has no coarse `*.write` key, and
several of these surfaces have no `PermissionSet` domain at all — so the key
would be invented rather than derived, which is a product decision and not a
mechanical migration. **This is the highest-value remaining group** and the
natural third tranche, once someone decides what those keys are.

**(d) Auditor lifecycle, role-tier assert — 2.** `audits/auditors/[auditorId]`
and `audits/auditors/access` assert `assertCanManageAuditors`, which tests
`ctx.role` against OWNER/ADMIN directly rather than reading a permission flag.
`admin.manage` is the closest key and carries the same custom-role divergence as
above — defensible, but it belongs in a diff that says so, alongside the other
role-tier asserts.

**(e) Self-service — 1.** `security/mfa/enroll` DELETE removes the caller's own
factor; already an `EXCLUDED_ROUTES` entry with a written reason.

### Not in the 37, but still the defect: gate present, weaker than the assert (2)

`assets/[id]/restore` and `tasks/[taskId]/restore` declare `.edit` keys over a
`restoreEntity` → `assertCanAdmin` usecase, so an EDITOR passes the middleware
and is refused where nothing writes a row. This is the more dangerous of the two
failure shapes named in `bulk-and-lifecycle-routes-audit-denials.test.ts` — the
route *looks* gated — and the census does not catch it, because both files
contain `requirePermission`. #2121 left them as "a product decision"; this
tranche honours that boundary rather than re-litigating it in a diff about
something else. Anyone picking it up should note that raising both to
`admin.manage` changes who may restore **not at all** — the usecase already
refuses every non-admin — and only moves the refusal to the layer that records
it.
