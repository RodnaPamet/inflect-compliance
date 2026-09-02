# 2026-09-02 — app-wide 401 seam for client-side pollers (#2222)

**Commit:** `<sha> fix(auth): stop client pollers once the session is terminally gone`

## Design

The class: a client-side poller keeps requesting an authenticated endpoint
after the session cookie expires, forever, with nothing surfaced. The
notifications bell was the visible member (#2221) — it threw, so the console
filled with `GET /api/notifications 401`. The rest of the class is worse
because it is quieter.

**The defect is a too-COARSE predicate, not absent handling.** The three
process-canvas hooks each throw on `!res.ok` in their fetcher and then discard
it with `if (isRevalidation) return;`, under a written rationale that is
CORRECT — for a 503. Blanking a compliance canvas's status chips over one blip
is worse than leaving them. The same line is wrong for a 401, which never
recovers: the poll re-fires every 30 s indefinitely while the canvas renders
`Control.status` chips from whenever the session was last alive, and a stale
chip is not distinguishable from a live one. One branch, two failure classes
needing opposite treatment.

That is also the argument for a shared signal over three local patches: only
something global can tell the two apart.

```
              ┌──────────────── writers (disjoint halves) ────────────────┐
 apiGet/Post/…│ api-client.ts::handleErrorResponse → noteUnauthorized()   │
 useSWR(any)  │ providers.tsx  <SWRConfig onError>  → noteUnauthorized()  │
 raw fetch    │ 3 canvas hooks + bulk-import modal  → noteUnauthorized()  │
 bell         │ notifications-bell.tsx (401 arm)    → noteUnauthorized()  │
              └───────────────────────┬──────────────────────────────────┘
                                      ▼
                        src/lib/auth/session-expiry.ts
                        module-scope flag, one-way, 401-only
                                      │
              ┌───────────────────────┴──────────────── readers ──────────┐
              │ providers.tsx <SWRConfig isPaused> — every SWR hook stops │
              │ 3 canvas hooks — pulled at the top of each interval tick  │
              │ EvidenceBulkImportModal — picks its message               │
              │ <SessionExpiredNotice> — ONE banner, link to /login       │
              └───────────────────────────────────────────────────────────┘
```

Module scope, not React state, for the reason `notifications-bell.tsx`
documents: an already-scheduled interval callback closes over its bindings and
never sees a `setState`. Pollers PULL; components read via
`useSyncExternalStore`.

**Two writers because they cover disjoint halves.** 173 client files call raw
`fetch` and 9 import `@/lib/api-client`. An `api-client` 401 branch alone fixes
none of the four defective sites (all raw `fetch`); an `SWRConfig onError`
alone fixes one of four.

**401 only, never 403.** For a browser request 401 has exactly one producer —
`middleware.ts` where `getToken()` returned null. 403 has three and none is a
session problem; a `requirePermission` denial must not sign anyone out. The
bell deliberately treats BOTH as terminal *for itself* and is correct to:
`/api/notifications` is flat (`isTenantPath` matches only `/t/` and `/api/t/`)
and carries no `requirePermission`, so its only reachable 403 is a
DEACTIVATED/REMOVED membership. That is a property of that route's shape, so
the bell keeps both arms terminal locally and marks the shared store on 401.

**Offer `/login`, do not redirect.** `use-calendar-badge` mounts in
`SidebarNav` on every page and refreshes every 5 minutes, so an automatic
redirect fired by a background poll is data loss for a user mid-upload.

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/session-expiry.ts` | new — the store + `noteUnauthorized` predicate (401-only, `/api/` excluding `/api/auth/`) |
| `src/components/layout/session-expired-notice.tsx` | new — the single banner, `useSyncExternalStore`, link to `/login` |
| `src/app/providers.tsx` | `<SWRConfig>` with `onError` (write) + `isPaused` (read), and the notice mount |
| `src/lib/api-client.ts` | 401 branch in `handleErrorResponse`, covering the non-SWR verbs |
| `src/lib/processes/use-tenant-{controls,risks,assets}.ts` | mark on 401 in the fetcher; pull the flag at the top of each tick and clear the interval |
| `src/app/t/[tenantSlug]/(app)/processes/MonitorTab.tsx` | migrated to `useTenantSWR`; `error` is now read |
| `src/app/t/[tenantSlug]/(app)/evidence/EvidenceBulkImportModal.tsx` | session-aware failure message; the pending retry timer is now cleared on close |
| `src/components/layout/notifications-bell.tsx` | marks the shared store on 401 |

## Decisions

- **The three canvas hooks were NOT migrated to `useTenantSWR`.** The issue
  proposed it, and the second win it names (collapsing ~38 requests / 30 s) is
  real, but the migration is a different change from this one and carries the
  larger blast radius: `useTenantSWR` reads the slug from `TenantContext` while
  these hooks take it as a parameter with a documented empty-string no-op
  (`ProcessInspector.tsx:522` passes `tenantSlug ?? ""`), and
  `tests/guards/p-polish-d.test.ts` — hardened days earlier in #2238/#2244 —
  binds its "a background failure preserves last-good state" assertion to the
  literal `setInterval(… runFetch(true) …)` call. Deleting that shape means
  rewriting that guard plus ~770 lines of interval-based tests in the same diff
  as a security fix. The *stated reason* for step 3 — moving the defective
  sites under the seam — is satisfied here directly: the hooks write to the
  store and read it. The request-collapsing win remains open.
- **`isPaused` at the root is the strongest reader.** It is checked at the top
  of SWR's `revalidate` and again before `onError`, so one line stops every SWR
  hook in the app from issuing requests. The timers keep re-arming (SWR's
  polling `execute()` calls `next()` regardless) but no network happens.
- **`onError`, not `onErrorRetry`.** `onErrorRetry` is skipped entirely when
  `shouldRetryOnError` is false, so a config that disables retries would also
  silently disable the seam.
- **The flag is never cleared by a later 200.** A success from a public route
  must not un-expire a session. It clears on reload — i.e. after re-auth.
- **An unrecognised URL marks nothing.** The cost of a false positive is
  telling a signed-in user they are signed out, so `noteUnauthorized` fails
  towards doing nothing when it cannot see an `/api/` path.
- **Nothing was added to `withApiErrorHandling`.** `app-layer/context.ts` and
  `lib/mcp/auth.ts` raise 401 for a rejected API KEY on server-to-server calls.
