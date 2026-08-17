# 2026-08-17 — H3-3: a blocking stress suite for integrations

**PR:** #TBD — test(stress): integrations stress suite

## Design

Seven roadmap items hardened the integrations subsystem. H3-3 asks whether any of
it still works tomorrow. The existing `tests/load/` suite could not answer that:
it is k6 over HTTP and touches no integration endpoint, and more importantly k6
cannot reach the properties in question — a deadline on a hung socket, a throttle
absorbed vs deferred, a lease reaped, a resumed pass that must not deprovision its
own earlier runs.

### The transport decision, and the trap in it

Every provider takes an injectable `deps.fetchImpl`, which makes a fake fetch the
obvious choice and the wrong one: `http-resilience` resolves
`opts.fetchImpl ?? boundedFetch`, so a bare fake **replaces both hardened
layers**. The bounded-fetch guard states this explicitly. A suite built that way
reports green about behaviour it never ran, which is worse than no suite.

So the harness injects a *composed real stack* — `createResilientFetch` over
`createBoundedFetch` — against a real `node:http` server. Only the singletons'
production constants are swapped for short ones.

The decisive argument is **timers, not sockets**. Every DB-backed scenario runs
inside Prisma's interactive transaction, whose 5 s expiry is server-side wall
clock and cannot be moved by `jest.advanceTimersByTimeAsync`. Measured: a 9 s hang
expires the transaction and persists nothing. Fake timers were never available,
which removes the stub's only advantage — and a socket additionally proves the
abort *releases* the connection.

Okta is the only provider with a config-driven base URL, so it is the only one
reachable at `127.0.0.1`. Sufficient: the hardening lives in the two shared
modules, not per provider.

### Blocking, with counts rather than timings

24 of 25 assertions are integer counts or row states. The suite is blocking, and a
flaky blocking check gets disabled — worse than not having one. The repo's own
history is the evidence: `encryption-middleware.perf.test.ts` flaked at 200 %,
500 % and 1000 % margins before settling at 5000 %. A threshold that loose cannot
see a 2× regression anyway, so timing numbers are recorded and uploaded, never
asserted.

## Files

| File | Role |
| --- | --- |
| `tests/stress/helpers/stress-env.ts` | `shortStack` (composed real stack), the DB-identity assertion, teardown, `recordTrend`. |
| `tests/stress/helpers/fake-okta-server.ts` | Real `node:http` Okta that hangs / throttles / 401s / 404s / paginates, with disconnect + in-flight counters. |
| `tests/stress/integration-http-hardening.stress.test.ts` | Deadline, attempt cap, socket release, absorb vs defer, auth marking. |
| `tests/stress/identity-sync-resume-reconcile.stress.test.ts` | Multi-run pass; the `lt`/`lte` reconcile boundary. |
| `tests/stress/integration-sync-lock-contention.stress.test.ts` | Single winner, reaper, reaped-holder release, job-layer skip. |
| `tests/stress/integration-dispatch-fanout.stress.test.ts` | One id per connection per bucket, rollover, failure isolation. |
| `.github/workflows/integration-stress.yml` | Nightly + `push: [main]`, no `continue-on-error`. |
| `jest.config.js` | `JEST_STRESS=1` opt-in. |

## Decisions

- **Worker-pool starvation is out of scope, and the README says why.** No test
  here runs a real BullMQ `Worker` — v5's Lua scripts are incompatible with
  in-process Redis mocks, and `scripts/worker.ts`'s processor is not exported. A
  width-5 semaphore in the harness would assert the harness's own semaphore and
  stay green if production concurrency became 50. Asserted instead: every
  outbound call terminates, and a doomed job does not re-run — the two properties
  starvation reduces to.

- **`push: [main]` is what makes it a gate.** A workflow with no `pull_request`
  trigger produces no PR check context and can never literally be "required". The
  push trigger turns a regression into a red main, the same strength `load-smoke`
  has. The absence of `continue-on-error` is the entire delta from
  `load-test.yml`.

- **The lock tier drives the JOB, not the usecase.** `acquireSyncLock` lives in
  `jobs/identity-sync.ts`; a harness written against `runIdentitySync` bypasses
  the lease and passes while proving nothing.

- **`enrichPerUser` must be forced off, and that is a product finding.** Its
  default is `'true'`, and those per-user calls sit inside a bare `catch {}` — so
  a 401 during enrichment is swallowed and the sync reports `PASSED`. That
  partially defeats the credential-health work: the connection is never marked.
  Forced off here so the auth assertions are not vacuous; the swallow itself needs
  its own fix.

- **`enumerationFetch` / `ENUMERATION_TIMEOUT_MS` has zero consumers.** Dead
  export from the bounded-fetch PR — every provider defaults to `resilientFetch`
  (30 s), so the 120 s per-page bound is unreachable. `bounded-fetch.ts`'s header
  comment also still claims providers default to `boundedFetch`. Both are noted
  rather than fixed here, to keep this PR to the suite.

- **The `lt`/`lte` reconcile boundary had no coverage at all.** The unit test
  mocks `updateMany` to a canned `{count: 3}`, so it asserts the query shape and
  never its effect. Measured against a real database, `lte` matches every account
  in the directory — it would deprovision 100 % of every tenant on every
  successful sync. That assertion is the single highest-value thing in this suite.
