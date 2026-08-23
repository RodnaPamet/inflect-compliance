# 2026-08-23 — one policy, six routes

**Commit:** `(this branch) fix(authz): assertCanViewFrameworks reads the permission, not the role`

## Design

`assertCanViewFrameworks` was, in its entirety:

```ts
export function assertCanViewFrameworks(ctx: RequestContext) {
    // All roles can view frameworks and coverage
    if (!ctx.role) throw forbidden('Authentication required');
}
```

That is an **authentication** check wearing authorization's clothes. `getTenantCtx`
always populates `ctx.role` for a real request, so the branch could never be
taken. The policy has ~14 call sites, and the six API routes above them were
classified `ROLE_PRESENCE_ONLY` by the layer-2 guard that landed the same week.

It now reads `ctx.appPermissions.frameworks.view`.

## Why this was one change and not six

The guard listed eight handlers. Fixing this single policy cleared **six** of
them in one edit, because they were never eight separate bugs — they inherited
one shared policy:

```
api/mcp/route.ts#POST
api/t/[tenantSlug]/frameworks/route.ts#GET
api/t/[tenantSlug]/frameworks/[frameworkKey]/route.ts#GET
api/t/[tenantSlug]/frameworks/[frameworkKey]/tree/route.ts#GET
api/t/[tenantSlug]/onboarding/frameworks/route.ts#GET
api/t/[tenantSlug]/reports/readiness/route.ts#GET
```

The two that remain — `search` and `traceability/graph` — each carry their own
inline `if (!ctx.role)` in their own usecase. They are the same *shape*, not
dependents of this policy, and are deliberately untouched.

## `reports/readiness` is the instructive one

It cleared **without a route-level `reports.view` gate**, because
`generateReadinessReport` opens with the policy call.

An earlier, much larger attempt at this work did add a route-level gate there.
Adversarial review found it bypassable: `src/app/t/[tenantSlug]/(app)/reports/page.tsx`
calls `generateReadinessReport(ctx, …)` directly, so a custom role with
`reports.view: false` was refused by the API and served by the page. Gating the
shared policy covers both callers **by construction** — that is the structural
argument for fixing a root cause rather than adding gates at each mouth.

## Who this changes

| population | effect |
|---|---|
| OWNER / ADMIN / EDITOR / AUDITOR / READER | **none** — all carry `frameworks.view: true` |
| system + job contexts | **none** — they carry a full ADMIN `PermissionSet` |
| `TenantCustomRole` with `frameworks: { view: false }` | **now refused** — the intended fix |
| API keys | **breaking, see below** |

## The API-key break, stated rather than buried

`scopesToPermissions` derives `appPermissions` from a key's scopes, and
`mcp: { read: [], propose: [], orchestrate: [] }` maps `mcp:read` to an **empty
action list**. So a key minted with `mcp:read` and no `frameworks:read` now
fails this policy where it previously passed.

That matches the documented model — `api-key-auth.ts` says `mcp:read` is the
scope required *alongside* a resource scope, not instead of one — so a key
without `frameworks:read` was already outside the intended design. But keys in
the wild may not have been minted that way, and the failure surfaces as an
in-band JSON-RPC forbidden on `resources/list`. **Re-scope affected keys with
`frameworks:read`.**

## Files

| file | role |
|---|---|
| `src/app-layer/policies/framework.policies.ts` | the change, and its blast radius |
| `tests/unit/policies/framework-view-permission.test.ts` | the behavioural contract |
| `tests/guardrails/api-route-has-some-authorization.test.ts` | six entries removed from the pin |
| `tests/integration/framework-coverage.test.ts` | a test named for the old behaviour, corrected |

## Decisions

- **Narrowed deliberately.** A first attempt covered `search`, `traceability`,
  `reports` and API-key scopes across 33 files and +1500 lines, and its verifier
  returned `sound=false` with a live bypass. This is the root cause alone. The
  rest is follow-up, and is better done knowing this landed cleanly.

- **The positive test is the load-bearing one.** `it.each` over all five
  built-in roles asserting they are still admitted. A refusal test alone passes
  against a policy that refuses everyone — which would be an outage, not a fix,
  on routes that back pages READER and AUDITOR use.

- **The stale test was corrected, not deleted.** `assertCanViewFrameworks allows
  any role` stopped being true. Its outcome for those four roles is unchanged,
  but it passed `{ role: 'READER' }` with no `appPermissions` — a shape no
  caller produces. Renamed to say what is now true and given a real context.

- **Mutation-proved at both layers.** Restoring the role-presence check fails
  three behavioural assertions AND the guardrail pin, which re-lists all six
  routes. Neither layer alone would have caught it: the guard sees the shape,
  the unit tests see the behaviour.
