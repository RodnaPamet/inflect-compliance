# Continuous vendor monitoring + breach intelligence

The operator + developer runbook for IC's continuous-assurance layer: the
always-on companion to the point-in-time vendor assessment.

A vendor assessment is a snapshot that goes stale the moment it's signed.
Continuous monitoring re-checks a vendor's posture on a daily cadence and,
when posture changes, flips the vendor into reassessment-due, records a posture
timeline, and (opt-in) raises a finding + notifies the owner.

## What it monitors

Three **free / public** signal families, each per vendor, each toggleable on
the `VendorMonitor` row:

1. **Attestation expiry** — the parsed SOC 2 / ISO cert period (`auditPeriodEnd`
   from the vendor-doc extraction). When the earliest-expiring dated report
   lapses, the vendor's signed assessment no longer reflects a current
   attestation: the monitor sets `Vendor.nextReviewAt = now` (stale → overdue),
   records `ATTESTATION_EXPIRED` + `REASSESSMENT_TRIGGERED`, and — if findings
   are enabled — raises a `VENDOR_ATTESTATION_EXPIRED` finding.
2. **Breach intelligence** — a keyless public breach-catalog domain check
   (HIBP `/breaches` filtered by the vendor's registrable domain). A breach
   dated later than the last one seen flips the vendor into reassessment-due,
   records `BREACH_DETECTED`, and (opt-in) raises a `VENDOR_BREACH` finding.
3. **TLS / security-header grade** — a light public grade (A–F) of the
   vendor's homepage security headers (HSTS, CSP, X-Frame-Options, …),
   SSL-Labs-style but keyless. Records a `TLS_GRADE` timeline event on change +
   updates rolling state. Informational — does not raise a finding.

Every posture change lands one **`VendorPostureEvent`** — the append-only
continuous-assurance timeline, idempotent via `@@unique([tenantId,
fingerprint])`.

## Scope — what this is NOT

- **Not paid security ratings.** SecurityScorecard / BitSight-style
  commercial ratings are a **future connector** — not built here. Monitoring
  uses only free, keyless public signals.
- **Not active scanning.** The monitor checks public signals + attestation
  expiry. It never pentests or probes vendor infrastructure.
- **Not a replacement for the assessment.** It keeps the assessment *fresh* —
  it flips it stale and triggers a human reassessment; it does not answer the
  questionnaire.

## Propose-not-commit

Monitoring **always** records the timeline and notifies the vendor owner. A
scored **Finding** materialises only when the tenant opts in via
`VendorMonitor.materializeFindings` (default `false`) — mirroring the
vendor-doc pre-fill stance: nothing scored silently. Findings are idempotent by
`(sourceKind, sourceRef)`; notifications by `dedupeKey`.

## Operating it

**Schedule.** The `vendor-monitoring` job runs daily at 02:00 UTC (after the
NVD sync, before the morning digest). It sweeps every enabled `VendorMonitor`
with a per-tenant system context, then runs the vendor reassessment-reminder
cadence in the same pass. The reminder notifies an overdue vendor's owner once
per review date and does not move `nextReviewAt`: a vendor stays overdue until
a completed assessment review rolls the date forward, or someone edits it.

**On-demand.** `POST /api/t/:slug/vendors/:vendorId/monitor/run` runs the
monitor for one vendor immediately (creates the monitor row on first run).
`GET …/monitor` returns the monitor state + posture timeline;
`PATCH …/monitor` toggles config (`enabled`, per-signal, `materializeFindings`).
All gated under `vendors.view` / `vendors.edit`. The vendor detail page's
**Monitoring** tab surfaces the state card + "Run monitor now" + timeline; the
vendor dashboard shows the **Continuous assurance** signals (N expired
attestations, M recent breach activity, K overdue reassessment).

**Providers.** Selected by env, defaulting to the deterministic network-free
stub (CI-safe):

| Env var | Default | Real value |
| --- | --- | --- |
| `VENDOR_MONITOR_ENABLED` | on | `0` disables the sweep (air-gapped) |
| `VENDOR_MONITOR_BREACH_PROVIDER` | `stub` | `hibp-domain` (keyless public catalog) |
| `VENDOR_MONITOR_TLS_PROVIDER` | `stub` | `header-grade` (homepage headers) |

The sweep runs with `attempts: 1` — it is idempotent and re-runs daily, so a
transient feed failure self-heals on the next cycle rather than retry-storming
the public feeds.

## Adding a new signal source

Mirror the existing provider shape (do NOT fork a second ingestion path):

1. Add a provider interface + a deterministic `TestMode…` stub + a real
   provider calling `fetchWithRetry` under
   `src/app-layer/services/vendor-monitoring/`.
2. Add a pure evaluator (freshness / threshold) in `evaluate.ts`.
3. Plan a `PlannedEvent` in `runVendorMonitor` (fingerprint for idempotency;
   optional `finding` spec gated on `materializeFindings`).
4. Extend `tests/guardrails/vendor-monitoring-coverage.test.ts`.

## Future work

- Paid security-rating connector (SecurityScorecard / BitSight) behind the
  same provider seam.
- Per-tenant breach-feed webhook ingestion (push, not daily poll).
