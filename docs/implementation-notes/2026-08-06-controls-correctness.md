# 2026-08-06 — Controls: seven correctness defects

**Commit:** `<pending> fix(controls): seven correctness defects`

Each item has a behavioural test. No refactoring beyond what each required,
with one exception noted under item 5.

## 1. RLS — the permissive-sibling leak (CRITICAL)

`Control` is the third model with a nullable `tenantId`, and it was the only
one NOT in `SINGLE_POLICY_EXCEPTIONS` — so it carried the split shape that
`rls-coverage.test.ts` explicitly documents as leaky:

```
tenant_isolation        FOR ALL  USING ("tenantId" IS NULL OR own)
tenant_isolation_insert FOR INSERT WITH CHECK (own)
```

Two Postgres behaviours combine badly. A `FOR ALL` policy with no explicit
`WITH CHECK` reuses its `USING` as the implicit one — so `tenant_isolation`
silently permitted WRITES satisfying `("tenantId" IS NULL OR own)`. And
permissive policies OR together, so the strict INSERT sibling could never
*restrict* anything; it only added another way to pass.

Under `app_user` that permitted three cross-tenant writes: UPDATE of a
global-library row; INSERT of a global row; and — worst — setting an owned
row's `tenantId` to NULL, **promoting a private control into the shared
catalogue for every tenant**.

Migration `20260806120000` replaces both with one asymmetric policy in the
`UserSession` shape: `USING (tenantId IS NULL OR own) WITH CHECK (own)`.
`Control` is added to `SINGLE_POLICY_EXCEPTIONS` in the same diff — that is
enforcement, not suppression, because the post-loop sanity check verifies
both clauses are really present.

`tests/integration/control-rls.test.ts` covers all three attack paths plus
the read path, which must NOT regress: the permissive `USING` exists so
tenants can see the shared library, and a "fix" that tightened it to `own`
would pass every write-side assertion while breaking the product.

One expectation was wrong on first run and worth recording: UPDATE of a
global row raises 42501 rather than silently matching zero rows, because
the row IS visible via `USING`, so the UPDATE matches and then `WITH CHECK`
rejects the new image. That is the louder behaviour and the one we want.

## 2. `annexId` uniqueness was global (CRITICAL)

`annexId String? @unique` compiled to a global unique index. But annexId is
the framework's annex reference — `A.5.1` — which every tenant adopting ISO
27001 uses, and it IS written on tenant-owned rows. So the first tenant to
claim `A.5.1` blocked every other tenant permanently, seeding a second
tenant's annex set failed P2002, and the resulting 500 was a cross-tenant
existence oracle.

Migration `20260806130000` moves tenant rows to `UNIQUE (tenantId, annexId)`.
The **global library needed explicit handling**: Postgres treats NULLs as
distinct in a unique index, so that composite cannot constrain
`(NULL, 'A.5.1')` twice. The shared catalogue should still hold one control
per annex reference, so that half is a PARTIAL unique index on `annexId`
WHERE `tenantId IS NULL` — documented in `controls.prisma`, because Prisma
cannot express a filtered index.

## 3-4, 6. The status and create vocabularies

Three schema changes that make the UI and the API agree:

- `BulkControlStatusSchema` no longer accepts `NOT_APPLICABLE`. N/A is an
  applicability *decision*: the single-control path requires a
  justification, stamps `applicabilityDecidedBy/At` and writes a
  `CONTROL_APPLICABILITY_CHANGED` audit row. The bulk path runs `updateMany`
  and can do none of it, so it produced an unjustified, unattributed N/A
  with an audit row mistyped as `status_change`. The only guard was
  client-side, and its own comment named the defect.
- `SetControlStatusSchema` widens from four to the six the detail dropdown
  offers. Selecting Planned or Implementing returned 400
  `invalid_enum_value` from a control the UI presented as selectable.
- `CreateControlSchema` declares `objective` / `successCriteria` /
  `testingMethodology`. `createControl` has always written them, but the
  schema ends in `.strip()`, so POST /controls removed them before the
  usecase saw them — a 201 with `objective: null` and no warning.
  `agent-proposals.ts` parses through the same schema, so AI-proposed
  controls lost them too.

With `NOT_APPLICABLE` excluded from both status schemas, all three status
write paths now accept the same set — asserted directly in the test.

## 5. `automationType` / `mitigationType` never persisted

Both are wired Comboboxes on the edit modal, seeded from the loaded control,
accepted by Zod, written by `updateControl` — and absent from the PATCH
body. The modal closed, `toast.success` fired, and the stale value
re-rendered on refetch.

**The one refactor beyond the minimum**: the body mapping moved from an
inline `JSON.stringify({...})` inside a `useTenantMutation` callback to
`_lib/control-edit-payload.ts`. Inline, the only way to observe it was to
mount a 1,383-line page — which is precisely why two fields could be missing
from it for as long as they were. The extraction is what makes the fix
testable, and the test pins the whole key set rather than the two that were
missing.

## 7. Two template-install paths, two different Controls

`controls.prisma` documents that objective/successCriteria/testingMethodology
are "Copied onto the Control on install" and relatedPolicies is "resolved to
PolicyControlLink per-tenant on install". `framework/install.ts` honoured all
of it; `control/templates.ts` wrote code/name/category/frequency only. Both
endpoints are exported and reachable, so which fields your control ended up
with depended on how you installed it.

Both now build their `data` from `controlDataFromTemplate` in
`control/template-projection.ts`, and the thin path gained the policy-link
resolution it never had.

## Decisions

- **The RLS test asserts the read path too.** Every write-side assertion
  would still pass if someone "fixed" the leak by tightening `USING` to
  `own` — and the product would break, because tenants could no longer see
  the shared library.
- **The partial index is not optional.** Without it, moving to a composite
  on a nullable column would have quietly removed the global library's
  uniqueness while looking like a pure improvement.
- **A source-text guard was rewritten, not worked around.**
  `internal-controls-coverage.test.ts` asserted the literal
  `objective: tmpl.objective` inside `install.ts`, so extracting the shared
  projection broke it. It now asserts the delegation; the fields themselves
  are covered per-field in the projection's own test.
