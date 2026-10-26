# 02 — OpenTelemetry Collector

> How the collector is deployed and configured: receivers, processors,
> exporters, pipelines, and operational safeguards. The companion
> artifact is `infra/observability/otel-collector/config.yaml`.

# Collector Deployment Recommendation

**One gateway-pattern collector per environment.** A single
`otel/opentelemetry-collector-contrib` container receives all OTLP
from the application, processes it, and fans it out to Prometheus
(via its own Prometheus exporter) and to Tempo (via OTLP). It is
defined in `infra/observability/docker-compose.observability.yml`
as the `otel-collector` service.

The OpenTelemetry Collector has three canonical deployment patterns.
For inflect-compliance the gateway pattern is the correct choice and
the other two are over-engineering:

- **Agent / sidecar (one collector per app container).** Used when
  each application instance needs a local collector for trace
  context propagation or to offload export latency. inflect-
  compliance runs **three process types from one image** on one VM.
  A sidecar per process triples the collector count to centralise
  nothing — every sidecar would still forward to the same backends.
  Rejected: pure overhead.

- **DaemonSet (one collector per node).** The Kubernetes pattern for
  collecting node-level signals (host metrics, container logs) close
  to the source. The compose deployment is a single VM; the app does
  not emit node-level signals through the collector (host metrics
  are out of scope, logs are out of scope). On the Kubernetes
  secondary deployment the `opentelemetry-collector` Helm chart can
  run a DaemonSet *if* node collection is later wanted — but the
  application-telemetry path still wants a gateway. Rejected for the
  primary deployment.

- **Gateway (one shared collector).** A single collector that the
  whole fleet pushes to. It centralises batching, sampling, the
  resource-enrichment processors, and — critically — the
  **Prometheus-exporter surface that Prometheus scrapes**. The app
  is a small fleet that already *pushes* OTLP; a gateway is the
  natural sink. **Chosen.**

The gateway also gives a single, stable scrape target. If each
process had its own collector, Prometheus would need service
discovery to find a moving set of `:8889` endpoints. With one
gateway, `prometheus.yml` names exactly one target. Simplicity
compounds.

Resource envelope: the compose file caps the collector at
`mem_limit: 512m` and `cpus: 1.0`. That is generous for this app's
signal volume — the `memory_limiter` processor (below) enforces a
soft ceiling well under the container limit so the OOM killer never
sees the process.

# Receivers

The collector accepts **OTLP only** — the single protocol the app's
OpenTelemetry SDK speaks.

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
```

- **`:4318` — OTLP/HTTP.** This is the path the application uses.
  `src/lib/observability/instrumentation.ts` constructs
  `OTLPTraceExporter` and `OTLPMetricExporter` from the
  `@opentelemetry/exporter-*-otlp-http` packages, pointed at
  `${OTEL_EXPORTER_OTLP_ENDPOINT}` — default `http://localhost:4318`,
  set in production to `http://otel-collector:4318`. The SDK appends
  `/v1/traces` and `/v1/metrics` itself.

- **`:4317` — OTLP/gRPC.** Enabled for completeness and because
  Tempo's own OTLP receiver (and any future gRPC OTLP source)
  speaks it. The app does not currently use it, but enabling both
  protocols on the receiver costs nothing and avoids a config
  change if a future component prefers gRPC.

`endpoint: 0.0.0.0` inside the container is correct — the container
is only reachable on the `observability` and `app` docker networks,
neither of which is host-published. "Bind to 0.0.0.0" here means
"reachable on the docker bridge", not "reachable from the
internet". The network isolation is enforced at the docker-network
layer, not the bind address; see `04-production-hardening.md`.

No `prometheus` receiver, no `filelog` receiver, no `hostmetrics`
receiver. The collector ingests application OTLP and nothing else.

# Processors

Processors run in pipeline order. The order below is deliberate and
**`memory_limiter` must be first**.

```yaml
processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 384
    spike_limit_mib: 96

  resourcedetection:
    detectors: [env, system]
    timeout: 5s
    override: false

  resource:
    attributes:
      - key: deployment.environment
        value: ${env:DEPLOYMENT_ENVIRONMENT}
        action: upsert

  batch:
    timeout: 10s
    send_batch_size: 1024
    send_batch_max_size: 2048

  probabilistic_sampler:
    sampling_percentage: ${env:OTEL_SAMPLING_PERCENTAGE}
```

