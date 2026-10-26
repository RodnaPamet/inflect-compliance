# inflect-compliance — Production Observability Stack

A self-contained metrics + traces stack for `inflect-compliance`, deployed as a
**separate docker-compose project** co-located on the application VM. It joins
the app's docker network so the app can push OpenTelemetry data to the
collector by DNS.

```
 App (docker-compose.prod.yml)
   web / worker / scheduler ──OTLP/HTTP──▶ otel-collector ──┐
                                                            │
                              metrics (Prometheus scrape) ◀─┤
                                            │               │ traces (OTLP)
                                            ▼               ▼
                                       prometheus         tempo
                                            └──────┬────────┘
                                                   ▼
                                         grafana (127.0.0.1:3001)
                                                   │
                                              Caddy reverse-proxy (prod)
```

## Components

| Service          | Image                                          | Role                                                              |
|------------------|------------------------------------------------|-------------------------------------------------------------------|
| `otel-collector` | `otel/opentelemetry-collector-contrib:0.123.0` | Single OTLP ingest gateway; fans metrics → Prometheus, traces → Tempo |
| `prometheus`     | `prom/prometheus:v3.3.0`                       | Scrapes the collector + stack; stores metrics; evaluates rules    |
| `tempo`          | `grafana/tempo:2.7.2`                          | Trace storage (OTLP gRPC ingest, local filesystem backend)        |
| `grafana`        | `grafana/grafana:11.6.0`                       | Dashboards + unified alerting; the only host-published service    |

Only Grafana publishes a host port, and only on **`127.0.0.1:3001`**. Expose it
to operators via Caddy (see below) — never bind it to `0.0.0.0`.

## Prerequisites

- The app stack (`docker-compose.prod.yml`) is already running on the VM.
- Docker Engine with the Compose v2 plugin (`docker compose`, not
  `docker-compose`).
- `wget` is present in each base image (used by healthchecks — it is, in all
  four images above).

## Deploy

### 1. Find the app's docker network name

This stack attaches to the app compose's pre-existing bridge network so the
app's `app` container can resolve `otel-collector`. The app compose declares a
network literally named `internal`; docker prefixes it with the compose
project name, so the real network is usually `inflect_internal`:

```bash
docker network ls
# look for a *_internal bridge, e.g.  inflect_internal
```

### 2. Configure environment

```bash
cd infra/observability
cp .env.example .env
$EDITOR .env
```

At minimum set:

- `APP_NETWORK_NAME` — the network name from step 1.
- `GF_SECURITY_ADMIN_PASSWORD` — a real password (the Grafana container
  refuses to start without one).
- `DEPLOYMENT_ENVIRONMENT` — `production` (or `staging` / `local`).

### 3. Start the stack

```bash
docker compose -f docker-compose.observability.yml --env-file .env up -d
```

Check health:

```bash
docker compose -f docker-compose.observability.yml ps
# all four services should report (healthy) within ~30s
```

### 4. Wire the app to push telemetry

On the **app** stack (`docker-compose.prod.yml`), set these env vars on the
`web` **and** `worker` (and `scheduler`) process — they share one image:

```dotenv
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=inflect-compliance
```

`otel-collector` resolves because both compose projects share the network from
step 1. The app uses OTLP/HTTP, hence port **4318** (gRPC would be 4317).
Recreate the app containers after changing env (`docker compose -f
docker-compose.prod.yml up -d`).

### 5. Expose Grafana via Caddy (production)

Grafana listens only on `127.0.0.1:3001`. Add a site block to the app VM's
`Caddyfile`:

```caddy
grafana.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

Reload Caddy (`docker compose -f docker-compose.prod.yml exec caddy caddy
reload --config /etc/caddy/Caddyfile`, or whatever your app stack uses). Set
`GF_SERVER_ROOT_URL=https://grafana.example.com` in this stack's `.env` and
recreate Grafana so share links and alert callbacks use the public URL.

## Verification

```bash
# Collector is healthy
docker compose -f docker-compose.observability.yml exec otel-collector \
  wget -qO- http://localhost:13133/ ; echo

# Prometheus sees all five scrape targets as UP
docker compose -f docker-compose.observability.yml exec prometheus \
  wget -qO- 'http://localhost:9090/api/v1/query?query=up'

# App metrics are flowing (non-empty result once the app serves traffic)
docker compose -f docker-compose.observability.yml exec prometheus \
  wget -qO- 'http://localhost:9090/api/v1/query?query=api_request_count_total'

# Tempo is ready
docker compose -f docker-compose.observability.yml exec tempo \
  wget -qO- http://localhost:3200/ready ; echo

# Grafana health
curl -s http://127.0.0.1:3001/api/health
```

In Grafana (`http://127.0.0.1:3001` or via Caddy) you should see three
provisioned dashboards under the *inflect-observability* folder:

- **Inflect — API Overview (RED)** — request rate, 5xx %, p95 latency.
- **Inflect — Jobs & Queues** — job rate/duration/failures, audit-stream
  delivery failures. No queue-depth panel: the app never registers its
  `job.queue.depth` gauge (nothing calls `startQueueDepthReporting`).
