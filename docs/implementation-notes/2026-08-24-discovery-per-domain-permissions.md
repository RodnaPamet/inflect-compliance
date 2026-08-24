# 2026-08-24 — per-domain permissions for search and the traceability graph

**Commit:** `(this branch) fix(authz): gate unified search + traceability graph per domain`

Finishes the pair the 2026-08-23 framework-permission change deliberately left
behind. `ROLE_PRESENCE_ONLY_HANDLERS` in
`tests/guardrails/api-route-has-some-authorization.test.ts` is now **empty**,
which turns its exact-equality assertion into a standing rule: no handler
anywhere may reach only a role-presence check.

## Design

Both usecases opened with

```ts
if (!ctx.role) throw forbidden('Authentication required');
```

`getTenantCtx` populates `ctx.role` on every path — session and API key alike
(`api-key-auth.ts` derives a role from the key's scopes) — so the branch was
unreachable. Neither usecase read `ctx.appPermissions` at all, so a
`TenantCustomRole` with `evidence: { view: false }` still received evidence
titles from search and control/risk/asset labels from the graph, while the
matching list pages refused it.

The gate is **per domain, and it skips rather than refuses**:

```
search        control risk policy evidence asset task test  framework
              ─────── ──── ────── ──────── ───── ──── ────  ─────────
              controls risks policies evidence assets tasks tests frameworks   ← PermissionSet domain

graph         control risk asset requirement policy
              controls risks assets frameworks policies
```

Each entity query runs only under `<domain>.view`. A denied domain resolves to
`Promise.resolve([])` — one fewer `WHERE … ILIKE` or table scan, not one more
check. The response cannot then claim what it withheld: `capPerType`
initialises every `SearchHitType` count to 0, and `buildTraceabilityGraph`
computes `categories` counts from the FINAL node list and keeps only edges
whose both endpoints survived, so a denied graph kind takes its edges and its
legend entry with it.

The link tables in the graph are gated on **both** endpoints' permission, which
is pure subtraction: an edge whose far end the caller may not see could never
survive the both-endpoints filter, so fetching it was always waste.

`assertAnyDomainViewable(ctx, domains, surface)` covers the degenerate end of
the same scale — a caller who can view NONE of a surface's domains is told so
rather than handed an empty payload indistinguishable from "this tenant has no
data". No built-in role reaches it: OWNER / ADMIN / EDITOR / AUDITOR / READER
all carry `view: true` on all eight domains in `getPermissionsForRole`, and the
unit test asserts that against `permissions.ts` directly rather than trusting a
fixture.

Both fixes live in the **usecase**, not the route, and the graph is the reason
that matters: `/t/[slug]/controls/sankey` is a server component that calls
`getTraceabilityGraph` directly. A route-level gate would have refused the API
and served the page — the same bypass adversarial review found in the first
attempt at the framework change.

## Files

| file | role |
|---|---|
| `src/app-layer/policies/discovery.policies.ts` | new — `canViewDomain` + `assertAnyDomainViewable`, and the argument for skipping over refusing |
| `src/app-layer/usecases/search.ts` | `SEARCH_DOMAINS` map, per-query gating, framework gating, dead task-description clause removed |
| `src/app-layer/usecases/traceability-graph.ts` | `GRAPH_DOMAINS` map, per-kind gating folded into the existing `wantKinds` ternaries, link tables gated on both endpoints |
| `tests/unit/policies/discovery-domain-visibility.test.ts` | the behavioural contract, both directions |
| `tests/integration/search-usecase.test.ts` | denied-domain skipping against a real DB; the encrypted-column evidence |
| `tests/integration/traceability-graph-usecase.test.ts` | denied-kind skipping, and its edges and category going with it |
| `tests/unit/search-route.test.ts`, `tests/unit/traceability-graph-route.test.ts` | the mocked 403-mapping tests said "Authentication required", a message that no longer exists |
| `tests/guardrails/api-route-has-some-authorization.test.ts` | the pin, now empty |

## Decisions

- **Global frameworks are gated, and NOT for confidentiality.** The catalogue
  is public standards text, identical for every tenant; withholding it protects
  nothing. It is skipped because a framework hit is a link into
  `/t/<slug>/frameworks/<key>`, and that page has refused `frameworks.view:
  false` since 2026-08-23. Handing back a row whose only affordance is a 403 is
  worse than handing back no row. Stated this way round so nobody later reads
  it as a data-protection claim it cannot support.

- **The all-denied refusal exists for two reasons and only one is UX.** It is
  honest — "you may not search here" beats an empty result set. It is also what
  makes the decision legible to the layer-2 reachability guard, which reads the
  AST of `if` conditions and cannot see authorization expressed as a filter.
  Per-domain skipping alone would have dropped both handlers from
  `ROLE_PRESENCE_ONLY` to `NONE` — a strictly worse classification. That is
  recorded rather than glossed, because a guard shaping code is worth knowing
  about; `assertAnyDomainViewable` carries a comment telling a future
  DRY-it-up refactor not to hide the `ctx.appPermissions` access behind
  `canViewDomain`, which would silently restore the old verdict.

- **`Task.description` removed from the search predicate — verified, not
  assumed.** The field is in the Epic B manifest, so a row written through the
  app's Prisma client stores `v1:…` AES-GCM ciphertext; an ILIKE for the
  plaintext cannot match. Proved by writing through the app client and reading
  the raw column (ciphertext, no plaintext token), reading back through the app
  client (plaintext round-trips), and re-adding the clause to confirm the
  search still returns nothing. The first attempt at that test seeded through
  the suite's bare `PrismaClient`, which has no middleware — the row landed as
  plaintext and the clause matched, which is exactly how a wrong "it's dead"
  claim would have looked if it had gone the other way.

  Caveat: a `Task.description` written by something that bypasses the
  middleware — raw SQL, a script on a bare client, or a row predating the
  field's entry in the manifest — is plaintext and WOULD have matched. That
  makes the clause worse than dead rather than better: it searched an
  arbitrary legacy subset while appearing to search all descriptions.

- **API keys are a real behaviour change, same class as 2026-08-23.**
  `scopesToPermissions` derives `appPermissions` from a key's scopes, so a key
  now gets only the domains it is scoped for. Two consequences worth stating:
  a key with no scope matching any searchable domain (e.g. `mcp:read` alone,
  which maps to an empty action list) is now refused outright; and `assets` has
  **no scope at all** in `SCOPE_ACTION_MAP`, so no key short of `*` can receive
  asset hits from search or asset nodes from the graph. The `mcp` read suite
  still passes because `search_controls` declares `resourceScope: { resource:
  'controls', action: 'read' }`. Re-scope affected keys.

- **What was deliberately NOT done.** The graph's route-level `ALLOWED_KINDS`
  still omits `policy` even though the usecase supports it; unrelated, and
  changing it would widen the payload rather than gate it. No structural guard
  was written asserting "no search predicate names an encrypted column" — it
  would validate the mechanism rather than the outcome, and the encryption
  manifest already carries the note beside the field list.
