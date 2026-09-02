# Service Level Objectives (SLOs)

> inflect-compliance — Production Operational Standards
>
> Epic 19: Observability & Operational Readiness

---

## Overview

This document defines measurable Service Level Objectives (SLOs) for the inflect-compliance platform. Each SLO specifies:

- **Exact objective** — the target value
- **Measurement formula** — how the SLO is computed
- **Scope** — what traffic/operations count
- **Exclusions** — what is intentionally excluded
- **Time window** — rolling evaluation period
- **Telemetry source** — which metric(s) power the measurement
- **Alert threshold** — when human attention is needed

These SLOs are designed to be immediately measurable using the OTel metrics
emitted by `src/lib/observability/metrics.ts` through `withApiErrorHandling`.

---

## Telemetry Inventory

The following OTel metrics are emitted at every API request completion:

| Metric Name | Type | Labels | Source |
|---|---|---|---|
| `api_request_count` | Counter | `http_method`, `http_route`, `http_status_code` | `metrics.ts` → `withApiErrorHandling` |
| `api_request_duration` | Histogram (ms) | `http_method`, `http_route`, `http_status_code` | `metrics.ts` → `withApiErrorHandling` |
| `api_request_errors` | Counter | `http_method`, `http_route`, `error_code` | `metrics.ts` → `withApiErrorHandling` |

> **Note**: OTel metric names use dots (`api.request.count`) but Prometheus
> convention converts these to underscores (`api_request_count`). All PromQL
> in this document uses the Prometheus-convention names.

### Health probes (separate from API SLO traffic):

| Endpoint | Purpose | Metric Coverage |
|---|---|---|
| `GET /api/livez` | Process liveness | HTTP status only (no OTel metrics) |
| `GET /api/readyz` | Dependency readiness | HTTP status + structured JSON checks |
| `GET /api/health` | Deprecated alias | Same as readyz |

---

## SLO 1: API Availability

### Objective

**≥ 99.9% of API requests return a non-5xx response** (rolling 30-day window).

### Measurement Formula

```
availability = 1 - (
  sum(api_request_count{http_status_code=~"5.."}) /
  sum(api_request_count)
)
```

### Scope

All HTTP requests that pass through `withApiErrorHandling` — this covers:

- All tenant-scoped API routes (`/api/t/[tenantSlug]/*`)
- All legacy API routes (`/api/controls`, `/api/risks`, etc.)
- Admin API routes (`/api/admin/*`)
- Auth API routes (`/api/auth/*`)
- SSO callback routes
- Webhook receivers (`/api/stripe/webhook`)

### Exclusions

| Excluded | Reason |
|---|---|
| `/api/livez` | Infrastructure probe — not user-facing |
| `/api/readyz` | Infrastructure probe — not user-facing |
| `/api/health` | Deprecated infrastructure probe |
| `/api/staging/seed` | Dev/staging-only endpoint |
| Client-side errors (4xx) | Expected application behavior |

### Time Window

**30-day rolling window**, evaluated continuously.

### Telemetry Source

- **Primary**: `api_request_count` counter with `http_status_code` label
- **Exporter**: OTel Collector → Prometheus remote-write
- **Dashboard**: "API Availability" panel in Grafana

### Alert Thresholds

| Severity | Condition | Window | Action |
|---|---|---|---|
| **Warning** | Availability < 99.9% (error rate > 0.1%) | 15 min | Investigate — check error logs |
| **Critical** | Availability < 99.5% (error rate > 0.5%) | 5 min | Page on-call — active incident |

### Error Budget

At 99.9% over 30 days:
- **Allowed downtime**: ~43 minutes/month
- **Allowed error count**: 1 in 1,000 requests

---

## SLO 2: API Latency — Reads (P95)

### Objective

**95th percentile of GET requests < 500ms** (rolling 30-day window).

### Why split read vs write

Reads and writes have fundamentally different cost profiles:
- Reads hit caches, denormalised columns, and read replicas. P95 < 500ms is achievable for the vast majority of read endpoints.
- Writes go through transaction commits, fan out to denormalised columns, sometimes trigger audit log writes + outbound webhook batches. A 500ms write target would be perpetually breached without delivering proportional user-experienced improvement.

