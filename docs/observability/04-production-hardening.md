# 04 — Production Hardening

> How the observability stack is secured, isolated per environment,
> backed up, upgraded, and monitored — and what operators do when a
> component fails. Companion artifacts: the whole of
> `infra/observability/`, plus the Caddy config at `deploy/caddy/Caddyfile`.

# Production Hardening Priorities

The observability stack runs on the production VM **next to the
application it observes**. Its hardening priorities, in order:

1. **Network isolation.** Nothing in the stack is reachable from the
   internet except Grafana, and Grafana only through Caddy with TLS.
   The collector's OTLP receiver is reachable only from the app
   network; Prometheus, Tempo, and the collector publish no host
   ports at all.

2. **Secret hygiene.** No secret is committed.
   `infra/observability/.env.example` carries placeholders only; the
   real `.env` is git-ignored and supplied per environment.

3. **The stack is never a dependency of the app.** Hardening must
   preserve the property that the application keeps serving traffic
   even if the entire observability stack is down. Telemetry is
   fire-and-forget; a hardening measure that could block the app's
   request path is wrong by construction.

4. **Per-environment isolation.** One stack instance per
   environment. No Prometheus, no Grafana, no collector is ever
   shared across production and staging.

5. **Reproducibility over backup.** The stack's *configuration* —
   dashboards, datasources, alerts, scrape config, collector
   config — is code in git. The right recovery posture is "redeploy
   from git", and time-series data is best-effort.

6. **Deliberate upgrades.** Pinned image tags, staging-first, one
   component at a time. Watchtower auto-updates the *app*; it must
   never auto-update the stack.

# Security Architecture

## Network isolation

The compose project defines two docker networks
(`infra/observability/docker-compose.observability.yml`):

- **`observability`** (`obs-internal`) — an internal bridge. The
  four stack services talk to each other here. No host publishing.
- **`app`** — the application compose project's pre-existing bridge
  (`inflect_internal`, joined as `external` via `APP_NETWORK_NAME`).

**Only the collector joins both networks.** It is the single,
deliberate bridge between the two compose projects. The app must
reach the collector to push OTLP; the collector must reach Prometheus
(to be scraped) and Tempo (to push traces). Prometheus, Tempo, and
Grafana never touch the `app` network — Prometheus has no reason to
resolve `app:3000` and the app has no reason to resolve
`prometheus:9090`. Narrowing each service to exactly the networks it
needs is the first line of defence.

**Host-port publishing is the second line.** The compose file
publishes exactly one host port:

| Service | Host port | Rationale |
|---------|-----------|-----------|
| `otel-collector` | none | Reachable on docker networks only — app pushes, Prometheus scrapes |
| `prometheus` | none | Reachable on `observability` only — Grafana queries it |
| `tempo` | none | Reachable on `observability` only — collector pushes, Grafana queries |
| `grafana` | `127.0.0.1:3001` | Loopback only — Caddy reverse-proxies it to the public TLS endpoint |

Grafana's binding is **`127.0.0.1:3001`, never `0.0.0.0:3001`**. A
`0.0.0.0` binding would expose Grafana's login page directly on the
VM's public interface, bypassing Caddy's TLS and security headers. A
loopback binding means only processes on the host — i.e. Caddy — can
reach it.

**An operator who needs the Prometheus or Tempo UI directly** uses
an SSH tunnel (`ssh -L 9090:localhost:9090 vm` after a temporary
loopback `docker compose port` mapping, or `docker exec`). There is
never a persistent public port on Prometheus, Tempo, or the
collector.

**The collector's debug surfaces bind to localhost only.** If
`pprof` or `zpages` are enabled in the collector config for
debugging, they bind to `localhost:<port>` *inside the container* —
unreachable even from the docker network, let alone the host. The
default config ships them commented out (see `02`); enable them only
transiently and only on localhost.

## TLS at Caddy

Grafana is exposed publicly **only** through the existing Caddy
reverse proxy, which already terminates TLS for the application via
Let's Encrypt (`deploy/caddy/Caddyfile`). Add a site block for Grafana —
either a subdomain or a path — proxying to the loopback port:

