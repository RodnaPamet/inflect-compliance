# 2026-08-31 — the destructive-route census records decisions, not just gaps

**Commit:** `(this PR)` fix(authz): audit the MFA-removal denial, and give every census entry a disposition

Closes #2190, #2191. Refs #2117.

## Design

Two changes that belong together, because the second is what the first uncovered.

**The census entries carry a disposition and a reason.** `UNGATED_DESTRUCTIVE_ROUTES`
was `readonly string[]`, so every entry meant the same thing: *not done yet*. After
four tranches that reading is wrong — what remains is what the `requirePermission`
mechanism cannot take, and each entry is a different reason. A residual nobody can
distinguish from a backlog gets re-triaged from scratch every time somebody looks
at it, which is exactly what happened when #2189 was filed calling these
"straightforward gaps".

    'todo'   — a real gap; names its issue
    'exempt' — a decision; the reason is the whole entry

**An exemption is not permission to leave a refusal unrecorded.** Two of the three
SCIM/avatar exemptions have no refusal to record at all. The fourth does, and that
is the second change.

## What the triage found

`t/[tenantSlug]/security/mfa/enroll` was filed (by me, in #2191) as a self-service
carve-out. It is not. The DELETE takes an optional `targetUserId`, and
`removeMfaEnrollment` contains a real authorization branch:

```ts
if (effectiveUserId !== ctx.userId && !ctx.permissions.canAdmin) {
    throw forbidden("Only admins can remove other users' MFA enrollment");
}
```

That refusal wrote nothing. **Removing another user's second factor turns an
account defended by two factors into one defended by a password** — a refused
attempt at it is precisely what a reviewer looks for after a compromise, and it
was the most attack-relevant unrecorded refusal left on the census.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/mfa-enrollment.ts` | audits the admin-branch refusal |
| `tests/unit/usecases/mfa-enrollment.test.ts` | four assertions on the row, the failure contract, and the negative |
| `tests/guardrails/destructive-route-denial-census.test.ts` | disposition + reason per entry, three new structural tests |

## Decisions

- **Audited in the usecase, not at the route, because the route is dual-mode.**
  With no body the DELETE removes the *caller's* enrolment and every member may
  do that; with `targetUserId` it is an admin action. A single route-level
  permission would either break self-service or admit everyone. The decision has
  to live where the two modes are distinguishable.

- **`entityId` is `permissions.canAdmin`, not a `PermissionKey`.** The check reads
  a coarse role-tier predicate and is not keyed on a permission. Writing a key
  there would put something in the trail that no route actually gates on.

- **The write is awaited and swallows its own failures**, matching
  `auditPermissionDenied`. Awaited because `appendAuditEntry` takes a per-tenant
  advisory lock in its own transaction and this function holds none, so there is
  no nesting hazard. Swallowing because a refusal must reach the caller even if
  audit storage is down — inverting that would turn an audit outage into an
  authorization bypass, the one way a logging change can make a system *less*
  safe than logging nothing. There is a test for it.

- **A negative test guards the other direction.** A helper that recorded
  unconditionally would satisfy every positive assertion while filling the trail
  with denials that never happened. That misleads an auditor rather than leaving
  them short, which is worse, so the admin-allowed path asserts no row.

- **The gap count is a ratchet; exempt entries do not count toward it.** Gating a
  route, or reclassifying one to `exempt` *with an argument*, lowers it in the
  same diff. The reason-length check exists so a disposition cannot become the
  bare string list wearing a type.

- **The SCIM pair is exempt because there is no refusal.** Both SCIM usecases
  contain zero `assertCan*` and zero `forbidden(` calls;
  `authenticateScimRequest` returns `{tenantId, tokenId, tokenLabel}`, not a
  `RequestContext`; `TenantScimToken` has no scope column. A gate there would be
  a check that never fires, and a permanently-passing gate reads as coverage.
  The unscoped-token property that follows from this is #2200.
