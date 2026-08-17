# 2026-08-17 — Resuming a directory larger than the cap

**PR:** #1960 — feat(identity-sync): resume enumeration past MAX_USERS

## Design

A directory over `MAX_USERS` (5000) could never finish. Every run started at
page one and stopped in exactly the same place, so accounts past the cap were
**never synced** and the deprovision reconcile was skipped forever. The
providers already computed a continuation at the truncation point — Okta's
`link` rel=next, Google's `nextPageToken`, Entra's `@odata.nextLink` — and threw
it away.

```
run 1 ─ pages 1..N   ─▶ cursor stored  ─▶ status PARTIAL
run 2 ─ pages N+1..M ─▶ cursor stored  ─▶ status PARTIAL
run 3 ─ pages M+1..end ─▶ complete
                          │
                          ├─ reconcile: syncedAt < passStartedAt → DEPROVISIONED
                          └─ cursor + passStartedAt cleared
```

### The reconcile is the dangerous part

The old predicate was `externalUserId: { notIn: seen }`, where `seen` is what
**this run** observed. That was correct only while a pass was a single run.

Under resume, `seen` holds just the last slice of the directory — so keeping
that predicate would have deprovisioned **every account from every earlier run
of the same pass**. That is precisely the wrongful-mass-deprovision failure this
area exists to prevent, and it would have been introduced *by* the resume
feature.

The fix is a pass timestamp. `syncPassStartedAt` marks when the current
multi-run pass began; every upsert stamps `syncedAt = now`; on completion the
reconcile deprovisions accounts whose `syncedAt < passStartedAt`. "Seen"
accumulates across the whole pass instead of resetting each run.

### A partial run is a success, not a failure

Previously a truncated enumeration reported `ERROR`. For a resumable provider
that is now wrong: storing a cursor and stopping is the job working as designed,
and reporting `ERROR` would page someone every night for a large directory
behaving correctly. Partial runs report `PARTIAL`, which the executor registry
maps to a job success under the existing `status !== 'ERROR'` rule.

Non-resumable providers keep the old loud behaviour.

## Files

| File | Role |
| --- | --- |
| `providers/identity/types.ts` | `resumeToken` on the result; `resumeFrom` on `listAccounts`. |
| `providers/{okta,google-workspace,entra-id}/index.ts` | Return and accept the continuation. |
| `prisma/schema/automation.prisma` + migration | `syncCursor`, `syncPassStartedAt`. |
| `usecases/identity-sync.ts` | Pass lifecycle; reconcile by pass timestamp. |
| `jobs/executor-registry.ts` | `PARTIAL` added to `JobOutcome`. |

## Decisions

- **Active Directory cannot resume, and says so.** ldapjs paged search uses a
  server-side cookie tied to the live LDAP connection, so it cannot survive a
  process boundary. AD returns `resumeToken: null` and keeps the loud
  `ERROR` + `noRetry` path. Pretending otherwise would store a null cursor and
  report success for a sync that truncates identically forever — the failure
  mode being fixed, wearing the fix's clothes.

- **Absolute resume URLs are origin-checked.** Okta's and Graph's continuations
  are absolute URLs, and this change persists them to the database. Resuming
  from whatever is in that column means anyone who can write it could point the
  next enumeration at a host of their choosing — and that request carries the
  tenant's API token. One `startsWith` per provider, with a test, because it
  reads like a redundant check on our own data and is not: it stopped being our
  data the moment it went to the database and back. Google needs no such check
  (opaque token, appended to our own base URL), and a test asserts that
  asymmetry is deliberate.

- **A resumed Entra URL already carries its `$select`.** The `signInActivity`
  fallback rebuilds the URL from scratch on the first page, which would discard
  the resume position. `first` is initialised to `!resuming` so the fallback
  does not fire on a resumed run.

- **The cursor is cleared on completion.** Otherwise the next pass would resume
  from the end of the previous one and enumerate nothing, forever — a sync that
  reports success while seeing no accounts.