- **Inflect — Observability Stack Health** — collector accepted/refused
  (including `memory_limiter`'s refusals), exporter send failures,
  Prometheus TSDB head series + scrape health, target `up`.

To reload Prometheus rules after editing files under `prometheus/rules/`:

```bash
docker compose -f docker-compose.observability.yml exec prometheus \
  wget -qO- --post-data='' http://localhost:9090/-/reload
```

(`--web.enable-lifecycle` is on, so the reload endpoint works.)

## What is provisioned as code

Everything. Nothing is configured by hand in the UI:

- **Datasources** — `grafana/provisioning/datasources/datasources.yml`
  (Prometheus default + Tempo, with trace↔metrics correlation).
- **Dashboards** — `grafana/provisioning/dashboards/dashboards.yml` (file
  provider) loading `grafana/dashboards/*.json`.
- **Alert delivery** — `grafana/provisioning/alerting/contact-points.yml`
  (one webhook contact point fed by `GRAFANA_ALERT_WEBHOOK` + a notification
  policy). Alert *rules* themselves live in Prometheus
  (`prometheus/rules/alerting-rules.yml`).

## Alerting model

Alert **rules** are Prometheus-native
(`prometheus/rules/alerting-rules.yml`), in five groups:

- **stack_health** — collector/Prometheus/Tempo/Grafana down, collector
  export failures, data refused by `memory_limiter`, and a `DeadMansSwitch`
  that always fires (monitor for its *absence* downstream).
- **app_health** — high 5xx ratio, API p95 SLO breach, job failure rate, and
  the compliance-critical `AuditStreamDeliveryFailing`.
- **security_controls** — a control that stopped applying or could not be
  verified: sign-ins without session caps, a workflow context failing
  verification, a kill-switch drill that failed or proved nothing, a circuit
  breaker trip, a fan-out halted with members unattempted.
- **agentic_runs** — agentic work failing, being quarantined by the content
  guard, piling up in flight, or starting faster than it settles.
- **resource** — TSDB head series, scrape duration.

The rules and dashboards use the metric names the collector's Prometheus
exporter writes (`api_request_count_total`,
`api_request_duration_milliseconds_bucket`, a unit-`1` gauge ending
`_ratio`, ...). `tests/unit/prometheus-rules-match-emitted-metrics.test.ts`
derives those names from `src/` and fails on a rule or panel that selects
anything the stack does not export. See
`docs/observability/03-prometheus-grafana.md`.

This stack does **not** ship an Alertmanager. Delivery is via Grafana unified
alerting's provisioned webhook contact point. If you prefer Prometheus-native
routing, deploy an Alertmanager and uncomment the `alerting:` block in
`prometheus/prometheus.yml`.

> There is no disk alert: one would need `node_exporter` metrics
> (`node_filesystem_*`), and this stack does not deploy node_exporter. Disk
> pressure is visible operationally via `df` on the VM. There is no
> queue-depth alert either, for the reason under the dashboards above.

## Per-environment notes

| Setting                      | local            | staging          | production        |
|------------------------------|------------------|------------------|-------------------|
| `DEPLOYMENT_ENVIRONMENT`     | `local`          | `staging`        | `production`      |
| `OTEL_SAMPLING_PERCENTAGE`   | `100` (see all)  | `50`             | `20` (cost/volume)|
| `PROM_RETENTION`             | `7d`             | `15d`            | `30d`+            |
| `TEMPO_RETENTION`            | `24h`            | `72h`            | `168h`+           |
| Grafana exposure             | `127.0.0.1:3001` direct | Caddy, IP-allowlisted | Caddy + SSO/auth |
| `GRAFANA_ALERT_WEBHOOK`      | blank (no paging)| test channel     | real on-call route|

Other production guidance:

- **Sampling** is *head* sampling in the collector. Lower
  `OTEL_SAMPLING_PERCENTAGE` if trace volume strains Tempo or the VM.
- **Retention** is bounded by VM disk. The `prometheus-data` and `tempo-data`
  named volumes grow with retention — size the VM disk accordingly and watch
  the *Observability Stack Health* dashboard.
- **Long-term storage** — for retention beyond the VM's disk budget,
  uncomment the `remote_write` block in `prometheus/prometheus.yml` and point
  it at Grafana Cloud / Mimir / Thanos.
- **Resource limits** — `mem_limit` / `cpus` in the compose file are sized for
  a modest single VM. Raise the collector and Prometheus limits first if you
  scale ingest.

## Teardown

```bash
# Stop, keep data volumes
docker compose -f docker-compose.observability.yml --env-file .env down

# Stop and DELETE all metrics/traces/dashboards
docker compose -f docker-compose.observability.yml --env-file .env down -v
```

## File layout

```
infra/observability/
├── docker-compose.observability.yml   # the 4 services, networks, volumes
├── .env.example                       # env-var template (placeholders only)
├── README.md                          # this file
├── otel-collector/
│   └── config.yaml                    # collector pipelines
├── prometheus/
│   ├── prometheus.yml                 # scrape config + rule_files
│   └── rules/
│       ├── recording-rules.yml        # pre-computed RED / job PromQL
│       └── alerting-rules.yml         # stack / app / resource alerts
├── tempo/
│   └── tempo.yaml                     # trace storage + retention
└── grafana/
    ├── provisioning/
    │   ├── datasources/datasources.yml
    │   ├── dashboards/dashboards.yml
    │   └── alerting/contact-points.yml
    └── dashboards/
        ├── inflect-api-overview.json
        ├── inflect-jobs-and-queues.json
        └── observability-stack-health.json
```
