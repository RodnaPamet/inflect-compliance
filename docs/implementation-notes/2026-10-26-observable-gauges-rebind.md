# 2026-10-26 — Observable gauges survive being registered before telemetry

**Commit:** see the pull request that adds this note (`fix(observability): …`).

## Design

The OTel metrics API has no proxy provider. Until `initTelemetry()` calls
`metrics.setGlobalMeterProvider`, `metrics.getMeter()` hands out the API's no-op
meter. An instrument created on that meter stays a no-op for the rest of the
process, because nothing ever moves it to the real provider. Each observable
gauge sits behind a once-only flag, so a later call could not repair a
registration that ran too early.

A smoke run of the built worker showed `agent.runs.in_flight` exporting
nothing. `src/lib/agentic/in-flight-runs.ts` registers that gauge at module
load, and the worker imports the module before `bootstrap()` starts telemetry.
`audit-stream.ts` registers its buffer gauge the same way. The worker's
integration-freshness gauge raced `initTelemetry()` from an async boot block.

```
module load ──► bindObservable(register)  ── runs register() on the no-op meter,
                                             records boundTo = no-op provider
initTelemetry ─► setGlobalMeterProvider(real)
              └► rebindObservables()       ── every binding whose boundTo ≠ real
                                             runs register() again, boundTo = real
later call ───► bindObservable(register)   ── boundTo = real already; never re-run
```

`src/lib/observability/observable-registry.ts` holds the bindings. Every
observable instrument registers through `bindObservable`: every gauge in
`metrics.ts`, `integration-metrics.ts`, `business-metrics.ts` and
`connection-freshness.ts`. `initTelemetry()` calls `rebindObservables()` right
after installing the provider.

Separately, the worker's boot-time schedule registration now quits the Redis
connection it opened. `Queue.close()` does not quit an ioredis instance it was
handed, so that connection used to stay open and idle for the life of the
worker.

## Files

| File | Role |
| --- | --- |
| `src/lib/observability/observable-registry.ts` | `bindObservable` / `rebindObservables` |
| `src/lib/observability/instrumentation.ts` | calls `rebindObservables()` after `setGlobalMeterProvider` |
| `src/lib/observability/{metrics,integration-metrics,business-metrics,connection-freshness}.ts` | each gauge registered through `bindObservable` |
| `eslint-rules/rules/observable-gauge-rebinds.js` | `local/observable-gauge-rebinds`, refuses an observable instrument outside a `bindObservable` callback |
| `scripts/worker.ts` | schedule registration quits its own connection; comment on queue-depth order corrected |
| `tests/unit/observability/observable-registry.test.ts` | real API and SDK: reproduces the trap, proves the rebind, and loads the real `in-flight-runs.ts` |
| `tests/unit/observability/instrumentation-rebinds-gauges.test.ts` | the real `initTelemetry()` rebinds once, after the provider is global |

## Decisions

- **One rebind hook instead of moving imports later.** Making sure no module
  registers a gauge before telemetry would mean policing import order across
  the web tier, the worker and the scheduler, and one new top-level import
  would undo it. The registry makes order irrelevant.
- **A binding is re-run only when its provider changed.** A registration made
  after telemetry started already holds the current provider, so its callback
  is never added twice. A second `rebindObservables()` with nothing new does
  nothing.
- **One failing registration does not cost the others.** `rebindObservables`
  catches each one and leaves it bound where it was. Telemetry startup is never
  the place to throw.
- **An ESLint rule rather than a source-scan guard.** The invariant is
  structural ("this call sits inside that callback"). Per `eslint-rules/README.md`,
  an AST rule survives reformatting and renaming, where a regex does not. The
  binder must be the bare identifier `bindObservable` and the instrument must be
  in its FIRST argument. A property call or the second argument is a near-miss
  the rule reports.
- **The OTel mocks gained `getMeterProvider`** rather than the registry
  tolerating its absence. A production module that quietly skips the provider
  check when the API lacks the method would turn a broken mock into a silent
  no-op in the real process too.
