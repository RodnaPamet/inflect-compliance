# 2026-10-09 — The grant MCP endpoint

**Commit:** see the PR for #3297 — `feat(entra): the grant MCP endpoint — two tools, and our own dispatch is the only client`

## Design

`POST /api/t/:tenantSlug/admin/mcp/entra-grant` — an MCP server advertising
exactly two tools: `grant_time_bounded_access` and `read_access_assignments`,
both backed by the client that landed in #3308.

```
agent ──▶ /api/mcp (agent-facing)
             │  external-tools.ts offers the grant ONLY if:
             │    granted to this agent · pin on file · live definition
             │    matches the pin · connection enabled
             ▼
          PENDING journal row ──▶ approval ──▶ external-write-dispatch
                                                 │ rung · row's rung · pairing
                                                 │ · population re-resolved
                                                 ▼
                                   THIS ENDPOINT (over HTTPS, iflk_ key)
                                                 ▼
                                      Graph entitlementManagement
```

## The near miss, which is the reason this note exists

The obvious home for a grant tool was `src/lib/mcp/tools/` — the directory whose
name matches the sentence "our own MCP server with a grant tool". That would have
been wrong in a way review would not catch.

`src/lib/mcp/` is the **agent-facing** server. An agent authenticated there calls
`tools/call` and the tool executes. Every rail the owner chose this path for —
template and bounds approval, population re-resolved at send, the `PENDING`
journal row, the prior-state pairing — lives on the **outbound** path in
`external-write-dispatch`. A grant tool on the agent-facing server is therefore a
grant tool with the rails stripped off, arrived at by putting the code where the
name fits.

Same shape as the peer's observation about `IdentityDirection`: placement by
plausible name is how a thing ends up reachable by a principal nobody intended.

## Decisions