OI-3 spec defines the two targets separately for exactly this reason. The previous single P95 SLO is split into SLOs 2a (reads) and 2b (writes); both are evaluated against `api_request_duration` filtered by HTTP method.

### Measurement Formula

```promql
p95_read_latency = histogram_quantile(
  0.95,
  sum by (le) (rate(api_request_duration_bucket{http_method=~"GET|HEAD"}[5m]))
)
```

### Scope

GET + HEAD requests through `withApiErrorHandling`. Per-route exclusions identical to the write SLO below.

### Exclusions

| Excluded | Reason |
|---|---|
| `/api/livez`, `/api/readyz`, `/api/health` | Infrastructure probes — trivially fast (would dominate the histogram and skew P95 down) |
| Report generation endpoints (`/api/t/*/reports/export`) | Expected to be slow (PDF generation on demand) |
| File upload endpoints (`/api/t/*/files`) | POST-only, but if a HEAD lands here it's bound by upload size |

### Telemetry Source

- **Primary**: `api_request_duration` histogram, filtered by `http_method=~"GET|HEAD"`
- **Dashboard**: `inflect-app-overview` (panel 5: "Latency percentiles")
- **Alert**: `ApiP95LatencyWarning` (>500ms 10m), `ApiP95LatencyCritical` (>2000ms 5m). Both currently match on full traffic; future PR splits the alert by method to avoid write-induced false positives on the read SLO.

---

## SLO 2b: API Latency — Writes (P95)

### Objective

**95th percentile of state-mutating requests < 1000ms** (rolling 30-day window).

### Measurement Formula

```promql
p95_write_latency = histogram_quantile(
  0.95,
  sum by (le) (rate(api_request_duration_bucket{http_method=~"POST|PUT|PATCH|DELETE"}[5m]))
)
```

### Scope

All POST/PUT/PATCH/DELETE through `withApiErrorHandling`.

### Exclusions

Same as SLO 2 (reads), plus:

| Excluded | Reason |
|---|---|
| `/api/auth/*` | NextAuth flows — bound by external IdP redirect, not server latency |
| `/api/stripe/webhook`, `/api/storage/av-webhook` | Inbound webhook receivers — bound by sender retry, not server latency |

### Telemetry Source

- **Primary**: `api_request_duration` histogram, filtered by `http_method=~"POST|PUT|PATCH|DELETE"`
- **Dashboard**: `inflect-app-overview` (panel 5: "Latency percentiles") — split by method via the panel's `legendFormat`
- **Alert**: same thresholds as SLO 2 today; per-method split is a follow-up

---

## SLO 3: API Error Rate

### Objective

**< 1% of API requests result in a 5xx error** (rolling 30-day window).

### Measurement Formula

```
error_rate = (
  sum(rate(api_request_count{http_status_code=~"5.."}[5m])) /
  sum(rate(api_request_count[5m]))
) * 100
```

### Scope

Same as SLO 1.

### Exclusions

Same as SLO 1.

### Time Window

**30-day rolling window**, evaluated over 5-minute rate windows.

### Telemetry Source

- **Primary**: `api_request_count` counter, partitioned by `http_status_code`
- **Secondary**: `api_request_errors` counter for error-code breakdown
- **Dashboard**: "Error Rate" panel in Grafana

### Alert Thresholds

| Severity | Condition | Window | Action |
|---|---|---|---|
| **Warning** | Error rate > 1% | 10 min sustained | Investigate error logs |
| **Critical** | Error rate > 5% | 5 min sustained | Page on-call — significant breakage |

---

## SLO 4: Health Check Availability

### Objective

**Readiness probe (`/api/readyz`) returns 200 at least 99.95% of the time** (rolling 7-day window).

### Measurement Formula

```
readyz_availability = (
  sum(probe_success{instance="inflect-compliance", job="readyz"}) /
  count(probe_success{instance="inflect-compliance", job="readyz"})
)
```

