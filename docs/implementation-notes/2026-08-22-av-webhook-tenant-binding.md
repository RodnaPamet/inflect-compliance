# 2026-08-22 — the AV webhook binds a tenant context (#2096)

**Commit:** `(this branch) fix(security): bind the AV webhook's writes to the file's tenant`

## Design

`av-webhook/route.ts` ran entirely unbound: no `runInTenantContext`, no
`runInTenantJobContext`, anywhere on the path. Its reads and writes were correct
because each filtered on `tenantId` explicitly — but that filter was the ONLY
thing scoping them. The RLS backstop every other tenant-scoped path gets was
absent, so a future query that forgot the filter had nothing underneath it.

#2081 made the gap visible by requiring `client` on the ledger functions, which
forced this route to write `client: prisma` in as many words. That surfaced the
gap; it did not close it. This closes it.

## The bootstrap, which is why one read stays unbound

Binding a statement to a tenant requires knowing the tenant. On this route,
**finding the row IS how the tenant is learned** — the scanner posts a `fileId`
or a `pathKey` and nothing else. No session, no slug, no JWT; the caller is a
machine authenticated by HMAC.

So the lookup stays on the module-level client, and that is now stated at the
call site rather than left as an accident. It is safe because neither predicate
is tenant-shaped: `id` is a primary key and `pathKey` is globally unique, so
each matches at most one row, and the row it matches is the one the scanner
scanned. Everything after it runs under `inTenant`.

The test asserts this deliberately, so a later change that "fixes" the unbound
lookup by binding it to something guessed from the payload fails.

## Per-statement, not one wrapper

Same shape as `av-rescan.ts`, for the same two reasons:

- `appendAuditEntry` takes `pg_advisory_xact_lock` in its OWN transaction.
  Nesting that inside an interactive one holds two pooled connections and a
  per-tenant lock for the duration (#123: read in one transaction, audit outside
  any, transition in a second).
- The ledger call is split — `buildFileExposureReport` bound,
  `recordFileExposureReport` outside — exactly as #2081 did for the sweep.

## Files

| file | role |
|---|---|
| `src/app/api/storage/av-webhook/route.ts` | the binding, the bootstrap exception, the split |
| `tests/unit/av-webhook-quarantine-atomicity.test.ts` | scope-depth assertions + the source label |
| `tests/unit/av-scan-terminal-verdict.test.ts` | binding mock so its assertions still observe the same statement |

## Decisions

- **The test measures scope DEPTH, not call order.** `tx:start` minus `tx:end`
  before each operation: `> 0` at the claim, `0` at the audit write. Relative
  index would pass against the naive "wrap the whole handler" threading, which
  is precisely the regression. Mutation-proved both ways — nesting the audit
  fails one test, un-binding the claim fails two.

- **The source label is pinned where it is chosen.** `'av-webhook'`, never
  `'job'` / `'system'` / `'seed'` — those are in `KEK_BYPASS_SOURCES`, which
  turns the per-tenant DEK off. `runInTenantJobContext` refuses them outright,
  so the failure would be loud rather than silent corruption, but the label is
  a choice and the test asserts the choice.

- **`fileRecord` is captured into a const.** It is a `let`, so the null-narrowing
  from the not-found guard does not survive into the closures. Without the
  capture this does not compile — worth noting because the fix looks cosmetic.

- **The two sibling test suites needed opposite treatments.** The atomicity
  suite gained a tracing mock, because WHERE each statement runs is now part of
  what it asserts. The terminal-verdict suite gained a pass-through mock
  returning the same delegates, because its subject is the conditional claim's
  semantics and binding is beside the point there.
