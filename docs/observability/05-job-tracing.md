# 05 — Job tracing: threading a trace web → BullMQ worker

## The problem this closes

The app emits OTel spans for HTTP handlers, usecases, and repository
calls. But background work runs in a **separate process** — the BullMQ
worker (`scripts/worker.ts`) — and that process used to start without
OTel initialised. Two consequences:

1. **Worker work was invisible to Tempo.** No spans, at all, for
   anything a job did.
2. **The trace stopped at `queue.add(...)`.** When a web request
   enqueued a job (e.g. *policy publish → audit-pack rebuild*), the
   job's execution started a brand-new, disconnected trace. An
   operator asking *"the user POSTed to `/policies/[id]/publish` at
   14:02 — show me everything that happened, including the async
   rebuild"* had to correlate timestamps by hand.

This document describes how the trace now follows the job.

## The flow

```
  ┌─────────────────────────── web process ───────────────────────────┐
  │  HTTP handler span                                                  │
  │      │  usecase span … repository span …                           │
  │      ▼                                                              │
  │   enqueue <job>  span   ──── propagation.inject(active ctx) ───┐    │
  │      │  queue.add(name, { ...payload, __otel_carrier })        │    │
  └──────┼───────────────────────────────────────────────────────┼────┘
         │                                                         │
         ▼                                          Redis (BullMQ job row,
   (HTTP response returns)                           carrier rides on payload)
                                                                   │
  ┌─────────────────────────── worker process ──────────────────┼─────┐
  │   Worker picks up job                                         │     │
  │      readTraceCarrier(job.data) ── propagation.extract ───────┘     │
  │      otelContext.with(parentCtx, …)                                 │
  │      execute <job>  span   ◀── child of the enqueue span            │
  │          │  usecase span … repository span …  (all linked)          │
  └─────────────────────────────────────────────────────────────────┘
```

The W3C `traceparent` (+ `tracestate`) is carried across the process
boundary as a small carrier object stashed on the job payload. The
worker activates it as the parent context, so the `execute <job>` span
— and every usecase/repository span created inside the executor — links
back to the originating request as **one continuous trace**.

## The moving parts

| Where | What it does |
|-------|--------------|
| `src/lib/observability/job-trace.ts` | The single seam. `captureTraceCarrier()` / `readTraceCarrier()` / `stripTraceCarrier()` and `runJobInTraceContext()` (extract → activate → active span). Defines `OTEL_CARRIER_KEY`. |
| `src/app-layer/jobs/queue.ts` → `enqueue()` | Wraps the add in an `enqueue <name>` active span and `propagation.inject`s the context into the carrier, attached under `OTEL_CARRIER_KEY`. |
| `scripts/worker.ts` | Calls `initTelemetry()` in `bootstrap()` **before** the first `new Worker(...)`; runs every job through `runJobInTraceContext`; drains spans via `shutdownTelemetry()` on SIGTERM/SIGINT. |

### The `__otel_carrier` payload key

The carrier rides on the job payload under the sentinel key
`__otel_carrier` (the exported `OTEL_CARRIER_KEY`). It is:

- **Namespaced** with a double underscore so it can never collide with
  a typed `JobPayload<T>` field. Executors read only their own payload
  shape and never see it.
- **Stripped** before the payload reaches the executor (and before the
  worker logs the payload) via `stripTraceCarrier`.
- **Internal observability plumbing — never logged, never shipped in
  audit-stream events.** It is not PII, but it does not belong in the
  audit trail. This is a review sentinel: a PR that logs `job.data`
  raw, or forwards it to the audit stream, must strip the carrier
  first. (The audit-stream payload is already structured-only; this is
  a belt-and-suspenders note for any new code path that handles raw job
  data.)

### Worker-init sequencing

OTel must be initialised **before the worker processes its first job**,
because the global tracer provider is what turns the manual
`startActiveSpan` calls from no-ops into real, exported spans.
`bootstrap()` `await`s `initTelemetry()` before constructing the
`Worker`. `initTelemetry()` is a fast no-op when `OTEL_ENABLED` is
unset, so dev/test pay nothing.

> We do **not** use an auto-instrumentation package
> (`@opentelemetry/instrumentation-bullmq`). It is not an official
> OTel-scoped package and would have to clear this repo's
> dependency-governance gates (npm audit blocks on MODERATE+). Instead
> the enqueue/execute spans carry the canonical `messaging.*`
> semantic-convention attributes (`messaging.system: bullmq`,
> `messaging.destination.name`, `messaging.operation`,
> `messaging.message.id`) **manually** — so Tempo's trace search can
> still filter by queue/operation, with no third-party dependency.

## How an operator pivots from a slow request to its worker spans

1. **Open Explore → Tempo** and run a TraceQL search:
   - all worker executions:
     `{ resource.service.name="inflect-compliance" && name=~"execute .*" }`
   - one queue:
     `{ name=~"execute .*" && span.messaging.destination.name="inflect-jobs" }`

   To start from a slow moment on the API dashboard (`inflect-api-overview.json`,
   *Latency percentiles*) or the jobs dashboard (`inflect-jobs-and-queues.json`,
   *Job p95 duration over time*), note the time and narrow the search to it.
2. Open the trace. The HTTP handler span is the root; the
   `enqueue <job>` span and the worker's `execute <job>` span (with its
   nested usecase/repository spans) hang underneath — the full causal
   chain in one view.

### No per-datapoint links from the dashboards

Grafana's Prometheus datasource is provisioned with an exemplar link to
Tempo (`exemplarTraceIdDestinations` → `trace_id` → the `tempo` datasource
in `provisioning/datasources/datasources.yml`), but a data point carries a
clickable `trace_id` only when the app records exemplars on the histogram
behind it. The app's metrics SDK records none, so hovering a data point
offers no **View trace in Tempo** link. Use the TraceQL search above. The
cross-process trace itself (the diagram above) works regardless.

## Out of scope (intentional)

- **Propagation across the audit-stream webhook to per-tenant SIEMs.**
  The audit stream is fire-and-forget *after* the row commits; pushing
  Inflect's internal trace IDs into a customer's SIEM is the wrong
  direction and leaks internal topology.
- **Cross-region propagation** (warm-standby). The carrier is
  region-agnostic; nothing to do here.

## Verification

- `npx jest tests/guardrails/job-trace-propagation.test.ts` — structural
  wiring ratchet.
- `npx jest tests/integration/job-execution-with-trace.test.ts` —
  drives the real propagation seam through the OTel test SDK and asserts
  the `execute` span is a child of the originating web span (same trace),
  the carrier is stripped before the executor, the failure path marks
  the span ERROR, and a carrier-less (legacy) job starts a fresh root.
- Manual smoke (dev, `OTEL_ENABLED=true` + a local collector/Tempo):
  POST a request that enqueues a job, then look the trace up in Tempo —
  the HTTP span has the child `execute <job>` span beneath it.