If using synthetic monitoring (e.g., Grafana Synthetic Monitoring, Blackbox Exporter):

```
readyz_availability = avg_over_time(probe_success{job="readyz"}[7d])
```

### Scope

- `GET /api/readyz` — checks PostgreSQL and Redis (when configured)
- `GET /api/livez` — checks process responsiveness

### Exclusions

None — if the probe fails, the service is unhealthy.

### Time Window

**7-day rolling window** — tighter window because probe failures indicate infrastructure problems, not traffic-dependent issues.

### Telemetry Source

- **Primary**: External synthetic monitoring (Blackbox Exporter or platform probe)
- **Secondary**: Container orchestrator health check results (K8s, Docker, Fly.io)
- **Dashboard**: "Health Check Status" panel in Grafana

### Alert Thresholds

| Severity | Condition | Window | Action |
|---|---|---|---|
| **Warning** | 2 consecutive readyz failures | 30s interval | Check DB/Redis connectivity |
| **Critical** | 3+ consecutive readyz failures | 45s | Page on-call — service degraded |
| **Critical** | Any livez failure | Immediate | Container should be restarted |

---

## SLO 5: Repository latency (Epic OI-3)

### Objective

**Repository-method P95 < 100ms** for all OI-3-instrumented methods (rolling 7-day window).

### Why

Repository methods are the dominant cost in API latency. A repo P95 over 100ms typically explains a corresponding API P95 spike. Tracking the repo SLO independently lets us catch DB-side regressions (slow query, missing index, lock contention) before they break the API SLO.

### Measurement Formula

```promql
repo_p95 = histogram_quantile(
  0.95,
  sum by (le, repo_method) (rate(repo_method_duration_bucket[5m]))
)
```

### Scope

All methods wrapped with `traceRepository(...)` from `src/lib/observability/repository-tracing.ts`. Today: 12 methods across `RiskRepository`, `ControlRepository`, `EvidenceRepository`. Future PRs extend coverage.

### Telemetry Source

- **Metric**: `repo_method_duration` histogram (Epic OI-3 part 2)
- **Dashboard**: `inflect-database` (panel 5: "Repo duration percentiles", panel 7: "Top slow repo methods (P95)")
- **Alert**: indirect — `DatabaseConnectionPoolExhausted` fires on Prisma error rate, which correlates with sustained slow queries

---

## SLO 6: RPO — Recovery Point Objective

### Objective

**Maximum 24 hours of data loss** in a worst-case recovery scenario.

### Why 24 hours

This is what today's architecture delivers, not what a compliance SaaS should
aim for. Production is one GCP VM whose 50 GB persistent disk is snapshotted
once a day at 02:00 UTC by the `inflect-daily-snapshot` policy; the recovery
point is always the most recent completed snapshot.

Tightening it does **not** require cross-region replication. The cheapest rung
is Postgres WAL archiving (`archive_mode=on`) plus a scheduled logical dump off
the VM, which would bring the recovery point to minutes. That work is not done:
`infra/scripts/pg-dump-to-s3.sh` exists in this repo but is not deployed —
`/opt/inflect/infra` does not exist on the host, neither `pg_dump` nor `aws` is
installed there, and nothing schedules it.

