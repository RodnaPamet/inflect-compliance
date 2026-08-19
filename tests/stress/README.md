# Integrations stress suite (H3-3)

A **blocking** stress suite for the integrations subsystem. Run it with
`npm run stress`; CI runs it nightly, on every pull request, and on every
push to `main` via `.github/workflows/integration-stress.yml`.

The pull-request trigger was added after this suite sat red on `main` for
32 hours and ~20 merges: the Okta host allowlist in `e96b8fac5` refused
the fake server's `127.0.0.1` origin, every test in
`integration-http-hardening` failed including its sanity check, and nobody
looked. A regression that turns `main` red only works if someone is
watching, which is the thing a check exists to avoid needing.

```bash
npm run stress                                          # all tiers
npm run stress -- tests/stress/integration-http-hardening.stress.test.ts
STRESS_SCALE=4 npm run stress                           # CI's volume
```

It is excluded from the PR shards by a `JEST_STRESS=1` opt-in in
`jest.config.js` — not a separate Jest project, because
`tests/guards/coverage-config-resolution.test.ts` requires every resolved
project to declare `coveragePathIgnorePatterns`, and coverage of a stress suite
is meaningless.

## Why `tests/load/` doesn't cover this

`tests/load/{auth,lists,mutations}.js` is k6 over HTTP and touches no
integration endpoint — grep it for `integration|sync|posture|identity|okta|bullmq`
and you get nothing.

More fundamentally, **k6 is the wrong instrument**. Everything the hardening
fixed lives below the HTTP boundary:

| PR | property | reachable over HTTP? |
| --- | --- | --- |
| #1950 | a hung provider is bounded by a deadline | no |
| #1955 | a throttle is absorbed or deferred, never amplified | no |
| #1957 | a dispatcher retry doesn't re-queue every connection | no |
| #1958 | one sync per connection; a dead worker's lease is reaped | no |
| #1960 | a resumed pass doesn't deprovision its own earlier runs | no |

## The transport decision

Every provider takes an injectable `deps.fetchImpl`, which makes a fake fetch
the obvious choice — and the wrong one. `http-resilience.ts` resolves
`opts.fetchImpl ?? boundedFetch`, so injecting a bare fake **replaces both
hardened layers**. The bounded-fetch guard says so out loud: *"a test that passes
its own fetch SHOULD bypass the deadline."* A suite built that way reports green
about behaviour it never executed.

So the harness injects a **composed real stack** — `createResilientFetch` over
`createBoundedFetch` — swapping only the singletons' baked-in production
constants for short ones. Every line of both modules runs, against a real
`node:http` server, with real `AbortSignal.timeout` / `AbortSignal.any`.

The decisive argument for a socket over a stub is **timers, not sockets**. Every
DB-backed scenario runs inside `runInTenantContext`'s Prisma interactive
transaction, whose 5 s expiry is server-side wall clock —
`jest.advanceTimersByTimeAsync` cannot move it. Measured: a 9 s hang expires the
transaction and persists nothing. Fake timers were never available, which removes
the stub's only advantage. A socket additionally proves the abort **releases** the
connection, which is the half that matters when the failure is "one hung provider
holds a worker slot".

Okta is the only provider whose base URL is config-driven (`config.orgUrl`), so
it's the only one reachable at `127.0.0.1`. Entra, Google, BambooHR and
SharePoint hardcode their bases. That's sufficient: the hardening lives in the
two shared modules, not per provider.

## Tiers

| file | transport | asserts |
| --- | --- | --- |
| `integration-http-hardening.stress.test.ts` | real socket | deadline, attempt cap, socket release, 429 absorb/defer, 401 marks, 404 doesn't, recovery clears |
| `identity-sync-resume-reconcile.stress.test.ts` | fake provider, real DB | multi-run pass, `lt`/`lte` boundary, exact deprovision count, no reconcile on partial |
| `integration-sync-lock-contention.stress.test.ts` | none (DB only) | single winner, reaper, reaped holder can't unlock, job-layer skip |
| `integration-dispatch-fanout.stress.test.ts` | mocked `enqueue`, real DB | one id per connection per bucket, bucket rollover, failure isolation, `noRetry` passthrough |

