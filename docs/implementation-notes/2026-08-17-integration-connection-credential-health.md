# 2026-08-17 — Integrations: credential health, and reporting failure as failure

**PR:** #1956 — fix(integrations): surface a revoked credential, and stop reporting failed syncs as successes

## Design

H1-3 as scoped was "mark the connection on terminal auth failure so the UI can
show it". Implementing it surfaced a larger defect underneath, and the marking
is close to useless without it.

### What was asked for

A background sync that hit a revoked credential recorded the failure on
`IntegrationExecution` and nowhere else. `IntegrationConnection` carries
`lastTestedAt` / `lastTestStatus`, but those belong to the operator-initiated
"Test connection" button and are never written by a background sync. So a
connection whose token was revoked months ago still presented as healthy, and
the only way to find out was to open the execution history of a job nobody
watches.

Two nullable columns — `authFailedAt`, `authFailureReason` — written by
`markAuthFailure` and, crucially, cleared by `clearAuthFailure` on every
successful sync.

**The clearing is the load-bearing half.** A "credential revoked" banner that
survives the admin fixing the credential is worse than no banner: it trains
people to ignore the one signal that means someone must act. So the clear runs
on every success, not only the success following a failure, and it is cheap
enough (`updateMany` predicated on `authFailedAt: { not: null }`) that there is
never a reason to make it conditional.

They are deliberately *separate columns* from `lastTest*`. Sharing one field
would let a passing manual test paper over a nightly sync that is still failing,
and vice versa.

### What was found underneath

`makeResult` in the executor registry hardcoded `success: true`. The five
integration executors — `identity-sync`, `hris-sync`, `aws-posture-collect`,
`azure-posture-collect`, `gcp-posture-collect` — call usecases that **catch**
their provider errors and return `status: 'ERROR'` in a result object rather
than throwing.

So a sync that failed completely was recorded by the queue as a success. Job
metrics clean, BullMQ failed-set empty, alerting silent. It also meant H1-2's
`noRetry` could never fire on these jobs, because they never throw.

```
usecase catches ──▶ { status: 'ERROR', noRetry } ──▶ job wrapper
                                                          │
                                          makeResult(..., outcome)
                                                          │
                        { success: status !== 'ERROR', noRetry } ──▶ worker
```

### `status !== 'ERROR'`, never `status === 'PASSED'`

The posture usecases report four statuses, and **`FAILED` means the compliance
check found a real gap** — a perfectly successful collection. Mapping success to
`status === 'PASSED'` would turn every tenant's genuine findings into retried
job failures: a worse bug than the one being fixed, and one that would look like
a monitoring problem rather than a logic error. Only `ERROR` means the job
itself broke.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/automation.prisma` + migration | Two nullable columns on `IntegrationConnection`. Additive, no backfill, no default. |
| `src/app-layer/integrations/connection-health.ts` | New. `markAuthFailure` (narrow: `IntegrationAuthError` only) + `clearAuthFailure`. |
| `src/app-layer/usecases/{identity-sync,hris-sync,aws-posture,cloud-posture}.ts` | Mark on auth failure, clear on success, carry `noRetry` on the result. |
| `src/app-layer/jobs/{identity-sync,hris-sync,aws-posture-collect,cloud-posture-collect}.ts` | Wrappers now return the usecase result whole. |
| `src/app-layer/jobs/executor-registry.ts` | `JobOutcome` + honest `success` mapping at the five call sites. |
| `src/app-layer/usecases/integrations.ts` | Selects the two columns so the UI can render them. |
| `src/app-layer/integrations/bounded-fetch.ts` | `safeUrl` exported — see below. |

## Decisions

- **A credential leak the encryption guard caught.** `IntegrationAuthError`
  carried the *full* request URL, and this change persists that message to the
  database and renders it in the UI. `bounded-fetch.ts` already had `safeUrl`
  precisely because "a full URL can carry a token in the query string" — but
  `http-resilience.ts` was not using it. The `encryption-manifest-coverage`
  guardrail flagged `authFailureReason` as sensitive-shaped, which is what
  surfaced it. Fixed by routing every error URL through `safeUrl`; the column is
  then justifiable as plaintext, and a test asserts no query string survives
  into any error message.

- **The job wrappers now return the usecase result whole.** They were
  field-by-field shims re-listing four properties, which is exactly why
  `errorMessage` and `noRetry` were dropped in transit. The classification
  existed and simply never arrived. Returning the whole result makes that class
  of drift impossible rather than merely fixed.

- **`markAuthFailure` no-ops on anything that is not an `IntegrationAuthError`.**
  Call sites pass whatever they caught without pre-classifying, and 404 /
  throttle / timeout / network faults leave the connection unmarked. Each of
  those would otherwise put a "credential revoked" banner in front of an admin
  whose credential is fine.

- **A truncated enumeration is `noRetry`.** It returns `ERROR` deliberately, to
  be loud. But the cap is deterministic: retrying re-enumerates the same
  too-large directory and truncates at the same point, so BullMQ's three
  attempts would mean three more full 5000-account enumerations for an identical
  outcome. Making the success mapping honest without this would have introduced
  a fresh amplification. Resuming past the cap is H3-2.

- **No new index.** Neither column is a foreign key, the existing
  `@@index([tenantId])` covers the per-tenant connection list, and a tenant's
  connections number in the handfuls.
