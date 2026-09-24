# Infrastructure Configuration

This directory contains operational infrastructure configs for deploying
inflect-compliance with production-grade observability.

## READ THIS FIRST — two kinds of file live here, and only one of them runs

Most of this directory describes a Prometheus / Alertmanager / Grafana stack
that **is not deployed**. Nothing in `deploy/docker-compose.prod.yml` references
Prometheus or Alertmanager, and the running app container carries no `OTEL_*`
environment, so the OTel instruments in `src/lib/observability/` export nowhere.
`alerts/rules.yml`, `alerts/receivers.yml`, `otel-collector/`, `observability/`
and `dashboards/` are all of that kind: a provisioning recipe for a stack
somebody could stand up, not a record of one that exists.

The files that describe what IS deployed name themselves:

| file | what it records |
| --- | --- |
| `alerts/external-uptime.yml` | the GCP uptime check on `/api/readyz` and its alert policy |
| `alerts/gcp-custom-metrics.yml` | the custom metrics the VM reports, and their alert policies |
| `alerts/policies/*.json` | those policies as applyable JSON |
| `reporters/` | the host scripts and systemd units that feed them |

Adding a rule to `rules.yml` does not create an alert. It was believed to, for
months, by the `ALERT ON` instruction in `integration-metrics.ts` that #2842
corrected — which is why this section exists and why it is first.

## Directory Structure

```
infra/
├── README.md                          ← This file
├── alerts/
│   ├── rules.yml                      ← Prometheus rules — NOT DEPLOYED
│   ├── receivers.yml                  ← Alertmanager routing — NOT DEPLOYED
│   ├── external-uptime.yml            ← DEPLOYED: GCP uptime check contract
│   ├── gcp-custom-metrics.yml         ← DEPLOYED: custom-metric alert contract
│   └── policies/*.json                ← GCP alert policies, as applyable JSON
├── reporters/                         ← DEPLOYED: host scripts + systemd units
├── dashboards/
│   └── grafana-api-slos.json          ← Grafana dashboard (importable)
├── observability/                     ← compose/helm/terraform for the stack
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

### 3. Import the Grafana Dashboard

1. Open Grafana → Dashboards → Import
2. Upload `infra/dashboards/grafana-api-slos.json`
3. Select your Prometheus datasource when prompted
4. The dashboard UID is `inflect-compliance-slos`

### 4. Load Alert Rules

**Prometheus Alertmanager:**
```bash
# Copy to Prometheus rules directory:
cp infra/alerts/rules.yml /etc/prometheus/rules/inflect-compliance.yml
# Reload Prometheus:
curl -X POST http://prometheus:9090/-/reload
```

**Grafana Unified Alerting:**
1. Open Grafana → Alerting → Alert rules
2. Import from `infra/alerts/rules.yml` via the Provisioning API
3. Or create rules manually using the PromQL expressions from the file

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

## Dashboard Panels (14)

### SLO Overview

| Panel | Type | Description |
|---|---|---|
| API Availability | Stat | Current availability % (SLO: ≥ 99.9%) |
| P95 Latency | Stat | Current P95 response time (SLO: < 500ms) |
| Error Rate | Stat | Current 5xx error rate (SLO: < 1%) |
| Request Rate | Stat | Current requests/sec |

### Latency & Throughput

| Panel | Type | Description |
|---|---|---|
| API Latency Percentiles | Time series | P50/P95/P99 over time with threshold line |
| Request Volume by Status | Time series | 2xx/4xx/5xx stacked bars |

### Route-Level Detail

| Panel | Type | Description |
|---|---|---|
| Top Slow Routes (P95) | Table | Top 10 routes by P95 latency |
| Top Failing Routes (5xx) | Table | Top 10 routes by 5xx count |

### Health & Readiness

| Panel | Type | Description |
|---|---|---|
| Readiness Probe | Stat | UP/DOWN from synthetic monitoring |
| Liveness Probe | Stat | UP/DOWN from synthetic monitoring |
| Process Uptime | Stat | Seconds since last restart |

### Job Execution Metrics

| Panel | Type | Description |
|---|---|---|
| Job Execution Rate | Time series | Success/failure rate per job name |
| Job Duration (P95) | Time series | P95 execution duration per job |
| Queue Depth | Time series | Waiting/active/delayed/failed job counts |

## Alert Rules (10)

### API Alerts

| Alert | Severity | Condition | For |
|---|---|---|---|
| ApiErrorRateWarning | warning | 5xx rate > 1% | 10m |
| ApiErrorRateCritical | critical | 5xx rate > 5% | 5m |
| ApiP95LatencyWarning | warning | P95 > 500ms | 10m |
| ApiP95LatencyCritical | critical | P95 > 2s | 5m |
| ApiAvailabilityBurnRateHigh | critical | Multi-window burn rate | 2m |

### Health Alerts

| Alert | Severity | Condition | For |
|---|---|---|---|
| ReadyzProbeFailure | warning | readyz fails | 30s |
| ReadyzProbeCritical | critical | readyz fails | 45s |
| LivezProbeFailure | critical | livez fails | 15s |

### Job Alerts

| Alert | Severity | Condition | For |
|---|---|---|---|
| JobFailureRateWarning | warning | Job failure rate > 50% | 5m |
| QueueDepthBacklogWarning | warning | > 100 waiting jobs | 10m |

### Alert Routing Assumptions

Alerts use two severity tiers for routing:

- **`warning`** — Investigate during business hours. Email or Slack channel.
- **`critical`** — Page the on-call engineer immediately. PagerDuty/Opsgenie.

All alerts carry the label `service: inflect-compliance` for routing rules.
All alerts link to the dashboard via `dashboard: "/d/inflect-compliance-slos"`.

## Verification

### Validate alert rules syntax

```bash
# Using promtool (from Prometheus distribution):
promtool check rules infra/alerts/rules.yml
```

### Validate dashboard JSON

```bash
# Using Node.js:
node -e "JSON.parse(require('fs').readFileSync('infra/dashboards/grafana-api-slos.json', 'utf-8')); console.log('Valid JSON')"
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

## Observability provisioning (compose · Helm · Grafana Cloud)

The OTel/Prometheus/Tempo/Grafana stack ships in three deploy shapes
(same OTLP telemetry, different backend). See the trade-off matrix in
[`docs/observability/01-deployment-topology.md`](../docs/observability/01-deployment-topology.md#scale-out-provisioning-beyond-the-single-vm).

- **Single VM + compose** (today's prod): [`observability/docker-compose.observability.yml`](observability/docker-compose.observability.yml)
- **K8s, self-hosted** (air-gapped/on-prem): [`helm/observability/`](helm/observability/README.md) — `helm install obs infra/helm/observability`
- **K8s, managed Grafana Cloud** (lowest ops burden): [`terraform/modules/observability/`](terraform/modules/observability) — `terraform apply`, then point the app's `OTEL_EXPORTER_OTLP_ENDPOINT` at the module's `grafana_otlp_endpoint`.