- **The tenant is in the PATH, not in the tool arguments.** This is the
  load-bearing half of the auth. A tenant arriving as an argument is
  caller-asserted; a tenant in the path is *authenticated*, because `getTenantCtx`
  resolves it from the credential and refuses a key whose tenant is not the slug
  in the URL (#2224). The rejected alternative — one deployment secret plus a
  tenant argument — proves "it is us" and says nothing about "for this tenant",
  and a leak of it would reach every tenant's grant path at once.

- **`iflk_` API key, reusing the documented edge fall-through.** `/api/t/**` with
  an `iflk_` Bearer already falls through at the edge and resolves through
  `tryApiKeyAuth`. The rejected alternative was a per-connection opaque token
  compared with `timingSafeEqual` — narrower blast radius, but a new
  bearer-versus-connection-secret path with no precedent in this repo, against
  reusing one that is documented and tested. Owner decision 2026-10-09.

- **`admin/` is not decoration.** `api-permission-coverage`'s `PRIVILEGED_ROOTS`
  includes `src/app/api/t/[tenantSlug]/admin`, so a route placed there is in the
  guarded population automatically and a literal `requirePermission` is
  **enforced rather than remembered**. Only a literal counts there, and
  deliberately: a `requirePermission` denial writes a hash-chained `AUTHZ_DENIED`
  row where an `assertCanAdmin` denial writes nothing.

- **`admin.tenant_lifecycle`, so OWNER-only.** The same key the rung and
  `external-prior-state-read` take, on their reasoning: *"deciding what gets
  called against a customer's system immediately before it is changed is
  authority of that class."* Assigning access in a customer's directory is not a
  lesser act than nominating the read that runs before it. ADMIN holds every
  other admin flag and explicitly not this one.

- **Both tools declare `readOnlyHint` explicitly.** The grant would classify
  correctly by saying nothing, since `declaresWrite` treats an absent annotation
  as a write. It says `false` anyway, because the read *must* say `true` —
  `setPriorStateRead` refuses a prior-state read that is not declared read-only —
  and a pair where one side is explicit and the other relies on a default invites
  someone to tidy the explicit one away.

- **No resources, stated rather than omitted.** `McpHandlers` requires
  `listResources`/`readResource`, which turned out to be the right shape:
  `dispatchMcp`'s `initialize` answers `capabilities: { tools: {}, resources: {} }`
  unconditionally, so this endpoint advertises a resources capability whether or
  not it has one. Omitting them was a type error; defaulting them to the
  agent-facing server's would have been far worse, since `listMcpResources`
  reaches this tenant's compliance data and has nothing to do with a grant. So:
  an empty list, and a read that refuses naming the endpoint rather than the uri.

- **The catalogue is UNFILTERED, unlike `/api/mcp`'s.** The agent-grant and
  manifest-pin filters belong to the agent-facing server. The only caller here is
  our own dispatch, which resolved what it may send before opening a socket. A
  second catalogue filter would be a weaker copy of a gate that already ran.

- **Four refusals, not a null.** `no_connection` / `ambiguous` /
  `secret_unavailable` / `incomplete_config` are fixed by four different actions,
  and a null collapses them into "it did not work" — the shape
  `resolveTargetPopulation`'s header rejects for its own five outcomes. The one
  that matters is `ambiguous`: two enabled Entra connections is a question about
  *which directory* a grant writes to, and the resolver refuses rather than
  taking the first row. The read is `take: 2` for exactly that reason — one row
  cannot distinguish "the only connection" from "the first of several".

- **The missing-field check is ours, not Microsoft's.** An empty `clientSecret`
  makes Entra answer `401 invalid_client`, which `resilientFetch` converts into an
  auth error and marks the connection credential-failed — recording our own
  malformed request as "your credentials are revoked". So the field is checked
  here, by name, before any request.

- **A refused expiry costs no database read and no key material.** The expiry
  refusal runs in the usecase *before* the connection is resolved, duplicating
  the client's own check. Deliberate duplication: this is the layer that can
  refuse without touching Prisma or `decryptField`, and the client's copy stays
  because it protects a direct caller.

- **This usecase is NOT a second authority gate.** It resolves and refuses on
  *configuration*, never on authority. The consent for this path is the
  `externalWriteMode` rung, checked by the dispatch before a tool is reached. A
  second, weaker authority check inside a usecase is how a route ends up looking
  protected while granting more than it said.

- **And it does not take the JML write-direction gate.** Reusing `writesEnabled`
  would be worse than wrong: that flag's copy reads *"Let leaver offboarding
  DISABLE accounts in this directory"*, so treating it as consent to assign
  entitlements grants an authority the checkbox never described — the accidental
  consent `write-direction.ts` exists to prevent, arriving through another door.

## Files

| file | role |
|---|---|
| `src/app/api/t/[tenantSlug]/admin/mcp/entra-grant/route.ts` | the endpoint: two tool descriptors, `dispatchMcp`, batch/notification handling |
| `src/app-layer/usecases/entra-grant-dispatch.ts` | connection resolution, the four refusals, the two tool-backing functions |
| `src/lib/security/route-permissions.ts` | the rule binding the path to `admin.tenant_lifecycle` |
| `tests/unit/entra-grant-mcp-endpoint.test.ts` | authz, the catalogue, in-band refusals, batch/notification shapes |
| `tests/unit/entra-grant-dispatch.test.ts` | the four refusals, their distinct sentences, and the zero-read proof |

## What this does NOT do

- **No pairing is registered** (#3300). Both halves now exist as advertised tools
  on one connection, which is what `setPriorStateRead` requires — but registering
  it needs the connection row, which needs the endpoint deployed and an API key
  minted. That is configuration, not code.
- **No operator surface** (#3301), still the largest remaining piece.
- **The app-only permission is unconfirmed against a real tenant** (#3311). The
  Graph reference's permissions table and its surrounding prose do not read
  consistently on application support for `assignmentRequests`, and this epic has
  already been wrong once from reading a Microsoft table too confidently. Step 4
  of that issue — confirming Entra actually *ends* the assignment at the stated
  time rather than merely recording it — is the one that cannot be inferred,
  because the whole no-revocation-scheduler decision rests on it.
