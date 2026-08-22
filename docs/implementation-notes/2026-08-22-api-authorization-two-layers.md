# 2026-08-22 — API authorization coverage as two honestly-labelled layers

**Issue:** #2099 — *api-permission-coverage: 489 of 582 routes are outside the
guard's population*

## Design

`tests/guardrails/api-permission-coverage.test.ts` builds its population from a
hand-written `PRIVILEGED_ROOTS` array. Measured: 582 route files on disk, 93 in
the population, 78 actually asserted. A route outside those roots could ship
with no permission enforcement and CI stayed green — not because the guard
passed it, but because it was never in the denominator.

The fix is **additive**, not a replacement. Two files, two different questions,
each named for the question it actually answers.

```
LAYER 1  api-permission-coverage.test.ts          (unchanged)
         population: 15 curated PRIVILEGED_ROOTS  → 93 files
         claim:      a LITERAL requirePermission(...) in the route file
                     + a matching ROUTE_PERMISSIONS entry
         strength:   strong. denials write a hash-chained AUTHZ_DENIED row.

LAYER 2  api-route-has-some-authorization.test.ts (new)
         population: every src/app/api/**/route.ts  → 582 files / 771 handlers
         claim:      SOME authorization is reachable from this handler
         strength:   weak, and named for it. no ordering, sufficiency or
                     liveness claim whatsoever.
```

