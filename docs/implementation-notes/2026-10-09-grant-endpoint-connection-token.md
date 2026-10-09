# 2026-10-09 — The grant endpoint's caller, and why the first design could not call it

**Commit:** see the PR for #3323 — `fix(entra): authenticate the grant endpoint by connection token`

## What was wrong

`2026-10-09-grant-mcp-endpoint.md` records the design shipped in #3321. That note
stands as the record of a decision; it is **not** a description of shipped
behaviour, and three of its decisions are now false:

| that note says | why it could not work |
| --- | --- |
| `POST /api/t/:tenantSlug/admin/mcp/entra-grant` | the edge admits a cookie or an `iflk_` Bearer on `/api/t/**`; our dispatch has neither |
| gated on `admin.tenant_lifecycle` | **no bearer token reaches that permission, by design** |
| authenticated by an `iflk_` key | the key resolves to at most ADMIN, which denies the gate explicitly |

The second row is the whole defect, and `scopesToPermissions` had already written
it down in as many words: `tenant_lifecycle` and `owner_management` are *"actions
that need a real session and that no bearer token, however scoped, performs."*
Even a `*` key resolves through `getPermissionsForRole('ADMIN')`, and the ADMIN
branch returns `tenant_lifecycle: false` as a literal.

So the endpoint was callable by a human in a browser and by nothing else — the
exact inverse of its purpose. It was green: every test mocked the gate.

## The repair that was rejected

Lowering the gate to a permission an API key CAN hold — `admin.manage` — is the
one-line fix and it is wrong. That key is held by every `*` API key in the
tenant, and OWNER-only authority over a directory write is the property this
whole path was chosen for. Weakening the gate to fit the credential is fitting
the lock to the key.

## What replaced it

A per-connection token that does not enter the permission system at all:

```
Authorization: Bearer <connectionId>.<secret>
```

**The connection identifies the tenant.** That is what the previous design's
tenant-in-the-path was protecting, and it survives intact — strengthened, in
fact: the tenant is now *authenticated* rather than *asserted*, because it comes
from a row found by a secret only we hold instead of from a path segment the
caller supplies.

Blast radius is narrower than the key design, not wider. A leaked token reaches
exactly one connection in one tenant, grants nothing anywhere else, and is not a
credential any human flow can present.

The route moves to `/api/mcp/entra-grant` — off `/api/t/**` entirely, because
that prefix's edge contract is precisely what it cannot satisfy. The old path is
**deleted**, not left as an alias: a second door to a directory write is a second
thing to get wrong.

## Files

| file | role |
| --- | --- |
| `src/app-layer/usecases/entra-grant-auth.ts` | the boundary: parse, look up, compare in constant time, classify the refusal |
| `src/app/api/mcp/entra-grant/route.ts` | the endpoint, authenticating before it parses a body |
| `src/app/api/t/[tenantSlug]/admin/mcp/entra-grant/route.ts` | **deleted** |
| `src/lib/security/route-permissions.ts` | the `tenant_lifecycle` rule, removed |
| `tests/guardrails/api-route-has-some-authorization.test.ts` | declares the route `PROTOCOL_CREDENTIAL`, mechanism `authenticateGrantCaller` |
| `tests/unit/no-direct-prisma.test.ts` | allowlists the global read, with the reason below |

## Decisions

- **`attributable` is a field on the refusal, not a comment.** `requirePermission`
  writes a hash-chained `AUTHZ_DENIED` row on denial for free; this does not, and
  dropping it was not acceptable — a refused grant attempt is exactly what an
  operator wants in the trail. But four of the seven refusals *cannot* be audited
  honestly: a malformed token or an unknown connection id identifies no tenant,
  and `AuditLog` is tenant-scoped, so there is no trail to write to and inventing
  one means guessing whose it is. The discriminator makes that asymmetry a
  compile-time fact the route must branch on rather than a paragraph nobody reads.

- **Global Prisma, allowlisted, because the tenant is this function's OUTPUT.**
  Same shape as `redeemOrgInvite`, which is allowlisted because it operates
  pre-membership. A lookup whose entire job is to establish which tenant the
  caller belongs to cannot be scoped to a tenant it does not yet know. The read
  is by primary key and selects six columns: it cannot enumerate and a caller
  cannot widen it.

- **`parseToken` splits on `indexOf('.')`, not `split('.')`.** The id is the first
  field; the secret is *everything after the first dot*, not the second field. A
  secret containing a dot must not silently become a shorter secret — which is
  what `split('.')[1]` does, and the mutation proving this reddens two tests.

- **`constantTimeMatch` is copied from `verifyPlatformApiKey`, not imported.**
  That helper is private to platform-admin auth. Widening a private helper's
  surface for its second caller is how a helper becomes a shared dependency
  nobody owns; eleven lines are cheaper than the coupling. The length-mismatch
  case is folded into the comparison by corrupting a byte rather than returning
  early, because an early return is a length oracle.

- **One assertion in the test file is a presence check, and says so.** A plain
  `===` passes every behavioural test here: timing is not observable in a unit
  test, and this repo has already deleted a wall-clock budget whose verdict on the
  regression it named was a coin flip across eight samples. So the mechanism is
  asserted structurally — `timingSafeEqual` present, the length branch corrupting
  rather than returning. The mutation run is what shows it earns its place: of six
  mutations, `timingSafeEqual` → `===` is caught by that assertion and by nothing
  else.
