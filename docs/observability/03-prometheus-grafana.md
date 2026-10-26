# 03 — Prometheus & Grafana

> What the observability stack's Prometheus and Grafana are configured to do:
> scrape targets, recording and alerting rules, retention, provisioning and
> dashboards. Every name below is read from the files it describes:
> `infra/observability/docker-compose.observability.yml`,
> `infra/observability/prometheus/prometheus.yml`,
> `infra/observability/prometheus/rules/recording-rules.yml`,
> `infra/observability/prometheus/rules/alerting-rules.yml`,
> `infra/observability/grafana/provisioning/` and
> `infra/observability/grafana/dashboards/`.

## Where it runs

Prometheus and Grafana are not in `deploy/docker-compose.prod.yml`, the
production stack. They are two of the four services in a separate Compose
project, `infra/observability/docker-compose.observability.yml`, with the OTel
Collector and Tempo. `deploy/apply.sh` does not push that project and
`deploy/check-drift.sh` does not check it, so this repository does not record
whether it runs on the production VM.

The repository's records of the running stack say it does not.
`infra/alerts/gcp-custom-metrics.yml` (verified 2026-09-24) lists the
production containers as `app`, `worker`, `caddy`, `redis`, `pgbouncer`,
`postgres`, `clamav` and `watchtower`, and found no `OTEL_*` variables on the
app container, so the app's OTel instruments export nowhere. `infra/README.md`
says the same. `deploy/caddy/Caddyfile` has no Grafana site.

So the alerting rules on this page alert nobody in production. Production's
alerts are GCP Cloud Monitoring policies: the uptime check in
`infra/alerts/external-uptime.yml` and the custom-metric policies in
`infra/alerts/gcp-custom-metrics.yml` and `infra/alerts/policies/`.

`infra/alerts/rules.yml` is a third set of Prometheus rules, with names such as
`QueueDepthBacklogCritical` and `DatabaseConnectionPoolExhausted`. This stack
does not load it: Prometheus reads only
`infra/observability/prometheus/rules/*.yml`.

## Prometheus

The `prometheus` service: image `prom/prometheus:v3.3.0`, container
`obs-prometheus`, on the stack's internal network (`obs-internal`) with no host
port. Its TSDB is the named volume `obs-prometheus-data`, mounted at
`/prometheus`. It runs with:

- `--storage.tsdb.retention.time=${PROM_RETENTION:-30d}`
- `--web.enable-lifecycle`
- `mem_limit: 1g`, `cpus: 1.0`

From `prometheus.yml`:

- `scrape_interval: 30s`, `scrape_timeout: 10s`, `evaluation_interval: 30s`
- `external_labels: { monitor: inflect-observability }`
- `rule_files: [/etc/prometheus/rules/*.yml]`, mounted read-only from
  `infra/observability/prometheus/rules/`
- No `alerting:` block. The Alertmanager section is commented out.
- A commented-out `remote_write:` block that reads `PROM_REMOTE_WRITE_URL`, and
  `PROM_REMOTE_WRITE_USERNAME` / `PROM_REMOTE_WRITE_PASSWORD` for basic auth.

**One instance, not HA.** The app's metric labels are kept small on purpose.
`normalizeRoute()` in `src/lib/observability/metrics.ts` turns ids and tenant
slugs in a route into placeholders, and the tenant is never a metric label. A
second replica, Thanos or Mimir would add parts to shorten a metrics gap that a
restart on a persistent volume already keeps short.

## Scrape targets

Five jobs, all static. The app is not one of them: it pushes OTLP to the
collector, and the collector exposes the app's metrics on `:8889`.

| Job | Target | `component` label |
|-----|--------|-------------------|
| `otel-collector-app-metrics` | `otel-collector:8889` | `app` |
| `otel-collector-self` | `otel-collector:8888` | `collector` |
| `prometheus` | `localhost:9090` | `prometheus` |
| `grafana` | `grafana:3000/metrics` | `grafana` |
| `tempo` | `tempo:3200/metrics` | `tempo` |

