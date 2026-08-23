# 2026-08-24 — destructive register routes record their refusals (#2117)

**Commit:** `<pending> fix(security): audit destructive-route denials at the C.1 layer`

## Design

Two mechanisms authorize routes in this codebase and they are not
equivalent on the audit dimension:

```
requirePermission('<key>', handler)      denial → 403 + hash-chained AUTHZ_DENIED row
assertCan*(ctx) inside the usecase       denial → 403 + nothing
```

Authorization was already correct on every route touched here. The gap
was the record: a refused purge of the evidence register, or a refused
bulk delete of the vendor register, produced a status code in the
request log and silence in the audit trail. This is the same defect
Epic D.3 fixed for seven tenant routes, and #2111 already prevented
going forward; #2117 is the pre-existing population.

Eleven routes gained (or had corrected) a route-level gate. **Every
usecase assert stays in place** — it is what protects non-HTTP callers
(jobs, scripts), and the route gate is what makes a refusal visible.
Belt and braces, not a move.

### Choosing the key

The key was chosen per route by reading the assert behind it, never
derived from the path. Two failure directions, both real:

- **Weaker than the assert** — the caller passes the middleware and is
  thrown out by the usecase, so the exact denial the gate exists to log
  is the one it cannot see. `tasks/bulk/delete` shipped in this state
  (`tasks.edit` over `assertCanAdmin`).
- **Stricter than the assert** — the middleware refuses a caller the
  usecase would have admitted. This is why `policies/[id]/purge` gets
  `admin.manage` alone while `policies/bulk/delete` gets two keys: the
  purge path delegates to `purgeEntity`, whose assert is the coarse
  `assertCanAdmin`, and never reaches `assertCanAdminPolicies`.

`assertCanAdminPolicies` is a conjunction (coarse ADMIN **and**
`policies.edit`), so the two policy bulk verbs declare
`['admin.manage', 'policies.edit']` with the default `all` mode. That
mirrors the assert exactly. Adding the second key cannot lock anyone
out — the usecase already requires it — and it converts a class of
silent usecase refusals into logged route refusals.

`assertCanBulkManageTestPlans` reads `appPermissions.admin.manage`
directly, so the test-plan routes are the one case where the route gate
and the usecase gate are literally the same predicate.

## Files

| File | Role |
|---|---|
| `src/app/api/t/[tenantSlug]/evidence/bulk/delete/route.ts` | `admin.manage` (was ungated) |
| `src/app/api/t/[tenantSlug]/evidence/[id]/purge/route.ts` | `admin.manage` (was ungated) |
| `src/app/api/t/[tenantSlug]/evidence/[id]/restore/route.ts` | `admin.manage` (was ungated) |
| `src/app/api/t/[tenantSlug]/policies/bulk/delete/route.ts` | `['admin.manage','policies.edit']` (was ungated) |
| `src/app/api/t/[tenantSlug]/policies/bulk/archive/route.ts` | `['admin.manage','policies.edit']` (was ungated) |
| `src/app/api/t/[tenantSlug]/policies/[id]/purge/route.ts` | `admin.manage` (was ungated) |
| `src/app/api/t/[tenantSlug]/policies/[id]/restore/route.ts` | `admin.manage` (was ungated) |
| `src/app/api/t/[tenantSlug]/vendors/bulk/delete/route.ts` | `admin.manage` (was ungated) |
| `src/app/api/t/[tenantSlug]/tests/plans/bulk/delete/route.ts` | `admin.manage` (was ungated) |
| `src/app/api/t/[tenantSlug]/tests/plans/bulk/restore/route.ts` | `admin.manage` (was ungated) |
| `src/app/api/t/[tenantSlug]/tasks/bulk/delete/route.ts` | `tasks.edit` → `admin.manage` (weak gate corrected) |
| `src/lib/security/route-permissions.ts` | Declarative rules for the eleven, plus a split of the `assets/bulk/(status\|assign\|delete)` rule so the delete row states the `admin.manage` its handler has always declared |
| `tests/guardrails/api-permission-coverage.test.ts` | Eleven narrow leaf `PRIVILEGED_ROOTS` entries |
| `tests/guardrails/bulk-and-lifecycle-routes-audit-denials.test.ts` | `GATED` grows 7 → 16 destructive rows; new `GATED_MULTI` for the two-key policy verbs |
| `tests/unit/security/destructive-route-denial-audit.test.ts` | Behavioural proof, per route |
| `tests/guardrails/api-route-has-some-authorization.test.ts` | Detector proof repointed (see below) |
| `tests/helpers/route-authorization-graph.ts` | Docstring accuracy — its worked example now carries both layers |

## Decisions

- **Narrow leaf roots, not parent directories.** `evidence/bulk` also
  holds approve and assign; `policies/[id]` holds a dozen ordinary CRUD
  siblings. Widening the root would pull those in and force an
  `EXCLUDED_ROUTES` entry each — a list of carve-outs describing routes
  nobody examined, which is the shape that let `/api/account` and
  `/api/security` sit unlooked-at. The leaf is the population that was
  actually triaged.

- **`GATED_MULTI` is a separate map, not a `string | string[]` union.**
  A union would make every single-key assertion in that file read as
  "…or an array", which is precisely how a one-key regression on a
  two-key route would pass.

- **The layer-2 detector proof needed repointing, and got stronger.**
  `api-route-has-some-authorization.test.ts` used `evidence/[id]/purge`
  as its fixture for "a usecase assert three module hops away that only
  a graph walk can find". Gating that route made the fixture answer
  `ROUTE_PERMISSION` and the proof failed. Rather than swap in a
  shallower route, the probe now runs in three states — as shipped, with
  the route gate stripped (must still resolve `USECASE_ASSERT` via the
  walk), and with the usecase call stripped as well (must fall to
  `NONE`). The middle state is the one that keeps the walker honest; a
  two-state version would pass on a walker that had stopped following
  imports.

- **Not migrated, deliberately.** `processes/[id]/snapshots/[version]/restore`
  asserts the coarse `assertCanWrite` and there is no `processes.*`
  domain in `PermissionSet` — any key would be a guess, and the verb is
  not destructive anyway (the restore writes a new version, preserving
  history). `assets/[id]/restore` and `tasks/[taskId]/restore` both
  declare an `.edit` key over a `restoreEntity` that asserts
  `assertCanAdmin`: real weak-gate instances, but the right fix may run
  the other way — whether restoring a soft-deleted row should require
  ADMIN at all is a product decision, and their route comments show the
  `.edit` choice was made deliberately. Both are recoverable verbs and
  both left for a human. The recoverable bulk verbs (assign / status /
  approve / due) are out of scope by the issue's own framing.
