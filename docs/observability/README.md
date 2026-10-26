# Observability Stack — Architecture Documents

This directory holds the architecture review for the inflect-compliance
observability stack: the metrics, tracing, alerting, and dashboards
that sit alongside the application and tell operators what it is doing.

These documents describe a **decided design**, not a menu of options.
The companion deployable artifacts live at `infra/observability/` —
the docker-compose project, the OpenTelemetry Collector config, the
Prometheus scrape config and rules, the Grafana provisioning, and the
Tempo config. The docs and that config are **one deliverable**: port
numbers, service names, file paths, and metric names are kept in sync
across both. If you change a port in the compose file, the doc that
names it is wrong until you fix it too.

## Scope

The application is **already instrumented**. `src/lib/observability/`
boots the OpenTelemetry SDK (`instrumentation.ts`), defines the meters
(`metrics.ts`), ships errors to Sentry (`sentry.ts`), logs Pino JSON
to stdout (`logger.ts`), and drains telemetry on SIGTERM
(`shutdown.ts`, Epic E). The app **pushes OTLP** to a collector
endpoint when `OTEL_ENABLED=true`. It has **no `/metrics` endpoint**.

What these documents add is the **collection and storage tier** that
receives those signals: an OpenTelemetry Collector, Prometheus for
metrics, Grafana Tempo for traces, and Grafana for dashboards and
alerting.

In scope: **metrics** (the primary storage boundary — Prometheus
TSDB) and **traces** (Tempo). Out of scope: **logs** — the app
already emits structured Pino JSON to stdout where the platform log
driver captures it; Prometheus cannot store logs and Grafana Loki is
a separate, bounded initiative. See `02-otel-collector.md` for the
full justification.

## The documents

| # | File | Question it answers |
|---|------|---------------------|
| 1 | `01-deployment-topology.md` | Where does the stack run, how do signals flow through it, and how does it differ across local / staging / production? |
| 2 | `02-otel-collector.md` | How is the OpenTelemetry Collector deployed and configured — receivers, processors, exporters, pipelines, and operational safeguards? |
| 3 | `03-prometheus-grafana.md` | How are Prometheus and Grafana configured — scrape targets, recording and alerting rules, retention, dashboards — and do they run in production? |
| 4 | `04-production-hardening.md` | How is the stack secured, isolated per environment, backed up, upgraded, and monitored — and what do operators do when a component fails? |
| 5 | `05-job-tracing.md` | How does a distributed trace follow an async BullMQ job — so a slow HTTP request and the worker execution it triggers show as one trace? |
| 6 | `06-business-kpis.md` | What product / business KPIs (tenant growth, onboarding funnel, feature adoption, plan mix) are emitted, how is cardinality bounded, and how is DAU/MAU defined? |

## How they relate

```
            01 — Deployment Topology
            (the map: what runs where, what pushes vs scrapes)
                        |
        +---------------+----------------+
        |                                |
  02 — OTel Collector            03 — Prometheus & Grafana
  (the ingestion gateway:        (the storage + presentation tier:
   receives app OTLP, fans         scrapes the collector, stores
   out to Prometheus + Tempo)      metrics, evaluates alerts,
        |                          renders dashboards)
        +---------------+----------------+
                        |
            04 — Production Hardening
            (the cross-cutting concerns: security, per-environment
             isolation, retention governance, backup/restore,
             upgrades, failure runbooks, monitoring-the-monitoring)
```

Read `01` first for the shape of the system. Read `02` and `03`
together — they describe the two halves of the data path. Read `04`
last; it assumes you know the components and tells you how to run
them safely in production.

## Quick reference — components and ports

| Component | Image | Internal ports | Host-published? |
|-----------|-------|----------------|-----------------|
| OpenTelemetry Collector | `otel/opentelemetry-collector-contrib:0.123.0` | 4317 (OTLP gRPC), 4318 (OTLP HTTP), 8889 (Prometheus exporter), 8888 (self-metrics), 13133 (health) | No |
| Prometheus | `prom/prometheus:v3.3.0` | 9090 | No |
| Grafana Tempo | `grafana/tempo:2.7.2` | 3200 (query), 4317 (OTLP receive) | No |
| Grafana | `grafana/grafana:11.6.0` | 3000 (container) | `127.0.0.1:3001` only — public access via Caddy |

The application reaches the collector at `http://otel-collector:4318`
over the shared app docker network. Nothing in the stack except
Grafana is reachable from outside the VM, and Grafana only through
the existing Caddy reverse proxy with TLS.