## Recording rules

`recording-rules.yml`, four groups, each evaluated every 30 seconds. Every rule
uses a 5-minute rate window.

| Group | Rule | What it computes |
|-------|------|------------------|
| `inflect_api_red` | `job:api_request:rate5m` | requests per second, by `service_name` |
| | `job:api_request_errors:rate5m` | errors per second (`api_request_errors_total`), by `service_name` |
| | `job:api_request:error_ratio5m` | errors / requests, by `service_name` |
| | `job:api_request_duration_ms:p95` | p95 request duration in ms, by `service_name` |
| | `job:api_request_duration_ms:p99` | p99 request duration in ms, by `service_name` |
| | `job:api_request_duration_ms:mean5m` | mean request duration in ms, by `service_name` |
| `inflect_repo` | `job:repo_method:rate5m` | repository calls per second |
| | `job:repo_method:error_ratio5m` | repository errors / calls |
| | `job:repo_method_duration_ms:p95` | p95 repository call duration in ms |
| `inflect_jobs` | `job:job_execution:rate5m` | job executions per second |
| | `job:job_execution:failure_ratio5m` | executions with `status="error"` / all executions |
| | `job:job_execution_duration_ms:p95` | p95 job duration in ms |
| | `job:job_queue_depth:max` | `max by (queue) (job_queue_depth)` |
| `inflect_audit_stream` | `job:audit_stream_delivery_failures:rate5m` | audit-stream batch delivery failures per second |

Three of these do not measure what their names say. Each was checked against
the labels `src/lib/observability/metrics.ts` writes; the collector's
Prometheus exporter turns a dotted OTel attribute into an underscored label.

- **`job:job_execution:failure_ratio5m` selects no series.** It filters on
  `status="error"`. The app labels job executions `job.status`, with values
  `success` and `failure`, so the label in Prometheus is `job_status`. The
  numerator matches nothing, the rule returns no result, and the alert
  `JobFailureRateHigh` built on it cannot fire.
- **`job:job_queue_depth:max` mixes the queue's states.** The app's gauge
  carries `queue.name` and `queue.state` (`waiting`, `active`, `delayed`,
  `failed`). `max by (queue)` groups on a label that does not exist, so it
  returns one series: the largest of the four states, not the waiting count.
  `JobQueueDepthGrowing` uses the same expression.
- **The "5xx" ratio counts every thrown error.** `api_request_errors_total`
  counts `recordRequestError()` calls. `withApiErrorHandling`
  (`src/lib/errors/api.ts`) makes one for every error a handler throws,
  whatever its status, so 4xx errors count too. That applies to
  `job:api_request:error_ratio5m`, to the alert `ApiHigh5xxRatio` and to the
  dashboard's "API error % (5xx ratio)" panel.

## Alerting rules

`alerting-rules.yml`, three groups, twelve rules. Prometheus evaluates them.
With no `alerting:` block in `prometheus.yml`, a firing alert reaches nothing
outside Prometheus's own alerts page. Grafana can show these rules but does not
route them: its provisioned contact point and notification policy apply only to
alert rules created in Grafana, and none is provisioned.

