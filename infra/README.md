# Infrastructure Configuration

This directory contains operational infrastructure configs for deploying
inflect-compliance with production-grade observability.

## READ THIS FIRST — two kinds of file live here, and only one of them runs

Most of this directory describes a Prometheus / Alertmanager / Grafana stack
that **is not deployed**. Nothing in `deploy/docker-compose.prod.yml` references
Prometheus or Alertmanager, and the running app container carries no `OTEL_*`
environment, so the OTel instruments in `src/lib/observability/` export nowhere.
`otel-collector/` and `observability/` are of that kind: a provisioning recipe
for a stack somebody could stand up, not a record of one that exists.

The files that describe what IS deployed name themselves:

| file | what it records |
| --- | --- |
| `alerts/external-uptime.yml` | the GCP uptime check on `/api/readyz` and its alert policy |
| `alerts/gcp-custom-metrics.yml` | the custom metrics the VM reports, and their alert policies |
| `alerts/policies/*.json` | those policies as applyable JSON |
| `reporters/` | the host scripts and systemd units that feed them |

Adding a Prometheus rule does not create a production alert. It was believed
to, for months, by the `ALERT ON` instruction in `integration-metrics.ts` that
#2842 corrected — which is why this section exists and why it is first. The
rule file that instruction pointed at, `alerts/rules.yml`, was never loaded by
anything and was deleted on 2026-10-26, with `alerts/receivers.yml` and
`dashboards/`.

## Directory Structure

```
infra/
├── README.md                          ← This file
├── alerts/
│   ├── external-uptime.yml            ← DEPLOYED: GCP uptime check contract
│   ├── gcp-custom-metrics.yml         ← DEPLOYED: custom-metric alert contract
│   └── policies/*.json                ← GCP alert policies, as applyable JSON
├── reporters/                         ← DEPLOYED: host scripts + systemd units
├── observability/                     ← the stack's compose project, rules and dashboards
├── scripts/
└── otel-collector/
    └── config.yml                     ← OpenTelemetry Collector config
```

## Quick Start

### Prerequisites

- An OTel Collector instance (or Grafana Alloy)
- Prometheus (for metric storage)
- Grafana (for dashboards + alerting)
- Optionally: Jaeger or Grafana Tempo (for traces)

### 1. Deploy the OTel Collector

```bash
# Using Docker:
docker run -d --name otel-collector \
  -p 4318:4318 \
  -p 4317:4317 \
  -v $(pwd)/infra/otel-collector/config.yml:/etc/otelcol-contrib/config.yaml \
  -e PROMETHEUS_REMOTE_WRITE_URL=http://prometheus:9090/api/v1/write \
  -e TRACE_BACKEND_URL=jaeger:4317 \
  otel/opentelemetry-collector-contrib:latest
```

### 2. Enable OTel in the application

```bash
OTEL_ENABLED=true
OTEL_SERVICE_NAME=inflect-compliance
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

### 3. Dashboards and alert rules

The compose project in `observability/` provisions its Grafana dashboards
(`observability/grafana/dashboards/`) and loads its Prometheus rules
(`observability/prometheus/rules/`) when it starts; there is nothing to import
by hand. See [`observability/README.md`](observability/README.md) and
[`docs/observability/03-prometheus-grafana.md`](../docs/observability/03-prometheus-grafana.md),
which lists every rule.

## Telemetry Pipeline

```
┌──────────────────────┐
│ inflect-compliance   │
│ (Next.js)            │
│                      │
│ metrics.ts ──────────┼──── OTLP HTTP (:4318) ───┐
│ tracing.ts ──────────┤                           │
│ logger.ts ───────────┼── stdout (JSON) ──┐       │
└──────────────────────┘                   │       │
                                           ▼       ▼
                                      Log Agent  OTel Collector
                                      (optional)  │        │
                                           │       │        │
                                           ▼       ▼        ▼
                                         Loki  Prometheus  Jaeger/Tempo
                                           │       │        │
                                           └───────┴────────┘
                                                   │
                                                   ▼
                                               Grafana
                                          (dashboards + alerts)
```

## Metrics Inventory

All metrics are emitted via OpenTelemetry API and exported through the OTel Collector → Prometheus pipeline.

### Request Metrics

| OTel Name | Prometheus Name | Type | Labels | Source |
|---|---|---|---|---|
| `api.request.count` | `api_request_count` | Counter | `http.method`, `http.route`, `http.status_code` | `withApiErrorHandling` |
| `api.request.duration` | `api_request_duration` | Histogram (ms) | `http.method`, `http.route`, `http.status_code` | `withApiErrorHandling` |
| `api.request.errors` | `api_request_errors` | Counter | `http.method`, `http.route`, `error.code` | `withApiErrorHandling` |

### Job Metrics

| OTel Name | Prometheus Name | Type | Labels | Source |
|---|---|---|---|---|
| `job.execution.count` | `job_execution_count` | Counter | `job.name`, `job.status` (success/failure) | `runJob`, `executorRegistry.execute` |
| `job.execution.duration` | `job_execution_duration` | Histogram (ms) | `job.name`, `job.status` | `runJob`, `executorRegistry.execute` |
| `job.queue.depth` | `job_queue_depth` | Gauge | `queue.name`, `queue.state` (waiting/active/delayed/failed) | `startQueueDepthReporting` |

### Cardinality Control

- `http.route` labels are auto-normalized: UUIDs → `:id`, tenant slugs → `:tenantSlug`
- `job.name` is bounded to the 11 registered job names in `JobPayloadMap`
- `job.status` is exactly `success` or `failure`
- `queue.state` is limited to 4 values: `waiting`, `active`, `delayed`, `failed`

## SLO Documentation

See [docs/slos.md](../docs/slos.md) for complete SLO definitions including:
- Measurement formulas
- Scope and exclusions
- Alert threshold rationale
- Error budget calculations

## Verification

### Validate the alert rules

```bash
# Syntax, using promtool (from the Prometheus distribution):
promtool check rules infra/observability/prometheus/rules/*.yml
# That every rule and panel selects a series the stack exports:
npx jest tests/unit/prometheus-rules-match-emitted-metrics.test.ts
```

### Test end-to-end telemetry

```bash
# 1. Start the local observability stack:
OTEL_ENABLED=true npm run dev

# 2. Generate some traffic:
curl http://localhost:3000/api/livez
curl http://localhost:3000/api/readyz

# 3. Check the OTel Collector internal metrics:
curl http://localhost:8888/metrics | grep otelcol_receiver
```

### Run observability test suites

```bash
# All observability guardrails and infrastructure tests:
npx jest tests/unit/observability --verbose
```

## Observability provisioning

The OTel/Prometheus/Tempo/Grafana stack is packaged as its own compose
project, to run beside the app on the VM:
[`observability/docker-compose.observability.yml`](observability/docker-compose.observability.yml).
As the top of this file says, it is not deployed. The app emits OTLP/HTTP, so moving the backend to a dedicated VM or a managed
service changes only `OTEL_EXPORTER_OTLP_ENDPOINT` and its auth header. There
is no Helm chart or Terraform module for the stack. See
[`docs/observability/01-deployment-topology.md`](../docs/observability/01-deployment-topology.md#scale-out-provisioning-beyond-the-single-vm).
