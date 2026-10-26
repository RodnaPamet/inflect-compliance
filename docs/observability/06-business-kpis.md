# 06 — Business KPIs: product metrics + the KPI dashboard

## What this is

`metrics.ts` emits **infrastructure** signals (HTTP rates, repo
durations, job counters, audit-stream delivery). This subsystem adds
**business / product** signals — tenant growth, the onboarding funnel,
feature adoption, and plan mix — emitted from the existing usecase
boundaries through the SAME meter (`inflect-compliance`). The module is
`src/lib/observability/business-metrics.ts`; the dashboard is
`infra/observability/grafana/dashboards/inflect-business-kpis.json`.

## What this is NOT

- **Not a revenue dashboard.** Pricing / MRR / churn-in-dollars lives in
  Stripe (or finance tooling), per `docs/billing.md`. This dashboard is
  **product engagement only**.
- **Not a per-tenant view.** The cardinality discipline below means
  Grafana never shows per-tenant breakdowns — that is the admin panel's
  job.
- **Not exported.** Operators consume Grafana directly; there is no
  scheduled PDF/email of this dashboard.

## The catalogue (canonical reference)

`BUSINESS_METRIC_NAMES` in `business-metrics.ts` is the machine-readable
source of truth; this table is its prose mirror. 21 metrics.

### Tenant growth
| Metric | Type | Labels |
|--------|------|--------|
| `business.tenant.created` | Counter | `plan`, `signup.source` |
| `business.tenant.deleted` | Counter | `plan`, `reason` |
| `business.tenant.active.daily` | Observable Gauge | `plan` |
| `business.tenant.active.monthly` | Observable Gauge | `plan` |

### Membership / users
| Metric | Type | Labels |
|--------|------|--------|
| `business.user.signup` | Counter | `signup.source` (`oauth_google`/`oauth_microsoft`/`saml`/`credentials`/`invite`) |
| `business.invite.sent` | Counter | — |
| `business.invite.redeemed` | Counter | `time_to_accept.bucket` |
| `business.user.mfa.enrolled` | Counter | `method` (`totp`/`webauthn`) |

### Onboarding funnel
| Metric | Type | Labels |
|--------|------|--------|
| `business.onboarding.step.completed` | Counter | `step` (from `STEP_ORDER`) |
| `business.onboarding.completed` | Counter | `time_to_complete.bucket` |
| `business.onboarding.abandoned` | Counter | `last_step_reached` |

### Feature adoption
| Metric | Type | Labels |
|--------|------|--------|
| `business.framework.installed` | Counter | `framework.key`, `plan` |
| `business.policy.published` | Counter | — |
| `business.audit.cycle.started` | Counter | — |
| `business.audit.pack.shared` | Counter | — |
| `business.risk.created` | Counter | `source` (`manual`/`imported`/`ai_generated`) |
| `business.control.created` | Counter | `source` (`manual`/`library`/`framework_install`) |
| `business.automation.rule.created` | Counter | — |

### Billing
| Metric | Type | Labels |
|--------|------|--------|
| `business.plan.upgraded` | Counter | `from.plan`, `to.plan` |
| `business.plan.downgraded` | Counter | `from.plan`, `to.plan` |
| `business.plan.limit.hit` | Counter | `resource` (`control`/`risk`/`user`/`automation_rule`) |

## Cardinality rules (load-bearing)

- **`tenant.id` is NEVER a label.** Inherited from the Epic OI-3
  repo-tracing convention. Per-tenant detail is the admin panel's job.
- **`plan` is a label** — 4 bounded enum values (FREE/TRIAL/PRO/
  ENTERPRISE).
- `signup.source`, `step`, `framework.key`, `resource`, `method`,
  `source`, `reason` are all **bounded enums** — fine.
- **Duration labels are pre-rounded bucket strings** —
  `lt_1h`/`lt_1d`/`lt_1w`/`gt_1w` via `bucketTimeTo()`. A raw duration
  must NEVER become a label.

The coverage ratchet
(`tests/guardrails/business-metrics-coverage.test.ts`) enforces all of
the above structurally.

## DAU / MAU — precise definition (for report provenance)

> **Active user** = a user who made **≥1 audit-logged action** in the
> rolling window. Any mutation writes an `AuditLog` row carrying the
> actor `userId`; both windows read `AuditLog` so DAU and MAU share one
> source and are directly comparable. (Read-only activity is therefore
> NOT counted — "active" here means "made a change", which is the
> meaningful engagement signal for a compliance tool.)
>
> - **Daily (`business.tenant.active.daily`)** = distinct AuditLog
>   actors in the last **24 hours**, grouped by their tenant's plan.
> - **Monthly (`business.tenant.active.monthly`)** = distinct AuditLog
>   actors in the last **30 days**, grouped by their tenant's plan.
> - **DAU/MAU ratio** (dashboard) = a stickiness proxy; higher = users
>   return more often.

Naming note: the metric names carry the `tenant.active.*` prefix, but
the **value is distinct active *users*** (grouped by plan), not a tenant
count. This is deliberate — `plan` is the only label permitted by the
cardinality rules, and "active users by plan" is the engagement signal
operators want. The dashboard panels are titled "Daily/Monthly Active
Users" to match the value. In Prometheus the two gauges are
`business_tenant_active_daily_ratio` and
`business_tenant_active_monthly_ratio`: the collector's exporter adds
`_ratio` to any gauge whose unit is `1`, whatever it counts. The
counters end in `_total` (`business_tenant_created_total`).

The aggregation runs in the `dau-mau-aggregator` job on a **5-minute**
cadence. It computes the two `DISTINCT userId` counts per plan and calls
`setActiveUserSnapshot(...)`. The two observable gauges read that cached
snapshot at scrape time — so the expensive `DISTINCT` query runs every 5
minutes regardless of how often Prometheus scrapes. Gauges are
registered once via `startActiveUserGauges()` at scheduler/worker
startup.

## How to add a new business metric (in this order)

1. **Extend this catalogue** (the table above) — decide the metric name,
   type, and labels; confirm every label is bounded.
2. **Add to `business-metrics.ts`** — append the name to
   `BUSINESS_METRIC_NAMES` and add a lazy `record*` function (or a gauge
   registration). Duration → `bucketTimeTo()`. Never `tenant.id`.
3. **Wire at the usecase boundary** — one call, AFTER the mutation
   commits (after the audit-log write, never inside the transaction). A
   rolled-back mutation must not emit the metric.
4. **Add a panel** to `inflect-business-kpis.json`.
5. **Extend the ratchet** — the new name is picked up from
   `BUSINESS_METRIC_NAMES` automatically; add a wiring-point entry to
   the ratchet's allowlist so the "each wiring point imports the module"
   check covers it.

## Wiring-point allowlist

Each metric is emitted from exactly one usecase boundary (the
DAU/MAU gauges from the scheduled job). The ratchet asserts each listed
source file imports `business-metrics`. See the implementation note
`docs/implementation-notes/2026-06-25-business-kpis.md` for the full
metric → call-site table.