```caddy
# deploy/caddy/Caddyfile — Grafana behind the existing Caddy, TLS via Let's Encrypt.
grafana.inflect.<vm-ip-dashes>.sslip.io {
    encode gzip zstd

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options    "nosniff"
        X-Frame-Options           "DENY"
        Referrer-Policy           "strict-origin-when-cross-origin"
        -Server
    }

    reverse_proxy 127.0.0.1:3001 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

`GF_SERVER_ROOT_URL` in the Grafana env must match this public URL
so OAuth redirects, share links, and alert callbacks resolve. No
other component is ever placed behind Caddy — Prometheus and Tempo
have no public surface.

## Secrets management

**No secret is committed, ever.**
`infra/observability/.env.example` is the template and carries only
placeholders. The real `.env` is git-ignored and supplied per
environment. Secrets in play:

| Secret | Where it lives | Notes |
|--------|----------------|-------|
| `GF_SECURITY_ADMIN_PASSWORD` | `.env` | Mandatory — the compose file uses `:?` so a missing value aborts container start |
| `GF_AUTH_GOOGLE_CLIENT_SECRET` | `.env` | Google OAuth for Grafana SSO |
| `GRAFANA_ALERT_WEBHOOK` | `.env` | Notification destination (Slack / pager webhook) |
| `REMOTE_WRITE_PASSWORD` | `.env` | Only if remote-write is enabled |

For a higher bar, the compose file can read these via **Docker
secrets** (`secrets:` + `_FILE`-suffixed env vars) instead of plain
env — the values then live in `/run/secrets/` as tmpfs files, never
in the container's environment block. Either way the rule is
absolute: secrets enter via env or Docker secrets at deploy time,
and the `.env.example` in git is placeholders.

The detect-secrets pre-commit hook and the `no-secrets` CI guardrail
(Epic C.2) scan the whole tree — a real secret committed under
`infra/observability/` is caught the same way it would be anywhere
else in the repo.

## Grafana RBAC

Three roles, least-privilege by default:

- **Viewer** — the default for every new (including SSO'd) user
  (`GF_USERS_AUTO_ASSIGN_ORG_ROLE=Viewer`). Reads dashboards and
  alerts; cannot edit anything.
- **Editor** — can build dashboards and edit alert rules. Granted
  deliberately to engineers who maintain the observability surface.
- **Admin** — manages users, datasources, and org settings. The
  smallest possible set; the `GF_SECURITY_ADMIN_PASSWORD` account
  is the break-glass Admin.

Sign-up and anonymous access are **disabled**
(`GF_USERS_ALLOW_SIGN_UP=false`,
`GF_AUTH_ANONYMOUS_ENABLED=false`) in staging and production.
**Google OAuth SSO** (reusing the product's identity provider —
`src/auth.ts`) maps Google identities to Grafana users; new users
land as Viewer and are elevated deliberately. The admin-password
login stays enabled as the break-glass path if SSO is
misconfigured.

# Environment / Tenancy Strategy

**One stack instance per environment. Never one Prometheus across
environments.** Local, staging, and production each run their own
copy of `docker-compose.observability.yml` with their own `.env`,
their own volumes, their own collector, Prometheus, Tempo, and
Grafana. The differences are entirely in `.env` (see the
environment table in `01`).

Why strict per-environment isolation, not a shared monitoring stack
with environment *labels*:

- **Blast radius.** A bad alert rule, a runaway-cardinality metric,
  or a Prometheus restart in staging must not touch production's
  monitoring. Separate instances make a staging mistake a staging-
  only mistake.
- **Retention and sampling differ by environment** (30d/20% prod
  vs 15d/100% staging). One Prometheus cannot hold two retention
  policies; one collector cannot hold two sampling rates. The
  `DEPLOYMENT_ENVIRONMENT` and `OTEL_SAMPLING_PERCENTAGE` env vars
  exist precisely so the *same config* runs *separate instances*.
- **Security boundary.** Production telemetry can carry
  production-shaped data (route templates, tenant-slug-collapsed
  labels, trace attributes). It must not be queryable from a
  lower-trust staging Grafana. Separate Grafana instances, separate
  auth, separate trust zones.
- **Compliance.** inflect-compliance is a multi-tenant compliance
  product. Mixing environments in one observability backend muddies
  the data-handling story for no operational gain.

The `resource` processor stamps `deployment.environment` and
Prometheus stamps `external_labels.environment` — these labels are
for *clarity within an environment* (and for a future shared
remote-write backend), not a substitute for instance isolation.

**Tenancy note.** The application is multi-tenant; the observability
stack is **not** tenant-aware, deliberately. `tenant_id` is **never
a metric label** (`src/lib/observability/metrics.ts` is explicit
about this — it would explode cardinality). Per-tenant debugging is
done via **trace search** in Tempo, where `repo.tenant_id` is a span
attribute. Metrics are fleet-aggregate; traces are where you pivot
to a tenant. This keeps Prometheus's series count modest (see the
sizing in `03`) while preserving per-tenant investigation.

# Retention / Governance Strategy

**Retention is enforced by component flags, governed by a disk-
runway alert.**

- **Prometheus** — `--storage.tsdb.retention.time=${PROM_RETENTION}`
  (30d production, 15d staging, ≤3d local). The TSDB deletes blocks
  older than the window automatically.
- **Tempo** — the compactor's `block_retention`, driven by
  `TEMPO_RETENTION` (`168h` production, `72h` staging, `24h`
  local). Old trace blocks are reclaimed automatically.

Retention is a deliberate, reviewed value per environment, not a
default. Raising production retention is a `.env` change plus a
redeploy — and a re-check of the storage-sizing formula in `03`
against the new window.

**The governance backstop is `PrometheusDiskFillingUp`** (`03`) — a
`predict_linear` alert that fires when the TSDB volume is projected
to fill within four days. Retention bounds *intended* growth; the
alert catches *unintended* growth (a cardinality regression, a new
high-series metric). The two together mean the volume never
silently fills.

**Cardinality is governed at the source.** The application's
metric design — `normalizeRoute()` collapsing dynamic URL segments,
`tenant_id` excluded from labels, bounded `{repo.method, outcome}` /
`{job.name, job.status}` / `{http.status_code}` label sets — is the
real retention control. A code review that adds an unbounded label
to a metric is a retention regression and should be caught there.
`prometheus_tsdb_head_series` on the stack-health dashboard is the
detection surface if one slips through.

# Backup / Recovery Strategy

The recovery posture rests on one distinction: **configuration is
source-of-truth and lives in git; time-series data is best-effort
and does not.**

**Configuration — fully reproducible from git.** Everything that
defines *how the stack behaves* is code under
`infra/observability/`: the compose file, the collector config, the
Prometheus scrape config and rules, the Grafana provisioning
(datasources, dashboards, alerting), the Tempo config. **Recovery of
configuration = redeploy from git.** There is nothing to back up —
`git clone` + `docker compose up -d` rebuilds the entire stack's
behaviour. This is why dashboards, datasources, and alerts are
provisioned-as-code rather than click-configured: a click-configured
dashboard would be unbacked state living only in Grafana's SQLite
volume.

**Time-series data — best-effort, not source-of-truth.** The
Prometheus TSDB and the Tempo trace store are *observational* data.
They are not a system of record; the system of record for
compliance events is the application's hash-chained `AuditLog`
(immutable, in Postgres) and the tenant SIEMs the audit stream
feeds. Losing a Prometheus volume loses *metrics history* — an
inconvenience, not a compliance or correctness incident. The right
RPO posture for this data is therefore **best-effort**:

- **Acceptable:** if a Prometheus volume is lost, accept the gap,
  redeploy, and start a fresh TSDB. Recent operational visibility
  is restored within one scrape interval.
- **Optional, if metric history matters more:** take periodic
  Prometheus **TSDB snapshots** via the admin API
  (`POST /api/v1/admin/tsdb/snapshot`, enabled with
  `--web.enable-admin-api`) and copy the snapshot off-volume. This
  is a *nice-to-have*, not a requirement.
- **The real durability answer is remote-write.** When metric
  history genuinely needs to survive a VM loss, the answer is the
  commented `remote_write:` block in `prometheus.yml` (`03`) —
  stream metrics to an off-host backend — not a TSDB backup
  cron-job.

**Grafana's volume** (`obs-grafana-data`, SQLite) holds only
user-created ad-hoc dashboards and login sessions — all
*provisioned* dashboards/datasources/alerts are rebuilt from git on
start. Back it up only if user-created dashboards are valuable;
otherwise treat Grafana as stateless and reproducible.

**Bottom line:** restore = redeploy. The stack is cattle, not
pets. The only thing worth backing up is anything created in a UI
and not committed to git — and the provisioning-as-code discipline
exists to keep that set empty.

# Upgrade / Change Management Strategy

**Image tags are pinned. Never `:latest`.** The compose file pins
`otel/opentelemetry-collector-contrib:0.123.0`,
`prom/prometheus:v3.3.0`, `grafana/tempo:2.7.2`,
`grafana/grafana:11.6.0`. A floating tag means an unattended,
unreviewed upgrade — exactly the failure mode for a config-driven
stack where a minor version can change a config schema.

**Watchtower does not touch the observability stack.** Watchtower
auto-pulls the *application's* GHCR image (`docker-compose.prod.yml`).
The observability stack is a **separate compose project** with
pinned tags — Watchtower, scoped to the app project, never sees it.
This separation is deliberate: the app moves continuously; the
monitoring tier moves deliberately.

**Upgrade procedure — staging-first, one component at a time:**

1. Bump one image tag in `infra/observability/docker-compose.observability.yml`
   on a branch.
2. If the upgrade touches a component with a config file (collector,
   Prometheus, Tempo), validate the existing config against the new
   image: the collector `validate` subcommand (`02`),
   `promtool check config` / `promtool check rules` for Prometheus.
3. Deploy to **staging**. Watch the stack-health dashboard for one
   evaluation cycle — targets `UP`, no new `otelcol_*` errors, no
   dropped data.
4. Soak on staging long enough to catch a regression (a few hours
   to a day, depending on the component).
5. Promote the same tag to production; redeploy that one component.
6. **One component per change.** Never bump the collector,
   Prometheus, Tempo, and Grafana in one diff — if something breaks
   you must know which.

**Config changes follow the same path: git → review → redeploy.**
Every config file under `infra/observability/` is mounted read-only;
there is no runtime editing. A scrape-config change, a new alert
rule, a dashboard edit — all are pull requests, reviewed, validated
in CI (`promtool`, collector `validate`), deployed to staging, then
production. Prometheus's `--web.enable-lifecycle` allows a config
hot-reload (`POST /-/reload`) without a container restart, but the
*change* still goes through git first.

# Failure Modes and Runbooks

The governing principle: **the observability stack is an observer,
never a dependency of the application.** Every runbook below starts
from "is the app affected?" — and for most of them the answer is no.

### Collector is down

- **App impact: NONE.** The app's OTLP exports fail; the OTel SDK
  logs the failure and drops the batch. `recordRequestMetrics` and
  the other recorders in `metrics.ts` fall through to **noop
  instruments**. The app keeps serving requests; `/api/livez` and
  `/api/readyz` stay green. **Telemetry is fire-and-forget — a dead
  collector is a telemetry gap, not an outage.**
- **Stack impact:** metrics and traces have a gap for the outage
  window.
- **Detection:** `CollectorDown` alert (`up{job="otel-collector-self"}
  == 0`), and `ScrapeTargetDown` for the `otel-collector-*` jobs.
- **Action:** `docker compose -f docker-compose.observability.yml
  logs otel-collector`; restart it (`restart: unless-stopped`
  usually has already). If it crash-loops, check the config —
  validate it (`02`); a bad config fails at startup. Roll back to
  the last good config from git.

### Prometheus is down

- **App impact: NONE.**
- **Stack impact:** no metrics are stored; no alerts evaluate (the
  alerting rules live in Prometheus). Dashboards' metric panels go
  blank.
- **Detection:** the **deadman's switch** is the primary signal —
  `ObservabilityDeadmanSwitch` is always-firing by design; if
  Grafana stops *receiving* it, rule evaluation or notification
  delivery is broken, which Prometheus being down causes. An
  external uptime check on the Grafana URL is the backstop.
- **Action:** `docker logs obs-prometheus`; restart. If it will
  not start, the most likely cause is a corrupt TSDB block or a
  full disk (see below) — Prometheus logs the offending block; in
  the worst case delete the bad block from `obs-prometheus-data`
  and restart (losing that block's data). The persistent volume
  means a clean restart loses nothing.

### Grafana is down

- **App impact: NONE.**
- **Stack impact:** no dashboards, no alert *notification* routing
  (Grafana Unified Alerting evaluates and routes). **Data is
  safe** — Prometheus keeps storing, Tempo keeps ingesting.
- **Detection:** external uptime check on the Grafana URL;
  operators notice the UI is unreachable.
- **Action:** `docker logs obs-grafana`; restart. Because all
  datasources, dashboards, and alerting are provisioned-as-code,
  even a total loss of the `obs-grafana-data` volume is recovered
  by a redeploy — the provisioning rebuilds everything. Grafana is
  the most disposable component in the stack.

### Prometheus disk is full

- **App impact: NONE.**
- **Stack impact:** the TSDB **halts writes** — `head` block stops
  growing, ingestion stalls, metrics stop being recorded.
- **Detection:** `PrometheusDiskFillingUp` (`predict_linear`,
  4-day runway) fires *before* it happens; `PrometheusSampleIngestionStalled`
  fires if it already has.
- **Action:** the runway alert should have given days of warning.
  Immediate relief: reduce `PROM_RETENTION` and redeploy
  (Prometheus reclaims old blocks on the next compaction).
  Durable fix: grow the `obs-prometheus-data` volume, or enable
  `remote_write` and shorten local retention. Re-check the
  sizing formula in `03`.

### Collector memory pressure

- **App impact: NONE** — but with a nuance: under pressure the
  `memory_limiter` processor **refuses new data**, so the app's
  OTLP exporter gets retryable errors and the app drops that
  telemetry. The app still serves traffic; the telemetry is the
  thing shed.
- **Stack impact:** refused/dropped telemetry — a partial gap, not
  a total one.
- **Detection:** `CollectorDroppingData` alert on
  `otelcol_processor_refused_*` / `otelcol_processor_dropped_*`.
- **Action:** check what is driving the volume — usually a
  cardinality spike (a new high-series metric) or a traffic spike.
  Short-term: raise the collector's `mem_limit` and
  `memory_limiter.limit_mib` together (keep the limiter below the
  container limit) and redeploy. Real fix: find and fix the
  cardinality source in the app's metric labels. The
  `memory_limiter` doing its job — shedding rather than OOMing — is
  graceful degradation, not a failure.

### Total stack loss (VM-level)

- **App impact:** if the same VM hosts the app, the app is down
  too — but that is a *VM* failure, not a stack failure. If the
  stack is on a dedicated monitoring VM (the scale-out step in
  `01`), the app is unaffected.
- **Detection:** the deadman's switch stops arriving; an
  **external** uptime monitor (off-VM — a third-party uptime
  service hitting the Grafana URL) is the only thing that can see a
  total loss, since everything that would alert is also gone.
- **Action:** recover the VM; `docker compose up -d` both compose
  projects. The stack rebuilds from git; metrics history before the
  loss is gone unless remote-write or TSDB snapshots were in use
  (best-effort RPO — see Backup/Recovery).

# Monitoring the Observability Stack

The stack must observe itself — a monitoring tier that cannot
report its own health is worthless. Four overlapping mechanisms:

1. **Prometheus scrapes the collector's self-metrics (`:8888`).**
   The `otelcol-collector-self` scrape job collects `otelcol_*`.
   The signals that matter:
   - `otelcol_exporter_send_failed_metric_points` /
     `otelcol_exporter_send_failed_spans` — the collector cannot
     reach Prometheus's exposition surface or Tempo.
   - `otelcol_processor_refused_metric_points` /
     `otelcol_processor_refused_spans` — `memory_limiter` is
     shedding load.
   - `otelcol_processor_dropped_metric_points` /
     `otelcol_processor_dropped_spans` — data dropped downstream.
   - `otelcol_receiver_refused_*` — incoming OTLP rejected.
   Alerted by `CollectorExportFailing` and `CollectorDroppingData`
   (`03`).

2. **Prometheus scrapes itself, Grafana, and Tempo.** The `up`
   metric for every one of the five scrape jobs is the liveness
   signal; `ScrapeTargetDown` (`up == 0`) covers all of them.
   Scrape duration and `prometheus_tsdb_*` (head series, samples
   appended, block bytes) cover Prometheus's own health, alerted
   by `PrometheusSampleIngestionStalled` and
   `PrometheusDiskFillingUp`.

3. **The "Observability Stack Health" dashboard** (`Platform`
   folder, `03`) — the human-facing surface: every `up`, collector
   ingest-vs-export and error rates, collector memory against the
   `memory_limiter` ceiling, Prometheus TSDB series and disk
   runway, Tempo ingest and query latency, and the deadman's switch
   status.

4. **The deadman's switch** — `ObservabilityDeadmanSwitch`,
   `expr: vector(1)`, always firing by design. Grafana is
   configured to alert if it **stops** arriving. It is the catch-all
   for "the whole alerting pipeline is silently broken" — a state
   no other alert can detect, because every other alert depends on
   the same pipeline. Pair it with an **external, off-VM uptime
   check** on the Grafana URL so a total-VM loss (which kills the
   deadman's switch *and* everything that would notice it) is still
   caught.

The principle: every component the stack depends on is itself a
scrape target, every failure mode in the runbooks above has an
alert, and the one failure mode alerts cannot catch — the alerting
pipeline itself dying — is covered by the deadman's switch plus an
external probe.

# Acceptance Criteria

- [ ] Only the collector joins both the `observability` and `app`
      docker networks; Prometheus, Tempo, and Grafana are on
      `observability` only.
- [ ] No observability container publishes a host port **except**
      Grafana on `127.0.0.1:3001` (loopback only — never
      `0.0.0.0`).
- [ ] Grafana is reachable publicly **only** through Caddy with
      Let's Encrypt TLS and security headers; `GF_SERVER_ROOT_URL`
      matches the public URL.
- [ ] The collector's `pprof` / `zpages` (if enabled) bind to
      `localhost` inside the container only.
- [ ] `infra/observability/.env.example` contains placeholders
      only; the real `.env` is git-ignored; no secret is committed
      anywhere under `infra/observability/`.
- [ ] `GF_SECURITY_ADMIN_PASSWORD` is mandatory (compose `:?`);
      sign-up and anonymous access are disabled in staging/prod;
      default role is Viewer; Google OAuth SSO is configured for
      production.
- [ ] Each environment runs its **own** stack instance with its
      own `.env` and volumes — no Prometheus, Grafana, or
      collector is shared across environments.
- [ ] `tenant_id` is not a metric label anywhere; per-tenant
      investigation uses Tempo trace search (`repo.tenant_id` span
      attribute).
- [ ] Retention is enforced by `PROM_RETENTION` /
      `TEMPO_RETENTION` flags; `PrometheusDiskFillingUp` is active
      as the governance backstop.
- [ ] All stack configuration — compose, collector config, scrape
      config, rules, Grafana provisioning, Tempo config — is in
      git under `infra/observability/`; recovery of configuration
      is "redeploy from git".
- [ ] Time-series data has a documented **best-effort** RPO;
      remote-write is the documented durability path; the
      application's `AuditLog` (not Prometheus) remains the
      compliance system of record.
- [ ] All image tags are pinned; Watchtower does not touch the
      observability compose project; upgrades are staging-first,
      one component at a time, with config validation
      (`promtool` / collector `validate`).
- [ ] Every failure mode in the runbooks (collector down,
      Prometheus down, Grafana down, disk full, collector memory
      pressure, total stack loss) has a documented detection
      signal and recovery action.
- [ ] Stopping any single component leaves the **application**
      serving traffic; `/api/livez` and `/api/readyz` stay green.
- [ ] The collector self-metrics (`:8888`), Prometheus, Grafana,
      and Tempo are all scraped; the deadman's switch is active;
      an external off-VM uptime check covers total-stack loss.
