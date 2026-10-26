# 2026-10-26 — Retire `infra/alerts/rules.yml`, `receivers.yml` and `infra/dashboards/`

## Design

The repository held two Prometheus rule sets. The one the observability stack
loads is `infra/observability/prometheus/rules/`, and #4339 holds it to the
metrics the app exports. The other, `infra/alerts/rules.yml`, with its
Alertmanager routing `receivers.yml` and the five Grafana dashboards in
`infra/dashboards/`, was loaded by nothing: the compose project mounts neither
directory, and production alerts through GCP Cloud Monitoring.

Most of the legacy rules duplicated rules the stack has (`ApiHigh5xxRatio`,
`ApiLatencySloBreach`, `JobFailureRateHigh`), or read series nothing exports
(`aws_elasticache_*`, `job_queue_depth` without its `_ratio`, the
connection-pool and certificate metrics). The exceptions were the
security-control and agentic-run alerts, which had no counterpart. Those
moved into `alerting-rules.yml` as two groups, `security_controls` and
`agentic_runs`, and the rest was deleted.

Porting them under #4339's test found three that could never have fired:

| rule | defect | fix |
|---|---|---|
| `SessionPolicyResolutionFailing` | read `session_policy_resolution`; a counter exports with `_total` | name corrected |
| `AgenticRunsInFlightSustained` | read `agent_runs_in_flight`; a unit-`1` gauge exports with `_ratio` | name corrected |
| `AgenticCircuitBreakerTripped` | `recordAgentBreakerTrip` had no caller, so the counter never moved | both latch sites now call it |

## Files

| file | role |
|---|---|
| `infra/observability/prometheus/rules/alerting-rules.yml` | the ten ported rules, in two new groups |
| `src/lib/agentic/circuit-breaker-store.ts` | `meterBreakerTrip`, called beside the bell at both latch sites |
| `infra/alerts/rules.yml`, `receivers.yml`, `infra/dashboards/*.json` | deleted |
| `tests/unit/epic19-coherence.test.ts` | reads the deployed rules and dashboards; checks the two groups by parsed name |
| `tests/unit/observability-infra.test.ts`, `tests/guards/oi-3-*.test.ts` | legacy-file cases removed |
| `docs/slos.md`, `docs/observability*.md`, `docs/incident-response.md`, `infra/README.md` | name what exists |

## Decisions

- **The kill-switch drill alert is split.** The legacy rule fired critical on
  `outcome!="PASSED"`, which includes `SWEPT_NOBODY`, the outcome a deployment
  with no registered agents reports every day. `FAILED` (the stop control did
  not stop) stays critical. `ERROR` and `SWEPT_NOBODY` (it went untested) are a
  separate warning.
- **The trip counter is counted once per signal.** A trip carried by two
  signals is seen by an alert on either; a trip with none still counts, as
  `none`. It is gated on the latch UPDATE's own row count, like the bell, so a
  human close that won the race counts nothing.
- **No alert mirrors the SLO thresholds.** The legacy file did (500 ms / 2 s,
  the 0.1% burn rate), and `epic19-coherence` checked that it did. The deployed
  latency rule uses 750 ms over all requests. `slos.md` now says each SLO has no
  production alert rather than naming rules that never ran, and the coherence
  checks keep only the document's own targets.
- **The identity-write-unsettled policy's email text is left alone.** It says
  `infra/alerts/rules.yml` describes a stack that does not run. Editing the
  JSON would make the repository disagree with the applied policy until
  somebody re-applies it.