The lock tier drives the **job**, not the usecase: `acquireSyncLock` lives in
`jobs/identity-sync.ts`, so a harness written against `runIdentitySync` would
bypass the lease and pass while proving nothing.

## Thresholds are counts, not timings

24 of 25 assertions are integer counts or row states. That's deliberate: the
suite is **blocking**, and a flaky blocking check gets disabled — which is
strictly worse than not having one.

The repo's own perf history is the evidence. `encryption-middleware.perf.test.ts`
tried 200 %, 500 % and 1000 % margins and flaked at all three before settling at
5000 % over a 62 % baseline; `tests/load/mutations.js` moved 15 % → 20 %. A
threshold needing that much margin cannot see a 2× regression anyway.

So timing numbers (p95, throughput, RSS) are **recorded and uploaded, never
asserted** — `recordTrend()` prints `[stress] name=value`. The one timing bound
that is blocking is `< 4000 ms` against a measured 3071 ms, and it exists only to
catch "the deadline stopped firing entirely", where the failure is an order of
magnitude.

## Traps encoded in the harness

Each of these was measured, and each would silently hollow out an assertion:

- **`enrichPerUser` must be `'false'`.** Its default is `'true'`, fanning
  `/factors` + `/roles` per account — and every one of those calls sits inside a
  bare `catch {}`, so an injected 401/429/timeout is swallowed and the sync still
  reports `PASSED`. With it on, the 401 and 404 assertions pass while testing
  nothing.
- **`maxAbsorbedRetryAfterMs` must exceed 1000.** `Retry-After` delta-seconds is
  integer-only, so the smallest absorbable value is 1000 ms. A lower budget takes
  the *defer* branch, and an "absorb" test then asserts the opposite of its name.
- **Deadline ≥ 1000 ms, and total hang budget < 4 s.** Below ~1000 ms a 2-vCPU
  runner's GC pauses reach into the deadline; above ~5 s total the Prisma
  transaction expires and nothing is recorded at all.
- **Concurrency capped at 8.** The pg pool defaults to `max: 10` under the driver
  adapter and each in-flight tenant holds a connection for its whole enumeration,
  so 10 concurrent drivers all fail with a pool timeout. `?connection_limit=N` is
  a no-op here.
- **Pass `now` explicitly to `dispatchJobId`.** A run straddling a UTC bucket
  boundary otherwise yields two ids for one connection — a 1-in-N-runs flake.
- **`requireStressDb()` fails, never skips.** A skipped suite in a blocking job
  reads as green, which is the exact failure mode this suite guards elsewhere.

## Out of scope: worker-pool starvation

The headline failure — *one hung provider starves the shared BullMQ pool for
every other tenant* — is **not asserted here, because it is not observable**.

No test in this repo runs a real BullMQ `Worker`:
`tests/integration/bullmq-queue.test.ts` documents that BullMQ v5's Lua scripts
are incompatible with in-process Redis mocks, and `scripts/worker.ts`'s processor
and its `concurrency` / `limiter` are not exported.

A width-5 semaphore in the harness would *look* like coverage and would assert
the harness's own semaphore — staying green if production concurrency became 50.
That's the "guards validate diagnosis, not remedy" trap, so it is deliberately
not done.

What is asserted instead — the two properties starvation reduces to, both
reachable today:

1. **Every outbound call terminates.** A real hung socket produces
   `IntegrationTimeoutError` at the deadline, with attempts capped. "The deadline
   stopped firing" is the regression class that *causes* starvation.
2. **A doomed job does not re-run.** `noRetry` reaches the job result and the
   worker turns it into `UnrecoverableError`.

Making starvation itself observable needs a `redis:7-alpine` service plus
extracting `scripts/worker.ts`'s processor into an importable module so a test can
build a real `Worker` at production width. When that lands it should be
**non-blocking**: Lua/Redis flake in a gate destroys trust in the gate.
