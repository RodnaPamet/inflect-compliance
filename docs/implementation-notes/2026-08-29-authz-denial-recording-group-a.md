# 2026-08-29 — #2117 group A: destructive routes whose refusals now leave a row

**Branch:** `fix/authz-residual-group-a` — fix(authz): record refusals on five destructive routes an existing key already gated

## Design

`AUTHZ_DENIED` is written in exactly one place — `auditPermissionDenied` inside
`requirePermission`. A usecase `assertCan*` throws `forbidden(...)` and writes
nothing. So a destructive route that authorizes only in its usecase refuses the
right people and records nothing, which in a compliance product is a hole in the
one artefact the product exists to produce.

The declared residual is `UNGATED_DESTRUCTIVE_ROUTES` in
`tests/guardrails/destructive-route-denial-census.test.ts`. This tranche took
the subset where an **already-existing** permission key admits exactly the
population the usecase already admits — no new key, no access change, only the
recording changes. 18 entries → 13.

The method was per route: open the usecase, read the assert, derive the key from
**that**, never from the URL path.

| Route (DELETE unless noted) | Usecase assert | Predicate the assert reads | Key |
| --- | --- | --- | --- |
| `audits/auditors/[auditorId]` | `assertCanManageAuditors` | `ctx.role ∈ {OWNER, ADMIN}` | `admin.manage` |
| `audits/auditors/access` (POST + DELETE) | `assertCanManageAuditors` | `ctx.role ∈ {OWNER, ADMIN}` | `admin.manage` |
| `automation/rules/[id]` (PUT + PATCH + DELETE) | `assertCanManageAutomation` | `ctx.permissions.canAdmin` | `admin.manage` |
| `vendors/[vendorId]/bundles/[bundleId]` (POST + DELETE) | `assertCanManageVendorDocs` | `ctx.appPermissions.vendors.edit` | `vendors.edit` |
| `tests/runs/[runId]/evidence/[linkId]` | `assertCanLinkTestEvidence` | `ctx.appPermissions.tests.execute` | `tests.execute` |

The bottom two are the strongest form of "mirror the assert": the key IS the
expression the policy helper evaluates, so the admitted set is provably
unchanged for custom roles too. The top three mirror a role-tier predicate onto
an `appPermissions` flag — the same coarse↔granular swap the first #2117 tranche
made for `assertCanAdmin` → `admin.manage`, and the same residual imprecision.

Every usecase assert stays. It is what protects jobs, scripts and any future
non-HTTP caller; the route gate is what makes an HTTP refusal visible.

## Files

| File | Role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/audits/auditors/[auditorId]/route.ts` | DELETE gated `admin.manage` |
| `src/app/api/t/[tenantSlug]/audits/auditors/access/route.ts` | POST + DELETE gated `admin.manage`; body moved to `parseJsonBody` inside the handler |
| `src/app/api/t/[tenantSlug]/automation/rules/[id]/route.ts` | PUT/PATCH/DELETE gated `admin.manage`, bodies moved to `parseJsonBody`; GET untouched |
| `src/app/api/t/[tenantSlug]/vendors/[vendorId]/bundles/[bundleId]/route.ts` | POST/DELETE gated `vendors.edit`, add-item body moved to `parseJsonBody`; GET untouched |
| `src/app/api/t/[tenantSlug]/tests/runs/[runId]/evidence/[linkId]/route.ts` | DELETE gated `tests.execute` |
| `src/lib/security/route-permissions.ts` | Five rules, each with the assert it mirrors written down |
| `tests/guardrails/api-permission-coverage.test.ts` | Four leaf roots + one non-leaf root with three examined exclusions |
| `tests/guardrails/destructive-route-denial-census.test.ts` | Five lines deleted from the residual |
| `tests/unit/security/destructive-route-denial-audit.test.ts` | Six table rows, the auditor key-choice suite, and the parseJsonBody-ordering suite |

## Decisions

- **`admin.manage`, not `audits.manage`, for the two auditor routes — and the
  usual reason given for this is wrong.** The reported trap was that
  `audits.manage` "would admit EDITORs". It would not:
  `getPermissionsForRole('EDITOR').audits.manage` is `false`, so both keys admit
  exactly `{OWNER, ADMIN}` among built-in roles. The real hazard is custom roles.
  `assertCanManageAuditors` reads `ctx.role`, which a custom role does **not**
  change, while `audits.manage` is an `appPermissions` flag — and it is precisely
  the flag a tenant would grant an EDITOR-based "audit coordinator" role. Under
  an `audits.manage` gate that caller passes the middleware and is thrown out by
  the usecase, writing nothing: the invisible denial, reintroduced. The same
  hazard exists for `admin.manage` in principle, but a tenant granting
  `admin.manage` to a non-admin custom role has said something much closer to
  "this person is an admin". The choice is pinned behaviourally, not by a
  comment — see the `audits.manage`-only caller in the test file.
- **`parseJsonBody` inside the handler, never `withValidatedBody` around it.**
  Both want the third handler argument. `parseJsonBody` also puts authorization
  BEFORE body parsing, which is the order we want, and upgrades malformed JSON
  from an unhandled `SyntaxError` (500) to a 400.
- **`automation/rules/[id]` is the one non-leaf privileged root.** Its
  `dry-run/`, `executions/` and `re-trigger/` siblings come with it because
  `walkRouteFiles` recurses. Each was read before being excluded — none is
  destructive, and none has an existing key mirroring the coarse
  `assertCanExecuteAutomation` / `assertCanReadAutomationHistory` behind it
  (the latter is `canRead OR canAudit`, which no single key expresses). Taking
  the root is the stronger option: a fourth route added there now fails until
  somebody triages it.
- **Skipped: `business-continuity/[id]` and `.../dependencies/[depId]`.** Both
  gate on the coarse `assertCanWrite` (OWNER/ADMIN/EDITOR). Several existing
  keys carry that exact built-in population — `controls.edit`, `risks.edit`,
  `tasks.edit` — but every one of them OWNS a different register. Binding BIA
  deletion to another domain's flag would mean a future change to that register's
  permissions silently changes who can delete a business impact analysis. That is
  a new-key decision (`continuity.*`), not this tranche's.
- **The two multi-verb files took their write siblings in the same diff, not
  a later one.** Gating only the destructive verb would have left
  `automation/rules/[id]` and `vendors/[vendorId]/bundles/[bundleId]` as MIXED
  MODULES — a gated DELETE beside an ungated PUT/PATCH/POST — which is exactly
  the blind spot #2168 had to reopen the census for and #2171 had to reopen
  seven files to close (see
  `2026-08-29-mixed-module-write-gates.md`). Each sibling takes the key its own
  DELETE takes, because the same assert sits behind it. GET stays at the usecase
  layer on both: reads are a different question and neither has a key meaning
  "view automation rules".
- **The `parseJsonBody` ordering is asserted from both sides**, following the
  mixed-module note's template: an unauthorized caller sending unparseable JSON
  gets 403 (not the 400 a `withValidatedBody` revert produces, which also never
  reaches `auditPermissionDenied` — the invisible refusal, back again), and an
  authorized caller sending a type-invalid body still gets 400 (so "gate first"
  was not achieved by dropping validation). Mutation-verified: reverting the
  automation PATCH to `withValidatedBody` fails exactly the first of those.
- **The ROUTES table's uniqueness key became `(method, path)`.** It was `path`
  alone, which made covering both verbs of `auditors/access` impossible while
  claiming to forbid duplication. The intent — one row per HANDLER — is what the
  new key actually expresses.
