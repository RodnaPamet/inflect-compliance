# 2026-07-28 — Vendor authz: enforce the custom-role keys, gate the sub-processor register

**Commit:** `<sha>` fix(vendors): make the vendors.* permission keys enforceable + gate the sub-processor routes

Closes the follow-up named in `2026-07-21-admin-privacy-posture.md`. That note
flagged the sub-processor routes as "an authz gap, not a privacy-page concern".

## What the original finding got right, and what it got wrong

The note said the routes "are gated only by tenant membership, so any member can
read or modify sub-processor relationships."

**Half of that is wrong.** All four usecases already asserted:

| usecase | assert | resolved to |
|---|---|---|
| `listSubprocessors` | `assertCanReadVendors` | `permissions.canRead` |
| `listSubprocessorChain` | `assertCanReadVendors` | `permissions.canRead` |
| `addSubprocessor` | `assertCanManageVendors` | `permissions.canWrite` |
| `removeSubprocessor` | `assertCanManageVendors` | `permissions.canWrite` |

`canWrite` is false for READER and AUDITOR, so a plain member on a built-in role
could **not** modify the register. Verified before writing any code rather than
taken on faith.

**But there was a real gap underneath, and a worse one than "no middleware".**

## The actual defect: the `vendors.*` keys were unenforceable

`computePermissions(role)` (`src/lib/tenant-context.ts`) takes ONLY the `Role`
enum and derives its flags from a role-level table. It is *structurally* blind to
a custom role's `permissionsJson`. Every vendor usecase gated on that coarse set,
so the granular `vendors: { view, create, edit }` keys — which the custom-role
editor happily writes — were decorative.

Concretely: a custom role on an EDITOR base with `vendors.edit: false` still
passed `assertCanManageVendors` and could create, edit and delete vendors,
vendor documents, assessments, templates, and the GDPR Art.28 sub-processor
register. The permission UI said no; the server said yes.

This is the same defect the tests domain fixed on 2026-07-27, and
`test.policies.ts`, `control.policies.ts`, `policy.policies.ts`,
`evidence.policies.ts`, `task.policies.ts` and `incident.policies.ts` had all
already migrated. `vendor.policies.ts` was the straggler.

**Built-in role behaviour is unchanged** — verified against
`getPermissionsForRole` rather than assumed:

| | `vendors.view` | `vendors.edit` |
|---|---|---|
| OWNER / ADMIN / EDITOR | true | true |
| AUDITOR / READER | true | false |

which is exactly `canRead` and `canWrite` respectively.

## The second gap: no C.1 layer

The routes had no `requirePermission`, so a denial threw a bare 403 that wrote no
hash-chained `AUTHZ_DENIED` row, and the routes were invisible to the
permission-coverage guardrail — a future refactor could have dropped the usecase
assert with nothing in CI failing.

Both routes now gate at the middleware AND the usecase, and the sub-processor
directory is a narrow leaf entry in `PRIVILEGED_ROOTS` so the guardrail holds the
line. Its `vendors/[vendorId]` siblings are deliberately NOT in scope.

## Files

| File | Role |
|---|---|
| `src/app-layer/policies/vendor.policies.ts` | Five helpers moved to `appPermissions.vendors.*`. One file, 43 call sites fixed. |
| `.../vendors/[vendorId]/subprocessors/route.ts` | `requirePermission` on GET/POST/DELETE. |
| `.../subprocessors/chain/route.ts` | `requirePermission` on GET. |
| `src/lib/security/route-permissions.ts` | Split read/write rules for the register. |
| `tests/guardrails/api-permission-coverage.test.ts` | Narrow leaf `PRIVILEGED_ROOTS` entry. |
| `tests/unit/vendor-policies.test.ts` | Rewritten — fixtures derived from the real permission map + 6 custom-role cases. |
| 3 further vendor test files | `appPermissions` added to hand-built mock contexts. |

## Decisions

- **Fixed the helpers, not just the sub-processor path.** The task was scoped to
  sub-processors, but the defect lives in `vendor.policies.ts` and every vendor
  usecase shares it. Patching only the sub-processor path would have left the
  same hole in vendor documents, assessments and templates while claiming the
  gap was closed. One file, 43 call sites.

- **`assertCanApproveAssessment` deliberately left on `canAdmin`.** There is no
  `vendors.approve` key to migrate to, and folding it into `admin.manage` would
  widen the change beyond the gap. Called out rather than bundled silently.

- **The test fixtures now DERIVE from `getPermissionsForRole` / `computePermissions`.**
  The old `vendor-policies.test.ts` hand-wrote `{ permissions: {...} }`, which is
  precisely why it stayed green while the granular keys were dead — the mock
  asserted the same coarse flags the implementation read. Deriving them means the
  fixture cannot drift from production. The six new custom-role cases hold the
  coarse tier constant and flip only the granular key, so a regression to
  `ctx.permissions.*` fails them and nothing else does. One case deliberately
  runs the other direction — a READER-based custom role *granted* `vendors.edit`
  is allowed — which fails if the helper reads either channel by accident.

- **Three other vendor test files needed `appPermissions` on their mock contexts.**
  They set `appPermissions: {} as never`, so the switch turned into a TypeError
  rather than a clean denial. Rather than paper over it, each helper's
  `canWrite`/`canRead` knob now moves the matching `vendors.*` key, so the tests
  still express what they were written to express.