| Group | Alert | Fires when | `for` | Severity |
|-------|-------|------------|-------|----------|
| `stack_health` | `DeadMansSwitch` | always (`vector(1)`) | — | warning |
| | `ObservabilityTargetDown` | `up == 0` for one of the five scrape jobs | 5m | critical |
| | `CollectorExportFailures` | the collector's exporter send failures (spans or metric points) are above 0 | 10m | warning |
| | `CollectorDroppingData` | a collector processor drops spans or metric points | 10m | warning |
| `app_health` | `ApiHigh5xxRatio` | `job:api_request:error_ratio5m > 0.05` | 10m | critical |
| | `ApiLatencySloBreach` | `job:api_request_duration_ms:p95 > 750` | 15m | warning |
| | `JobQueueDepthGrowing` | `max by (queue) (job_queue_depth) > 500`, and its 30-minute `deriv` is above 0 | 20m | warning |
| | `JobFailureRateHigh` | `job:job_execution:failure_ratio5m > 0.10` | 15m | warning |
| | `AuditStreamDeliveryFailing` | `job:audit_stream_delivery_failures:rate5m > 0` | 10m | critical, plus `compliance: "true"` |
| `resource` | `PrometheusDiskFillingUp` | `node_filesystem_avail_bytes / node_filesystem_size_bytes` on `/prometheus` is below 0.15 | 30m | warning |
| | `PrometheusHeadSeriesHigh` | `prometheus_tsdb_head_series > 1500000` | 30m | warning |
| | `PrometheusSlowScrapes` | `scrape_duration_seconds > 10` | 15m | warning |

Notes on individual rules:

- **`DeadMansSwitch`** is meant to be watched from outside: if it stops
  arriving, delivery is broken. Nothing receives it today, so nothing watches
  for it either.
- **`ApiLatencySloBreach`** uses the rule file's own 750 ms. `docs/slos.md`
  sets 500 ms for reads (SLO 2) and 1000 ms for writes (SLO 2b), and the rule
  does not split by method.
- **`AuditStreamDeliveryFailing`** counts batches whose last attempt failed.
  `deliverBatch` tries each batch up to three times before it records a
  failure, so a non-zero rate means events that did not reach a tenant's SIEM.
- **`PrometheusDiskFillingUp` cannot fire.** `node_filesystem_*` comes from
  node_exporter, which the stack does not run. The rule's own description says
  so.