Earlier revisions of this document claimed **1 hour**, on the strength of "RDS
continuous transaction log shipping". There is no RDS. See
[#2226](https://github.com/RodnaPamet/inflect-compliance/issues/2226).

### How it's met

| Layer | Mechanism | Recoverable to |
|---|---|---|
| Postgres (`postgres:16-alpine` container) | Crash-consistent daily disk snapshot only. `archive_mode=off`; `pg_stat_archiver.archived_count` is 0 for the container's lifetime. No WAL archive, no replica, no replication slot. | The 02:00 UTC snapshot moment, ≤ 24h old |
| GCP persistent-disk snapshots | Policy `inflect-daily-snapshot`: daily 02:00 UTC, `maxRetentionDays: 14`, `storageLocations: [eu]` (multi-region, so a snapshot survives loss of `europe-west1-b`), `guestFlush: false`, `onSourceDiskDelete: KEEP_AUTO_SNAPSHOTS` | Same snapshot moment |
| Encrypted column data | Same disk snapshot — the ciphertext is in the same volume | Same |
| Evidence / uploaded files | Same disk snapshot. `STORAGE_PROVIDER=local`; the files live on a Docker volume on that one disk, not in object storage. | Same |
| Secrets | `/opt/inflect/.env.prod` on the same disk. There is no managed secret store and therefore no independent recovery window. | Same |

**`guestFlush: false` means the snapshot is crash-consistent, not
application-consistent** — the filesystem is not quiesced, so Postgres replays
WAL on start. That is normally safe, and it has now been *observed* safe: see
Verification.

### Verification

The restore drill for this database **lives in another repository**:
`RodnaPamet/agri-saas`, workflow `restore-test.yml`, matrix leg
`Restore Test (inflect-compliance)`. It asserts the `inflect-daily-snapshot`
schedule is attached to disk `inflect-compliance`, restores the newest READY
snapshot to a temporary disk, starts Postgres against it and validates.

Observed successful restores of production snapshots:

| Date | Trigger |
|---|---|
| 2026-08-01 | manual (operator) |
| 2026-08-21 | `workflow_dispatch` |
| 2026-09-01 | `workflow_dispatch` |

The 2026-09-01 run reported: Postgres accepted connections after WAL recovery
(2 s), 258 `_prisma_migrations` applied, 167 `pg_policies` `tenant_isolation`
rows, `app_user` present. So crash-consistency is survivable by measurement
rather than by argument.

> **⚠ No SCHEDULED run of that drill has ever succeeded.** All three restores
> above were started by a human. The 2026-09-01 scheduled attempt died on
> `ZONE_RESOURCE_POOL_EXHAUSTED`; agri-saas has since added a zone fallback,
> whose first unattended test is 2026-10-01. A drill that only passes when
> somebody presses the button is one forgetful month from validating nothing.

Because that drill is in a different repository, **nothing in this one used to
know whether it still ran** — its own workflow header notes it may be dropped if
this repo grows its own. `.github/workflows/restore-drill-freshness.yml` now
queries it weekly and fails if no successful `Restore Test (inflect-compliance)`
job has completed within `MAX_AGE_DAYS` (45).

### Risk

All production data — database, evidence uploads and secrets — is on a single
50 GB persistent disk in `europe-west1-b`. Snapshots are stored in the `eu`
multi-region, so they survive loss of the zone or of the disk; recovery from
them is manual and has never been performed under incident conditions, only as
a drill.

## SLO 7: RTO — Recovery Time Objective

### Objective

**Service restored within 4 hours** of a critical incident.

### Why 4 hours

It aligns with the 4-hour MTTR most enterprise SaaS contracts allow for
critical incidents, and it is a realistic floor for this topology: detect,
triage, restore a disk snapshot to a new disk, attach it, bring the Compose
stack up, smoke test.

### Recovery scenarios mapped to RTO

Production is a single VM running Docker Compose, deployed by Watchtower pulling
`ghcr.io/rodnapamet/inflect-compliance:latest`. There is no Kubernetes, no
multi-AZ failover and no load balancer in front of it, so the scenarios below
are the real ones.

| Scenario | Mechanism | Estimated RTO |
|---|---|---|
| Container crash | Compose `restart` policy | seconds |
| Bad image | Pin the previous GHCR tag and `docker compose up -d` | 5–15 minutes |
| App bug requiring a patched build | Merge, wait for `ghcr-publish`, let Watchtower pull (60 s poll) | 20–40 minutes |
| Database corruption | Restore the newest `inflect-daily-snapshot` to a new disk, attach, start Postgres, verify | 60–120 minutes, **untested under incident conditions** |
| VM loss | Create a new VM from a snapshot-derived disk, restore `/opt/inflect/`, start the stack | 2–4 hours |
| Zone loss (`europe-west1-b`) | Same, in another zone — snapshots are `eu` multi-region so they remain readable | 2–4 hours |
| Loss of `DATA_ENCRYPTION_KEY` | **Unrecoverable.** The master KEK lives only in `/opt/inflect/.env.prod` on the production disk; there is no managed secret store and no independent copy. A snapshot that predates the loss is the only route. | hours-to-days; may exceed RTO |

### Verification

- **Detection** is by alerting on the metrics described in this document. There
  is no PagerDuty integration — earlier revisions claimed one; `infra/alerts/`
  is an in-cluster Alertmanager config with no cluster to run in.
- **The restore mechanism is exercised** by the agri-saas drill described under
  SLO 6 — a snapshot-to-working-Postgres restore, which is the 60–120 minute
  row above. What it does not exercise is the rest of the scenario: attaching
  the disk to a production VM, restoring `/opt/inflect/`, and bringing the
  stack up.
- **The runbook** is [`docs/incident-response.md`](incident-response.md).

### Risk

The RTO assumes an operator is available. There is no on-call rotation tooling
and no paging path, so out-of-hours detection depends on somebody looking. The
end-to-end VM-rebuild path has never been walked.

## SLO Summary Table

| SLO | Target | Window | Primary Metric / Mechanism |
|---|---|---|---|
| API Availability | ≥ 99.9% | 30 days | `api_request_count` |
| API Latency — Reads (P95) | < 500ms | 30 days | `api_request_duration` (GET/HEAD) |
| API Latency — Writes (P95) | < 1000ms | 30 days | `api_request_duration` (POST/PUT/PATCH/DELETE) |
| API Error Rate | < 1% | 30 days | `api_request_count` |
| Health Check Availability | ≥ 99.95% | 7 days | Synthetic probe of `/api/livez` |
| Repository Latency (P95) | < 100ms | 7 days | `repo_method_duration` (OI-3 part 2) |
| RPO (Recovery Point) | ≤ 24 hours | continuous | Daily GCP disk snapshot; restore drill in `RodnaPamet/agri-saas` |
| RTO (Recovery Time) | ≤ 4 hours | per incident | Re-pin GHCR tag / restore disk snapshot / runbook |

---

## Load-Test Validation of SLOs

The four SLOs above are **production targets** measured against live OTel
telemetry. The k6 scenarios in `tests/load/` are **synthetic validators**
that exercise the same code paths under controlled load to surface
regressions *before* they reach production. Together they form the
performance-governance loop:

```
production OTel  ──→  SLOs (this doc)  ──→  k6 thresholds  ──→  CI smoke
       ↑                                                              ↓
       └──────────── monthly full-baseline runs ←────────────────────┘
```

### Critical user journeys → k6 scenarios → SLOs

| Critical journey                   | k6 scenario             | Validates SLO        |
|------------------------------------|-------------------------|----------------------|
| Cold credentials login             | `tests/load/auth.js`    | SLO 1, 2, 3          |
| Authenticated controls/risks/evidence list reads | `tests/load/lists.js`   | SLO 1, 2, 3          |
| Control creation + evidence upload | `tests/load/mutations.js` | SLO 1, 2, 3        |

`/api/livez` and `/api/readyz` (SLO 4) are not k6-tested — they're the
job of synthetic probes (Blackbox Exporter or platform health checks).

### Per-scenario metric → SLO mapping

| k6 scenario      | k6 metric (tagged)                                    | Maps to        | What it tells you                        |
|------------------|-------------------------------------------------------|----------------|------------------------------------------|
| auth.js          | `http_req_duration{step:csrf}`                        | SLO 2          | CSRF endpoint p95.                       |
| auth.js          | `http_req_duration{step:login}`                       | SLO 2 (write)  | bcrypt-bound login latency.              |
| auth.js          | `http_req_duration{step:session}`                     | SLO 2          | Session-verify latency.                  |
| auth.js          | `auth_full_login_ms` (custom Trend)                   | SLO 2 (E2E)    | End-to-end login transaction.            |
| auth.js          | `http_req_failed{step:*}`                             | SLO 1, 3       | Per-step error rate.                     |
| lists.js         | `http_req_duration{endpoint:controls\|risks\|evidence}` | SLO 2 (read) | Per-endpoint read p95.                   |
| lists.js         | `http_req_failed{type:list}`                          | SLO 1, 3       | Aggregate read error rate.               |
| lists.js         | `list_success_rate` (custom Rate)                     | SLO 1          | Aggregate availability across reads.     |
| mutations.js     | `http_req_duration{op:create_control}`                | SLO 2 (write)  | Control INSERT + audit p95.              |
| mutations.js     | `http_req_duration{op:upload_evidence}`               | SLO 2 (write)  | File-write + 2 INSERTs + audit p95.      |
| mutations.js     | `http_req_failed{op:*}`                               | SLO 1, 3       | Per-op error rate.                       |
| mutations.js     | `mutation_loop_ms` (custom Trend)                     | SLO 2 (E2E)    | Full create + upload transaction.        |

### Why k6 thresholds are not identical to production SLOs

The production p95 SLO is **< 500ms across ALL API requests**. The k6
thresholds are intentionally **looser**:

| Reason                                                                                    | Effect                                            |
|-------------------------------------------------------------------------------------------|---------------------------------------------------|
| k6 runs against a single CI runner (4 vCPU, 16 GB RAM); production runs multi-replica.    | ~2× absolute latency floor.                       |
| k6 hits a freshly seeded DB with cold caches; production has warm caches + connection pools. | First-iteration latency dominated by cold paths. |
| Mutations write to RLS + audit log + encryption — all serialized at the row level.        | Mutation budget naturally wider than read budget. |
| The smoke profile (10 VUs × 30s) yields ~200 samples per op; production p95 is computed over millions. | A single retry can move a k6 rate noticeably.    |

The k6 budgets are calibrated as **regression detectors**, not as the
SLO itself: a breach implies a 2–3× regression that will *also* breach
the production SLO once the change ships and the cache warms up. They
are deliberately not a substitute for the production SLO measurement.

### CI smoke vs full-baseline thresholds

There are two performance gates with different jobs:

#### CI smoke — runs on every PR

`Load Smoke (k6)` job in `.github/workflows/ci.yml`. **10 VUs × 30s**.
Runs `tests/load/mutations.js` only — that's where regressions are most
likely (RLS + audit + encryption + storage all interact on the write
path). Auth and read-path baselines stay in the on-demand workflow.

| Metric                                       | CI smoke gate    | Behavior on breach |
|----------------------------------------------|------------------|--------------------|
| `http_req_failed{op:create_control}`         | rate < 2%        | **PR CI fails**    |
| `http_req_failed{op:upload_evidence}`        | rate < 2%        | **PR CI fails**    |
| `http_req_duration{op:create_control}`       | p95 < 1500ms     | **PR CI fails**    |
| `http_req_duration{op:create_control}`       | p99 < 3000ms     | **PR CI fails**    |
| `http_req_duration{op:upload_evidence}`      | p95 < 2000ms     | **PR CI fails**    |
| `http_req_duration{op:upload_evidence}`      | p99 < 4000ms     | **PR CI fails**    |
| `mutation_loop_ms`                           | p95 < 3000ms     | **PR CI fails**    |
| `checks{check:control_created}`              | rate > 98%       | **PR CI fails**    |
| `checks{check:evidence_uploaded}`            | rate > 98%       | **PR CI fails**    |

Sized for signal-per-dollar: ~5 minutes added to PR CI; ~200 samples
per op (enough for p95 to be meaningful without flaking).

#### Full baselines — manual `workflow_dispatch` + nightly main smoke

`Load Test (k6)` workflow at `.github/workflows/load-test.yml`. Runs
all three scenarios. The script-level thresholds in each scenario apply;
they are tighter than the CI smoke because the sample size is larger.

| Scenario     | Profile          | Tightest threshold                              | Closest production SLO                |
|--------------|------------------|-------------------------------------------------|---------------------------------------|
| auth.js      | 50 / 100 / 200 VUs × 2m | `http_req_duration{step:login}` p95 < 1500ms | SLO 2 (write — bcrypt is the floor)   |
| auth.js      | "                | `auth_full_login_ms` p95 < 2000ms                | SLO 2 (E2E)                           |
| auth.js      | "                | `http_req_failed{step:*}` rate < 1%              | SLO 1 + 3                             |
| lists.js     | 50 / 100 / 200 VUs × 2m | `http_req_duration{endpoint:*}` p95 < 800ms   | SLO 2 (read — looser than 500ms ceiling because of cold-cache + tenant RLS overhead in test env) |
| lists.js     | "                | `http_req_failed{type:list}` rate < 1%          | SLO 1 + 3                             |
| mutations.js | 50 / 100 / 200 VUs × 2m | `http_req_duration{op:create_control}` p95 < 1500ms | SLO 2 (write)                  |
| mutations.js | "                | `http_req_duration{op:upload_evidence}` p95 < 2000ms | SLO 2 (write — multipart + storage) |
| mutations.js | "                | `http_req_failed{op:*}` rate < 2%                | SLO 1 + 3                             |

Run cadence:
- **PR**: CI smoke (mutations only, 10 VUs × 30s) — automatic.
- **Nightly main**: 25 VUs × 1m smoke across both auth + lists for trend tracking — automatic via cron in `load-test.yml`. Failures don't block deploys but populate the trend graph.
- **On-demand**: 50/100/200 VU baselines via manual `workflow_dispatch`. Run before a release, after a major hot-path change, or when investigating a production p95 drift.

### How to read a k6 result

A k6 run produces three things you care about:

1. **Pass/fail status** — exit code 0 if every threshold held; non-zero if any breached. CI keys off this. The console output ends with either nothing (pass) or `error msg="thresholds on metrics '...' have been crossed"`.

2. **Per-metric stats** — for each metric the run prints `avg / min / med / max / p(90) / p(95) / p(99)`. Read **p(95)** for SLO comparison; p(99) is your tail-latency regression detector. Don't trust avg — it's pulled around by outliers in either direction.

3. **req/s and VUs** — `http_reqs / iterations` rate at the end shows sustained throughput. Compare against the previous baseline run for the same VU count: a drop of >15% req/s under the same VU is a throughput regression even if latency thresholds pass.

| Number you see       | What it means                                                  | Compare to                              |
|----------------------|----------------------------------------------------------------|-----------------------------------------|
| `p(95)` per metric   | 95th-percentile latency under the test load                    | The threshold for that metric.          |
| `http_req_failed`    | Fraction of requests that returned ≥ 4xx OR network-failed     | The error-rate threshold (1% or 2%).    |
| `checks` rate        | Fraction of correctness assertions that passed                 | Should be ~100%; <98% means broken.     |
| `http_reqs/s`        | Sustained throughput over the steady-state window              | Previous baseline run at same VU count. |
| `iterations/s`       | VU-loop completion rate                                        | Same.                                   |

The `tests/load/results/*-summary.json` files written by `handleSummary`
carry the full structured output for diff-against-baseline tooling.

### Operating procedure

#### When CI smoke fails on a PR

The Load Smoke job exited non-zero. Open the artifact at
`load-smoke-results-<run_id>` and the GitHub Actions log:

1. Identify the breached threshold from the trailing `error msg=...` line.
2. Pull `mutations-summary.json` from the artifact; the metric structure
   gives you avg/p95/p99 directly.
3. Compare against the most recent successful main-branch run's artifact
   (retention is 14 days). Look for the same metric.
4. Decide:
   - **Real regression** — the PR introduced a slower path. Fix or revert. Latency-cliff regressions usually trace to: a new sync DB call inside a loop, a missing index, a serialised audit-log write, or unintended encryption of a hot field.
   - **Flake** — single attempt only, no other CI signal. Re-run the job. Two failures in a row = treat as real.
   - **Infra noise** — the runner was on a slow shared VM. Check the same job's runtime: if `Wait for /api/health` took >30s, the runner was congested. Re-run.

If you must merge a PR with the smoke job failing (e.g. the regression is upstream of your change), document the reason in the PR description and open an issue tagged `slo:investigate`.

#### When the full baseline misses an SLO

The 50/100/200 VU `workflow_dispatch` run breached a threshold tighter than the CI smoke:

1. Re-run the same scenario against staging or another runner to rule out CI variance.
2. Pull production OTel data (`api_request_duration` histogram for the same `http_route`) for the prior week. If production p95 is also drifting → real regression in the running deploy. If production is healthy → CI-environment-only issue.
3. Open an SLO-watch ticket. Decide: tighten the k6 threshold (and fix the cause), refactor the hot path, or escalate the SLO target if user-facing expectations have shifted.

#### Updating thresholds

**Loosening a k6 threshold is a regression signal.** Don't do it to make a red CI green. The flow:

1. If the threshold is unrealistic for the workload, change the *production SLO* in this doc first. The k6 threshold then follows.
2. If the threshold is realistic but the code regressed, fix the code.
3. If neither — investigate before relaxing. A loosened threshold without an SLO update silently hides regressions from future PRs.

The k6 thresholds are calibrated as a >2× margin against the production
SLO. Tightening them as the codebase improves (and the absolute latency
floor drops) is the long-term direction; loosening them is a last resort.

### Cross-references

- **k6 runbook**: [`tests/load/README.md`](../tests/load/README.md) — install, env, run commands, threshold tables.
- **Workflows**:
  - PR smoke: `Load Smoke (k6)` job in `.github/workflows/ci.yml`.
  - Manual + nightly: `.github/workflows/load-test.yml`.
- **Production telemetry**: see SLO 1–3 above for the OTel metric names and PromQL.

---

## Metric Dependencies

### Available Today (Phase 1)

| Metric | Status | Source |
|---|---|---|
| `api_request_count` | ✅ Emitted | `metrics.ts` via `withApiErrorHandling` |
| `api_request_duration` | ✅ Emitted | `metrics.ts` via `withApiErrorHandling` |
| `api_request_errors` | ✅ Emitted | `metrics.ts` via `withApiErrorHandling` |
| Structured JSON logs | ✅ Emitted | Pino logger → stdout |

### Required Infrastructure

| Component | Purpose | Status |
|---|---|---|
| OTel Collector | Receives OTLP metrics/traces from the app | ⏳ Deploy alongside app |
| Prometheus | Stores metrics from OTel Collector | ⏳ Deploy alongside app |
| Grafana | Dashboard visualization and alerting | ⏳ Deploy alongside app |
| Blackbox Exporter | Synthetic health probe monitoring | ⏳ Optional |

### Pipeline

```
App (metrics.ts)
  → OTLP HTTP (:4318)
    → OTel Collector
      → Prometheus remote-write
        → Grafana (dashboards + alerts)
```

---

## Revision History

| Date | Change |
|---|---|
| 2026-04-18 | Initial SLO definitions (Epic 19 Phase 2) |
| 2026-04-27 | Epic OI-3: split SLO 2 into reads (<500ms) and writes (<1000ms); add SLO 5 (repository P95 from `repo_method_*` metrics); add SLO 6 (RPO 1h, met by RDS PITR + monthly `restore-test.sh`); add SLO 7 (RTO 4h, met by `helm rollback` / `restore-db-instance` paths documented in `docs/incident-response.md`) |
| 2026-04-28 | Added Load-Test Validation section: k6 scenario → SLO mapping, CI smoke vs full-baseline thresholds, operating procedure (GAP-11 closure). |
| 2026-09-02 | Rewrote SLO 6 and SLO 7 against measured production (#2226). RPO corrected **1h → 24h**: the 1-hour figure rested on RDS PITR and there is no RDS — production is one GCP VM with a daily crash-consistent disk snapshot, `archive_mode=off`, `pg_stat_archiver.archived_count` 0. RTO scenarios rewritten from Kubernetes/RDS/Secrets-Manager to the actual Compose-on-a-VM topology, including that loss of `DATA_ENCRYPTION_KEY` is unrecoverable. Verification now names the drill that actually runs — `RodnaPamet/agri-saas`, leg `Restore Test (inflect-compliance)` — with the three observed restores, and records that no *scheduled* run of it has ever succeeded. |
