# 2026-08-22 — avatar serve route: shared-tenant audience gate (#2104)

## Design

`GET /api/account/avatar/[userId]` authenticated and stopped there. It took
`userId` from the path and handed it straight to `getAvatarStream`, and the path
sits outside `/api/t/`, so the middleware tenant gate never applied either. Any
signed-in account — any tenant, any role, including one with **zero** tenant
memberships — could stream any user's avatar. The image itself is low value; the
`200`-versus-`notFound` split is the sharper primitive, because it answers "is
this person a user of this platform" for anyone who can guess an id.

Self-only was not available as an answer: `avatarServeUrl(userId)` is what
`User.image` points at, and member lists, people-pickers and the chrome all
render other users' avatars through it.

The audience is now **users who share a tenant with the subject**, decided by one
function:

```
canViewAvatar(viewerUserId, subjectUserId)
  viewer === subject                      → true, no round trip
  otherwise: does the SUBJECT hold an ACTIVE membership in a live tenant
             where the VIEWER also holds an ACTIVE one?
```

`ACTIVE` on both sides, live tenant only — the same predicate
`applyMembershipClaims` in `src/auth.ts` uses to decide which tenants a session
may enter (`{ status: 'ACTIVE', tenant: { deletedAt: null } }`). INVITED is not
yet a colleague; DEACTIVATED and REMOVED no longer are; a soft-deleted tenant
confers nothing because nobody can enter it.

**One round trip, at most one row.** The subject's ACTIVE memberships drive the
scan and the viewer's side is a correlated `EXISTS` over the same table, so
neither membership set is materialised in the app and nothing loops per tenant:

```sql
SELECT id FROM "TenantMembership" m
WHERE m."userId" = $subject AND m.status = 'ACTIVE'
  AND EXISTS (SELECT 1 FROM "Tenant" t
               WHERE t.id = m."tenantId" AND t."deletedAt" IS NULL
                 AND EXISTS (SELECT 1 FROM "TenantMembership" v
                              WHERE v."tenantId" = t.id
                                AND v."userId" = $viewer
                                AND v.status = 'ACTIVE'))
LIMIT 1;
```

That predicate is `userId`-first, and no `userId`-leading index existed:
`TenantMembership_tenantId_userId_key` has `userId` as its *second* column, which
answers "who is in tenant T" and not "which tenants is user U in". So the query
would have seq-scanned every membership row in the deployment, on a route that
runs the query **on every request**.

Not once per cache window — that was the first version of this paragraph and it
was wrong. The route sets `Cache-Control: private, max-age=300`, but
`deploy/caddy/Caddyfile:51-52` matches `@dynamic` and REPLACES the header with
`no-store` for every `/api/*` response. In the deployed topology nothing caches
this, so there is no window to amortise the query over. The index is load-bearing
rather than a nicety, and the per-request cost is real: this route is outside
`/api/t/**`, so neither rate-limit tier applies to it.

The migration adds `TenantMembership_userId_status_idx`, with `IF NOT EXISTS`
so that an operator who pre-creates it on production does not wedge the deploy
with a 42P07.

## Files

| File | Role |
| --- | --- |
| `src/lib/account/avatar.ts` | New `canViewAvatar` — the whole authorization rule, one query, self short-circuited |
| `src/app/api/account/avatar/[userId]/route.ts` | Calls the gate before storage; both refusal branches throw the same `AVATAR_NOT_FOUND` constant; docblock + `Cache-Control` comment corrected |
| `prisma/schema/auth.prisma` | `@@index([userId, status])` on `TenantMembership` |
| `prisma/migrations/20260822120000_tenant_membership_user_status_index/` | `CREATE INDEX` for it |
| `tests/unit/account-avatar-serve-authz.test.ts` | Route behaviour against a fixture membership table |
| `tests/unit/account-avatar.test.ts` | `canViewAvatar` unit coverage — the exact `where`, the self short-circuit |
| `tests/guardrails/api-permission-coverage.test.ts` | Its recorded reason for this route said "any authenticated user may GET any userId's avatar"; now false |
| `tests/guards/evidence-download-authz.test.ts` | Same — its accepted-risk entry said "any session user can fetch any userId by design" |

## Decisions

- **404, never 403, on refusal.** A 403 confirms the account exists and reopens
  the exact oracle the gate closes. Both branches throw one shared
  `AVATAR_NOT_FOUND` constant so the bodies are byte-identical, not merely
  same-status; a test compares status, every header and the body of a refused
  read against a genuinely-absent one, and it fails if either branch gets its own
  wording. `<InitialsAvatar>` reads both through `onError`, so the UI cannot tell
  them apart either.

- **Authorize before probing storage.** Otherwise a refusal costs a `head`
  against a key the caller may not read, and the difference between "no such
  object" and "not your colleague" becomes a timing signal. The ordering is
  proven by asserting the storage spy is untouched on a refusal for a subject who
  *does* have a stored object — with the allowed case as the companion, so the
  assertion is about order rather than about a probe that never happens.

- **Asked of the database, not of the JWT.** `session.user.memberships` would
  have made the viewer side free and let the query use the existing
  `(tenantId, userId)` unique index with no migration. Rejected: those claims are
  capped at `MAX_JWT_MEMBERSHIPS` (50) and `membershipsTruncated` is not copied
  onto the session, so a user past the cap would get silent 404s for colleagues
  in the truncated tail — a wrong answer with no signal. The index is the honest
  fix for the cost.

- **The index is part of the fix, not scope creep.** Putting a new hot query on
  an unindexed column and leaving the index for later is the actual mistake.
  It is additive and several existing callers were already paying the scan
  (`getDefaultTenantForUser`, the security-events reader, the SCIM membership
  lookups, the evidence owner lookup). Rollback:
  `DROP INDEX "TenantMembership_userId_status_idx";` — the route stays correct
  without it, only slower.

- **Prisma is faked, not stubbed, in the route test.** The fixture is a real
  membership table and the fake evaluates the route's actual `where` against it,
  so a widened predicate fails there. It throws on a `where` shape it does not
  recognise rather than returning `null`, because a silently-null fake would turn
  every "denied" assertion green while the real gate did nothing.

- **ACTIVE on the SUBJECT side too, and it has a visible cost.**
  `listTenantMembers` deliberately returns `ACTIVE | INVITED | DEACTIVATED`
  rows, so `/admin/members` shows people whose subject-side membership now
  fails the gate: an invited-but-not-accepted user, or a deactivated
  ex-employee, renders as initials instead of their uploaded photo. Kept
  anyway. The viewer side being ACTIVE is the half that matters (a
  deactivated account must not keep reading its ex-colleagues), and
  loosening only the subject side would mean inventing a second, weaker
  membership predicate for one page. The degradation is graceful —
  `<InitialsAvatar>` already falls back on any load failure. If the
  members page is judged to need the photos, the change is one clause on
  the subject side, made deliberately rather than by drift.

- **Not `requirePermission`.** The route resolves no tenant from its path, so
  there is no tenant role for a permission key to be checked against. "Any tenant
  we both belong to" is a membership question, not a role one.

- **What this does not close.** An authorized read still costs a storage probe
  and a refusal does not, so a coarse timing difference remains between "not your
  colleague" and "your colleague, no avatar". Both are 404s carrying no content,
  and equalising them would mean probing storage for callers who may not read it
  — a worse trade. Recorded here rather than left implied.