- **`memory_limiter` — first in every pipeline.** It is the
  back-pressure valve. `limit_mib: 384` and `spike_limit_mib: 96`
  put the soft ceiling at 384 MiB with a 96 MiB spike headroom —
  comfortably under the container's `mem_limit: 512m`. When memory
  approaches the limit the processor **refuses new data** (the
  receiver returns a retryable error to the app's exporter) rather
  than letting the process OOM. Placing it first means the refusal
  happens before any expensive downstream processing. A refused
  batch is observable: `otelcol_processor_refused_*` increments, and
  there is an alert on it (see `04`).

- **`resourcedetection`** — enriches every signal with environment
  and host attributes. `detectors: [env, system]` reads
  `OTEL_RESOURCE_ATTRIBUTES`-style env attributes and basic host
  info. `override: false` so it never clobbers a resource attribute
  the app already set (`service.name`, `service.version`, and
  `deployment.environment` are set by the SDK in
  `instrumentation.ts`).

- **`resource`** — `upsert`s `deployment.environment` from the
  `DEPLOYMENT_ENVIRONMENT` env var (`production` / `staging` /
  `local`). This is the authoritative environment stamp: even if the
  app's `NODE_ENV` is ambiguous, the collector guarantees every
  signal leaving this collector carries the right environment. It is
  how Grafana folders and alert routing distinguish environments —
  and it is why **one collector serves exactly one environment**.

- **`batch`** — coalesces signals into efficient export batches.
  `timeout: 10s` bounds latency; `send_batch_size: 1024` /
  `send_batch_max_size: 2048` bound batch size. Batching downstream
  of the app's own `BatchSpanProcessor` is not redundant — the app
  batches *its* spans, the collector re-batches across *all* app
  processes into uniform exporter payloads.

- **`probabilistic_sampler` — traces pipeline only.** Head-based
  sampling keyed off the trace ID. `sampling_percentage` is driven
  by the `OTEL_SAMPLING_PERCENTAGE` env var — `100` for local and
  staging (keep every trace), `20` for production (keep one in
  five). **It is in the traces pipeline only.** Metrics are *never*
  sampled — `api_request_count`, `api_request_duration`, the job
  and audit-stream counters must be exact. Sampling traces while
  keeping metrics whole is the standard cost/fidelity trade:
  metrics answer "is something wrong" and must be complete; traces
  answer "why" and a representative fifth is enough.

# Exporters

```yaml
exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
    resource_to_telemetry_conversion:
      enabled: true

  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true

  debug:
    verbosity: basic
```

- **`prometheus` — `:8889`.** The collector exposes a Prometheus
  scrape endpoint on `:8889`; **Prometheus scrapes it.** This is the
  pivot from push to pull: the app pushes OTLP metrics *to* the
  collector, the collector re-exposes them in Prometheus exposition
  format *for* Prometheus to scrape. `resource_to_telemetry_conversion`
  promotes resource attributes (`service.name`,
  `deployment.environment`) to metric labels so PromQL can filter
  by them. Note the metric-name transformation: OTel's dotted names
  become Prometheus's underscored names, and units are appended.
  `api.request.duration` (a histogram, unit `ms`) becomes
  `api_request_duration_milliseconds` with `_bucket` / `_sum` /
  `_count` series; `audit_stream.delivery.failures` becomes
  `audit_stream_delivery_failures_total` (the `_total` suffix is
  Prometheus's counter convention); and a gauge whose unit is `1`
  gets `_ratio`, so `job.queue.depth` is `job_queue_depth_ratio`
  and `business.tenant.active.daily` is
  `business_tenant_active_daily_ratio`. Attribute keys are
  underscored the same way (`job.status` → `job_status`). All PromQL
  in `03-prometheus-grafana.md` uses these transformed names, and
  `tests/unit/prometheus-rules-match-emitted-metrics.test.ts` checks
  it against them.

- **`otlp/tempo` — push to `tempo:4317`.** The traces pipeline
  exports sampled spans via OTLP/gRPC to Tempo's OTLP receiver.
  `tls.insecure: true` is correct here — the hop is container-to-
  container on the internal `observability` docker network, which
  never leaves the host. TLS on an in-VM bridge would add a cert to
  manage for no threat-model gain; the network isolation is the
  control.

- **`debug`** — writes a summary of processed signals to the
  collector's stdout. `verbosity: basic` keeps it to counts, not
  full payloads. It is in both pipelines as a diagnostic tap:
  `docker logs obs-otel-collector` shows whether data is flowing
  without standing up a downstream. Keep it at `basic` in
  production; bump to `detailed` only when actively debugging a
  pipeline.

No `otlphttp`-to-a-SaaS exporter, no `loki` exporter (logs are out
of scope). The exporter set is exactly: Prometheus surface, Tempo,
and a debug tap.

# Pipeline Design

Two pipelines — one per signal type. **No logs pipeline.**

```yaml
service:
  telemetry:
    metrics:
      address: 0.0.0.0:8888
  extensions: [health_check]
  pipelines:
    metrics:
      receivers:  [otlp]
      processors: [memory_limiter, resourcedetection, resource, batch]
      exporters:  [prometheus, debug]
    traces:
      receivers:  [otlp]
      processors: [memory_limiter, resourcedetection, resource, probabilistic_sampler, batch]
      exporters:  [otlp/tempo, debug]
```

**Metrics pipeline.** App OTLP metrics in → `memory_limiter` →
`resourcedetection` → `resource` → `batch` → out to the Prometheus
exporter on `:8889` (and the debug tap). No sampler — metrics are
exact. This pipeline carries every instrument the app records from
`src/lib/observability/metrics.ts`: the RED metrics
(`api_request_count`, `api_request_duration`, `api_request_errors`),
the repository metrics (`repo_method_duration/calls/errors/result_count`),
the job metrics (`job_execution_count/duration`), and
`audit_stream_delivery_failures`. The `job.queue.depth` gauge
(`job_queue_depth_ratio`) comes from the worker process alone:
`scripts/worker.ts` calls `startQueueDepthReporting` after
`initTelemetry()`, and the web tier never registers it.

**Traces pipeline.** App OTLP spans in → `memory_limiter` →
`resourcedetection` → `resource` → `probabilistic_sampler` →
`batch` → out via OTLP to Tempo (and the debug tap). The sampler
sits **after** resource enrichment (so sampled-out traces are still
counted correctly by enrichment-stage metrics) and **before**
`batch` (so the batch only carries kept spans — no point batching
spans about to be dropped).

**Why no logs pipeline — the explicit decision.** Logs are out of
scope for this stack, for three concrete reasons:

1. **The app already has a log path.** `src/lib/observability/logger.ts`
   emits structured Pino JSON to stdout. The docker log driver
   captures it; `docker logs` and the host's journal are the log
   surface today. Routing logs through the collector would add an
   OTLP-logs exporter in the app and a logs pipeline here to
   reproduce a capability that already works.

2. **Prometheus cannot store logs.** Prometheus is a metrics TSDB.
   A logs pipeline would need a logs *backend* — Grafana Loki —
   which is a fourth storage component with its own retention,
   its own volume, its own scaling story.

3. **Loki is a separate, bounded initiative.** Adding Loki is a
   deliberate future project with its own scope, not a rider on
   this stack. Keeping logs out keeps the component count at four
   and the architecture legible. When log aggregation is wanted,
   it slots in as `filelog` receiver → `loki` exporter → Loki,
   without disturbing the metrics and traces pipelines.

`service.telemetry.metrics.address: 0.0.0.0:8888` exposes the
collector's **own** metrics (`otelcol_*`) on `:8888` for Prometheus
to scrape — this is how the stack monitors itself (see `04`). The
`health_check` extension listens on `:13133` and backs the
container `healthcheck` in the compose file.

# Config Strategy

**The collector config is code.** It lives at
`infra/observability/otel-collector/config.yaml`, is mounted
read-only into the container
(`./otel-collector/config.yaml:/etc/otelcol-contrib/config.yaml:ro`),
and is changed only through git → review → redeploy. There is no
runtime config editing, no admin API mutating it.

**Environment-varying values come from env vars, not separate
files.** The config is byte-identical across environments; what
changes is injected:

- `${env:DEPLOYMENT_ENVIRONMENT}` — `production` / `staging` /
  `local`, stamped by the `resource` processor.
- `${env:OTEL_SAMPLING_PERCENTAGE}` — `100` for local/staging,
  `20` for production, consumed by `probabilistic_sampler`.

Both are set per environment in `infra/observability/.env` (template
at `.env.example`). One config file, three environments, zero
drift — this is what makes "staging is exactly production" true.

**Pinned image tag.** The compose file pins
`otel/opentelemetry-collector-contrib:0.123.0`. Never `:latest` —
the collector's config schema evolves across minor versions and a
silent image bump could fail to parse a known-good config. Upgrades
are deliberate, staging-first; see `04-production-hardening.md`.

**`contrib` distribution, deliberately.** The `-contrib` image
carries the `resourcedetection` processor and the broader processor
set. The core distribution is leaner but would not parse this
config. The contrib image is the standard choice for any non-trivial
pipeline.

**Validating a config change before deploy:**

```bash
# Dry-run the config against the pinned image — fails on a bad config.
docker run --rm \
  -v "$(pwd)/infra/observability/otel-collector/config.yaml:/cfg.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.123.0 \
  validate --config=/cfg.yaml
```

Run this in CI on any change to the collector config so a broken
pipeline is caught before it reaches staging.

# Reliability / Operational Safeguards

The collector is a single instance with no failover — these are the
properties that make that safe.

- **`memory_limiter` prevents OOM.** Under a signal spike the
  collector refuses new data rather than crashing. A refused batch
  is a retryable error to the app's exporter and a bump on
  `otelcol_processor_refused_metric_points` /
  `otelcol_processor_refused_spans`. The alternative — no limiter,
  process OOMs, container restarts, all in-flight data lost — is
  strictly worse. Refusal is graceful degradation; a crash is not.

- **Telemetry loss is bounded and non-fatal.** If the collector is
  down, the app's OTLP exporter fails. The OTel SDK's exporters log
  the failure and drop the batch — they do **not** block the
  request path. `recordRequestMetrics` and the other recorders in
  `metrics.ts` write to **noop instruments** when no MeterProvider
  is reachable. **The application is unaffected by collector
  loss.** It keeps serving traffic; it simply produces no telemetry
  for the outage window. This is the central reliability property:
  the observer is never a dependency of the observed.

- **`restart: unless-stopped` + healthcheck.** The compose service
  restarts the container automatically; the `health_check`
  extension on `:13133` backs a docker `healthcheck` so a wedged-
  but-running collector is detected and restarted. The combined
  effect bounds a collector outage to seconds.

- **Self-observability.** The collector exposes `otelcol_*` metrics
  on `:8888`; Prometheus scrapes them. The stack-health dashboard
  and the alerts in `04` watch:
  - `otelcol_exporter_send_failed_metric_points` /
    `otelcol_exporter_send_failed_spans` — the collector cannot
    reach Prometheus's exposition surface or Tempo.
  - `otelcol_processor_refused_*` — `memory_limiter` is shedding
    load; the collector is under memory pressure.
  - `otelcol_receiver_refused_*` — the receiver rejected incoming
    OTLP.
  The collector at 0.123.0 emits no `otelcol_processor_dropped_*`
  series; `memory_limiter`'s refusals are its load-shedding signal.

- **Graceful shutdown alignment.** The app's Epic E shutdown handler
  (`src/lib/observability/shutdown.ts`) drains the app-side OTel
  SDK on SIGTERM before exit, so a clean app redeploy flushes
  in-flight spans to the collector rather than dropping them. The
  collector's own `batch` processor flushes on shutdown. A
  rolling deploy of either side loses at most one batch interval.

- **Bounded blast radius on config error.** A bad config fails the
  container at startup (the validate step above catches it earlier).
  A failed collector container does not affect the app, Prometheus,
  Tempo, or Grafana — they keep running on the last good data. The
  fix is: correct the config, redeploy the one container.

# Example Deployment / Config Outline

The full config is at
`infra/observability/otel-collector/config.yaml`. Skeleton:

```yaml
# infra/observability/otel-collector/config.yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 384
    spike_limit_mib: 96
  resourcedetection:
    detectors: [env, system]
    timeout: 5s
    override: false
  resource:
    attributes:
      - key: deployment.environment
        value: ${env:DEPLOYMENT_ENVIRONMENT}
        action: upsert
  batch:
    timeout: 10s
    send_batch_size: 1024
    send_batch_max_size: 2048
  probabilistic_sampler:
    sampling_percentage: ${env:OTEL_SAMPLING_PERCENTAGE}

exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
    resource_to_telemetry_conversion: { enabled: true }
  otlp/tempo:
    endpoint: tempo:4317
    tls: { insecure: true }
  debug:
    verbosity: basic

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  # pprof / zpages, if enabled for debugging, MUST bind to localhost
  # inside the container — see 04-production-hardening.md.
  # pprof:  { endpoint: localhost:1777 }
  # zpages: { endpoint: localhost:55679 }

service:
  telemetry:
    metrics:
      address: 0.0.0.0:8888
  extensions: [health_check]
  pipelines:
    metrics:
      receivers:  [otlp]
      processors: [memory_limiter, resourcedetection, resource, batch]
      exporters:  [prometheus, debug]
    traces:
      receivers:  [otlp]
      processors: [memory_limiter, resourcedetection, resource, probabilistic_sampler, batch]
      exporters:  [otlp/tempo, debug]
```

Compose service (from
`infra/observability/docker-compose.observability.yml`):

```yaml
otel-collector:
  image: otel/opentelemetry-collector-contrib:0.123.0
  container_name: obs-otel-collector
  restart: unless-stopped
  command: ["--config=/etc/otelcol-contrib/config.yaml"]
  environment:
    DEPLOYMENT_ENVIRONMENT: ${DEPLOYMENT_ENVIRONMENT:-production}
    OTEL_SAMPLING_PERCENTAGE: ${OTEL_SAMPLING_PERCENTAGE:-20}
  volumes:
    - ./otel-collector/config.yaml:/etc/otelcol-contrib/config.yaml:ro
  networks: [observability, app]   # 'app' is the app compose's external network
  healthcheck:
    test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:13133/"]
    interval: 30s
    timeout: 5s
    retries: 3
    start_period: 20s
  mem_limit: 512m
  cpus: 1.0
```

App side — the only app env vars that wire it up:

```bash
# App .env (docker-compose.prod.yml / Helm values)
OTEL_ENABLED=true
OTEL_SERVICE_NAME=inflect-compliance-web      # -worker on the worker process
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

# Acceptance Criteria

- [ ] `infra/observability/otel-collector/config.yaml` exists, is
      mounted read-only, and validates against
      `otel/opentelemetry-collector-contrib:0.123.0` via the
      `validate` subcommand.
- [ ] Exactly **one** collector runs per environment (gateway
      pattern) — no sidecars, no DaemonSet on the compose
      deployment.
- [ ] The `otlp` receiver listens on `:4317` (gRPC) and `:4318`
      (HTTP); the app pushes to `http://otel-collector:4318`.
- [ ] The processor chain is `memory_limiter` (first) →
      `resourcedetection` → `resource` → `batch`, with
      `probabilistic_sampler` added to the **traces** pipeline only.
- [ ] `memory_limiter.limit_mib` (384) is below the container
      `mem_limit` (512m); a signal spike produces
      `otelcol_processor_refused_*`, not an OOM.
- [ ] The metrics pipeline exports to the `prometheus` exporter on
      `:8889`; the traces pipeline exports via OTLP to `tempo:4317`.
- [ ] The collector's self-metrics are exposed on `:8888` and the
      `health_check` extension on `:13133`.
- [ ] There is **no logs pipeline** — logs remain Pino-to-stdout,
      out of scope.
- [ ] `DEPLOYMENT_ENVIRONMENT` and `OTEL_SAMPLING_PERCENTAGE` are
      injected as env vars; the config file is byte-identical
      across environments.
- [ ] Production runs `OTEL_SAMPLING_PERCENTAGE=20`; staging and
      local run `100`. Metrics are never sampled.
- [ ] Stopping the collector does not affect the app: requests
      still serve, `/api/readyz` stays green, app-side OTLP
      exports fail silently to noop instruments.
- [ ] `otelcol_exporter_send_failed_*` and
      `otelcol_processor_refused_*` are scraped by Prometheus and
      have alerts (see `04-production-hardening.md`).
- [ ] The image tag is pinned to `:0.123.0` — never `:latest`.