- **`JobFailureRateHigh`** cannot fire either, for the label reason under
  [Recording rules](#recording-rules).
- Every rule's `runbook_url` points at `docs.inflect.internal`, a placeholder
  host. No runbook exists at those addresses.

## Retention and storage

The compose file passes `PROM_RETENTION` (default `30d`) to Prometheus and
`TEMPO_RETENTION` (default `168h`) to Tempo. `infra/observability/.env.example`
sets the same two values. The stack's `.env` sets them per environment.

A Prometheus TSDB takes about this much disk:

```
bytes ≈ retention_seconds × samples_per_second × bytes_per_sample
```

with about 1.5–2 bytes per sample after compression, and
`samples_per_second = active_series / scrape_interval`. Nobody has measured the
series count. For an assumed 5,000 active series at the 30-second scrape
interval and 30 days: 2,592,000 × 167 × 2 ≈ 0.9 GB. The volume has no size of
its own: it is a Docker volume on the host's disk, so it shares that disk with
everything else on the machine.

## Grafana

The `grafana` service: image `grafana/grafana:11.6.0`, container
`obs-grafana`, on the internal network, published on `127.0.0.1:3001` only.
`mem_limit: 512m`, `cpus: 0.75`.

The compose file sets these Grafana variables:

| Variable | Value |
|----------|-------|
| `GF_SECURITY_ADMIN_USER` | `${GF_SECURITY_ADMIN_USER:-admin}` |
| `GF_SECURITY_ADMIN_PASSWORD` | required; `:?` stops the stack from starting without it |
| `GF_USERS_ALLOW_SIGN_UP` | `false` |
| `GF_AUTH_ANONYMOUS_ENABLED` | `false` |
| `GF_SERVER_ROOT_URL` | `${GF_SERVER_ROOT_URL:-http://localhost:3001}` |
| `GF_PATHS_PROVISIONING` | `/etc/grafana/provisioning` |
| `GRAFANA_ALERT_WEBHOOK` | read by the provisioned contact point |

It sets no `GF_AUTH_GOOGLE_*` variable, so Google sign-in is off. With sign-up
off too, the admin account is the only login until somebody adds users.
`04-production-hardening.md` describes SSO and roles for a production
Grafana.

Provisioning, under `infra/observability/grafana/provisioning/`:

- **`datasources/datasources.yml`.** Prometheus (`uid: prometheus`, the
  default) at `http://prometheus:9090`, and Tempo (`uid: tempo`) at
  `http://tempo:3200`. Neither is editable in the UI.
- **`dashboards/dashboards.yml`.** One file provider, `inflect-observability`,
  reading `/var/lib/grafana/dashboards` with `allowUiUpdates: false` and
  `foldersFromFilesStructure: true`. The dashboard files are all in one
  directory, so they load into Grafana's top-level folder.
- **`alerting/contact-points.yml`.** One webhook contact point,
  `default-webhook`, sending to `${GRAFANA_ALERT_WEBHOOK}`. The notification
  policy routes everything to it, grouped by `alertname` and `severity`
  (`group_wait` 30s, `group_interval` 5m, `repeat_interval` 4h; `severity =
  critical` waits 10s and repeats every 1h). The file says an empty
  `GRAFANA_ALERT_WEBHOOK` makes the send a no-op.

## Dashboards

The four files in `infra/observability/grafana/dashboards/`. Their panels read
the recording rules above, so the three notes under
[Recording rules](#recording-rules) apply to them too.

| UID | Title | Panels |
|-----|-------|--------|
| `inflect-api-overview` | Inflect — API Overview (RED) | Request rate, error % and p95 as stats; request rate by service; p95 / p99 / mean latency; error ratio by service; "RDS read-replica lag (s)", which reads `aws_rds_replica_lag_average`. Nothing produces that metric, so the panel is empty. |
| `inflect-jobs-and-queues` | Inflect — Jobs & Queues | Job rate, p95 duration, failure ratio and audit-stream failures as stats; queue depth; job rate by service; p95 duration over time; audit-stream failures over time. |
| `observability-stack-health` | Inflect — Observability Stack Health | Targets up; TSDB head series; collector exporter failures; collector accepted / refused / dropped spans and metric points; exporter failures by exporter; scrape duration by job. |
| `inflect-business-kpis` | Inflect — Business KPIs | Tenant growth, onboarding funnel, feature adoption and billing. See `06-business-kpis.md`. |

`infra/dashboards/` holds five more dashboards (`inflect-app-overview`,
`inflect-bullmq`, `inflect-database`, `inflect-redis`,
`inflect-compliance-slos`). This stack does not mount that directory. They are
for importing by hand.

## Bringing the stack up

The stack's own header gives the command:

```bash
cd infra/observability
cp .env.example .env    # then edit: at least GF_SECURITY_ADMIN_PASSWORD and APP_NETWORK_NAME
docker compose -f docker-compose.observability.yml --env-file .env up -d
```

Then:

1. **Join the app's network.** `APP_NETWORK_NAME` defaults to
   `inflect_internal`, the network the root `docker-compose.prod.yml` declares.
   `deploy/docker-compose.prod.yml` declares no networks, so for that file it
   is the Compose project's default network. Confirm it with
   `docker network ls`. See `01-deployment-topology.md`.
2. **Point the app at the collector.** Set `OTEL_ENABLED=true` and
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` in the app's
   environment, for both `app` and `worker`.
3. **Check the targets.** Prometheus's targets page should show the five jobs
   up, and the `job:*` recording rules should have data.
4. **Give the alerts somewhere to go.** As shipped they reach nobody. Either
   add an `alerting:` block and an Alertmanager to `prometheus.yml`, or write
   the rules as Grafana-managed alerts so the provisioned contact point applies,
   and set `GRAFANA_ALERT_WEBHOOK`.

Nothing in CI checks these files. `promtool check config prometheus.yml` and
`promtool check rules rules/*.yml` check them by hand.