Layer 2 accepts three things: a route-level `requirePermission`, a permission
decision reached through the call graph (the usecase layer's `assertCan*`), or
a declared exempt class. Layer 1 accepts only the first, on its own population,
and nothing here relaxes that.

**A first attempt replaced layer 1 with layer 2 and was rejected.** Accepting a
usecase `assertCan*` in place of a route-level gate was measured at a net
strictness regression on 25 routes: stripping the gate from `incidents/**`,
`sso/entra/**` and the asset bulk routes started passing. The two mechanisms
are not equivalent — a `requirePermission` denial writes an `AUTHZ_DENIED`
audit row and an `assertCanAdmin` denial writes nothing, which is the exact
defect Epic D.3 fixed for seven tenant routes. So layer 1 keeps its population
and its literal assertion, and the header of that file now says so explicitly.

### The analyser

`tests/helpers/route-authorization-graph.ts` is a syntactic (`ts.createSourceFile`,
no type checker) call-graph walk. Per exported HTTP handler it follows imports
up to `MAX_MODULE_HOPS = 3` looking for either a `requirePermission` call or the
SHAPE `if (<condition reading a request context's .permissions/.appPermissions/
.role>) throw …`. Same-module helper calls are free; re-export/barrel hops do
not consume the budget.

It classifies into four tiers: `ROUTE_PERMISSION`, `USECASE_ASSERT`,
`ROLE_PRESENCE_ONLY`, `NONE`. Measured over the tree:

| tier | handlers (771) | files, weakest handler (582) |
| --- | --- | --- |
| `ROUTE_PERMISSION` | 221 | 149 |
| `USECASE_ASSERT` | 463 | 363 |
| `ROLE_PRESENCE_ONLY` | 8 | 7 |
| `NONE` | 79 | 63 |

The first version of this paragraph read `149 / 363 / 8 / 79 handlers`, which
sums to 599 rather than 771 — it had taken three numbers from the per-FILE
distribution and one from the per-HANDLER one. Two units, one row. Worth
leaving the correction visible: the totals were both stated two lines apart and
neither reconciled against the other, which is the only reason it survived
writing.

`getTenantCtx()` is deliberately NOT a decision. It authenticates the session
and checks membership, but says nothing about what the caller may DO; counting
it would pass every tenant route and make the layer vacuous.

### Exempt classes, and why they are not just a list

Eight classes, each naming the credential that authorises the caller instead of
a tenant role — and, where one exists, a `mechanism` pattern the route source
must still match:

| class | corroboration |
|---|---|
| `PRE_TENANT_AUTH` | structural: membership confined to `/api/auth/` |
| `SESSION_SELF_SERVICE` | a session/context resolver is still called |
| `SIGNED_WEBHOOK` | the signature / OAuth-state check is still present |
| `PROTOCOL_CREDENTIAL` | per-entry: `verifyPlatformApiKey`, `authenticateScimRequest`, `authenticateMcpRequest`, `authorizeDeviceReport`, `STAGING_SEED_TOKEN` |
| `MEMBERSHIP_SCOPED` | the tenant/org context resolver is still called |
| `CAPABILITY_TOKEN` | weak — only that the route still mentions a token |
| `PUBLIC_UNAUTHENTICATED` | none possible → a per-handler note is mandatory |
| `NO_AUTHORIZATION` | none possible → a per-handler note is mandatory |

That is what stops the allowlist being a list of trusted paths. A webhook route
that stops verifying its signature fails CI even though its exemption entry is
untouched.

### Calibration

An independent six-agent survey classified all 582 routes and found exactly 6
with no authorization anywhere; 3 were refuted as membership-scoped reads,
2 are tracked fixes (#2103 `security/csp-report` GET, #2104
`account/avatar/[userId]` GET) and 1 was benign (`onboarding/state`). This
guard's `NO_AUTHORIZATION` class holds exactly those 2, the benign one sits in
`MEMBERSHIP_SCOPED`, and the residual size is pinned by an assertion so it
cannot drift upward quietly.

The `ROLE_PRESENCE_ONLY` tier is `if (!ctx.role) throw …` — a condition never
false for a real authenticated request, because `getTenantCtx` already refused
a non-member. It authenticates without authorising. Eight handlers, pinned by
exact equality in both directions.

### Fail direction of every known blind spot

Enumerated in the guard file rather than claimed away. **This rule is not
fail-closed as an unqualified property.**

Fail CLOSED (flags something fine, costs a triage): chains deeper than 3 hops;
a context bound to an identifier outside `CONTEXT_ROOTS`; `const { role } = ctx`
destructuring; decisions written as a ternary / `&&` / `switch`; handlers built
by a factory beyond the hop budget or from `node_modules`.

Fail OPEN (recorded because pretending otherwise is worse): **ordering,
sufficiency and liveness** — a check after the destructive write, a `risks.view`
gate on a DELETE, or a gate behind a permanently-false flag all read as "has
authorization"; `branchDenies` counts any `throw`, so a defensive sanity assert
on `ctx` reads as a permission decision; the 401/403 fallback is a text match
on the branch.

## Files

| File | Role |
|---|---|
| `tests/helpers/route-authorization-graph.ts` | The syntactic call-graph analyser + tier model. New. |
| `tests/guardrails/api-route-has-some-authorization.test.ts` | Layer 2: the tree-wide net, its exempt classes, and the detector regression proofs. New. |
| `tests/guardrails/api-permission-coverage.test.ts` | Layer 1. Comment-only change: a header section stating that layer 2 is weaker and additive, and that this file must never be softened to lean on it. |

## Decisions

- **Handler granularity, not file granularity.** Exemptions are keyed
  `<path>#<METHOD>`. `security/mfa/policy` has an ungated GET next to an
  `admin.manage` PUT; `org/[orgSlug]/tenants` has an ungated GET next to a
  gated POST. A file-level carve-out would hide a future DELETE added beside
  an exempted GET.
- **Exact equality in both directions on the exempt list.** A handler that
  gains a real gate makes its own exemption stale and fails CI, so the list
  cannot accumulate dead entries that read like considered carve-outs. The
  same rule pins `ROLE_PRESENCE_ONLY`.
- **The identity matcher is rooted at a request context.** An earlier draft
  matched `.role` / `.permissions` on any object, so
  `if (body.role === 'OWNER') throw badRequest(…)` — input validation — read as
  an authorization decision. Measured in `src/`, `.role` is read off `input`
  (37x), `membership` (41x) and `body` (5x) at least as often as off `ctx`
  (39x), so that matcher was wrong about as often as it was right.
  `CONTEXT_ROOTS` is now a five-name set and an unrecognised root fails closed.
- **`NO_AUTHORIZATION` is an output, not a carve-out.** It is a declared class
  so the residual is visible and countable, with a hard cap of 2 and a required
  issue reference per entry — not a place to park a new route to get CI green.
- **The population comes from git**, via `repoRelativeFiles()`. Here that is
  correctness and not only hygiene: `.claude/worktrees/<id>/` holds a full
  second copy of `src/app/api`, which an `fs` walk from the repo root would
  classify twice.
- **Every "no offenders" assertion has a positive companion.** Floors on the
  population (>500 files, >700 handlers) and on the gated share (>600 handlers,
  >100 route-level) mean a detector that silently stops resolving anything
  fails rather than reporting a clean tree.
- **Known follow-up:** the purge / bulk-delete class is authorized but
  *unaudited* — the usecase `assertCan*` throws a 403 and writes no
  `AUTHZ_DENIED` row. Migrating those destructive routes to route-level
  `requirePermission` (and into layer 1's population) is worthwhile on its own
  merits; layer 2 accepting them today is a tractability decision, recorded as
  a weaker tier rather than treated as equivalent.
