# 2026-08-17 — Integrations: 429 handling, and the queue amplification behind it

**PR:** #1955 — fix(integrations): handle 429 without letting the queue amplify it

## Design

There was no `429` or `Retry-After` handling anywhere in the integrations
layer, while Okta, Microsoft Graph and Google Workspace all throttle
aggressively and all send `Retry-After`.

The interesting part is not the missing handler. It is what the queue did with
the resulting failure. A 429 surfaced as a generic error, and `jobs/queue.ts`
defaults to `attempts: 3` with exponential 5 s backoff — so being throttled once
produced **three more full re-enumerations inside ~35 seconds**. The system
answered "slow down" with three times the load. That is how a soft throttle
becomes a hard block, and it is a property of the *queue* config, not of any
provider.

So the fix has two halves, and the second is the one that matters:

```
  provider ──▶ resilientFetch ──▶ boundedFetch ──▶ fetch
                    │
                    ├── 401/403 ─▶ IntegrationAuthError     ┐ terminal:
                    ├── 404     ─▶ IntegrationTerminalError ┘ no retry
                    ├── 429/5xx ─▶ absorb (Retry-After, else jittered backoff)
                    └── 429 with Retry-After > 60s ─▶ IntegrationRateLimitedError

  executor throw ──▶ executor-registry catch ──▶ shouldBypassQueueRetry(err)
                                                        │
                                       { success:false, noRetry:true }
                                                        │
                                  worker ──▶ BullMQ UnrecoverableError
```

**Half one — absorb short throttles.** `createResilientFetch` retries
429/502/503/504 up to 3 attempts, honouring `Retry-After` when the server sends
one and using *full-jitter* backoff when it does not. Jitter is not decoration:
the dispatchers fan out across tenants simultaneously, so lockstep retries
re-create the thundering herd the backoff exists to prevent.

**Half two — refuse to absorb long ones, and stop the queue re-running them.**
A `Retry-After` beyond `MAX_ABSORBED_RETRY_AFTER_MS` (60 s) is *not* waited out:
holding a worker idle for five minutes starves the fan-out exactly as
effectively as the hung socket H1-1 fixed. It throws
`IntegrationRateLimitedError`, and the executor registry converts that — plus
any terminal error — into `noRetry: true`, which the worker turns into BullMQ's
`UnrecoverableError`. The job still **fails and is still recorded**; only the
immediate re-run is suppressed, leaving the next scheduled tick to retry.

Without half two, half one just relocates the amplification one layer down.

`Retry-After` is parsed in **both** RFC 9110 forms — delta-seconds *and*
HTTP-date. Handling only the integer silently discards a server that told us
precisely when to return, falling back to the blind backoff this module exists
to avoid.

### The terminal split

`IntegrationAuthError extends IntegrationTerminalError`, and the split is
deliberate. "Do not retry" and "the credential is bad" are different claims, and
H1-3 will mark a connection as credential-revoked in the UI. A 404 — a group
someone deleted, a drive that moved — must stop the retry loop without accusing
a working credential. Lumping 404 in with 401/403 would produce exactly the
false alarm that teaches operators to ignore the banner.

`isAuthStatus` is therefore narrow (401/403 only), and H1-3 should key on the
**error class**, not on `kind`, so a later widening of the terminal set cannot
silently start blaming credentials.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/http-resilience.ts` | New. Classifier, `Retry-After` parser (both forms), `createResilientFetch`, `shouldBypassQueueRetry`. |
| `src/app-layer/jobs/executor-registry.ts` | The single funnel for every executor throw — sets `noRetry` there rather than in each job. |
| `src/app-layer/jobs/types.ts` | `noRetry?: boolean` on `JobRunResult`, documented with why the queue default is wrong for these two cases. |
| `scripts/worker.ts` | Converts `noRetry` into BullMQ `UnrecoverableError`. |
| `src/app-layer/integrations/base-client.ts` + 6 providers | Default swapped `boundedFetch` → `resilientFetch`. Injection points untouched. |
| `tests/unit/integrations-http-resilience.test.ts` | Behaviour, with `sleepImpl`/`rand` injected so backoff is asserted, not slept. |
| `tests/unit/executor-registry.test.ts` | The wiring: rate-limit and revoked-credential → `noRetry`; transient → still retryable. |
| `tests/guards/integrations-bounded-fetch-coverage.test.ts` | Extended: the next omission is `?? boundedFetch`, which passes the old rule. |

## Decisions

- **`noRetry` at the registry, not per job.** Every executor throw already
  funnels through one catch block. Putting the decision there covers every
  integration job including ones not yet written, instead of relying on each
  job author remembering. One seam, not N call sites.

- **60 s absorb budget.** Under it, waiting in-process is cheaper than a full
  re-dispatch. Over it, a held worker slot costs the whole fan-out. The number
  is a worker-occupancy judgement, not a protocol constant.

- **A throttled job FAILS rather than silently succeeding.** Suppressing the
  retry is not the same as pretending the sync worked — a silently-successful
  throttle would be a worse bug than the amplification, because a compliance
  sync that quietly skipped users understates gaps.

- **Providers keep `deps.fetchImpl` injection.** A test that passes its own
  fetch still bypasses all of this, which is what keeps the retry behaviour
  itself testable.

- **The bypass stays narrow.** Only terminal and rate-limit errors set
  `noRetry`. An ordinary network fault is precisely what the queue's retry is
  for; marking everything no-retry would trade an amplification bug for a
  durability one.

- **`enumerationFetch` (120 s, from H1-1) is still unwired.** Paginated
  enumerations currently take the 30 s default. Wiring it is a follow-up, not
  silently in scope here.
