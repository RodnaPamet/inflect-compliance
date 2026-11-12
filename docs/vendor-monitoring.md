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
   The vendor domain is tenant-entered, so the homepage is requested only
   through the bot seam `botFetch` (`src/lib/web-bot-auth/bot-fetch.ts`),
   which is `safeFetch` underneath: the domain must be a bare host name, the
   address must be public and is pinned, and a redirect is followed only by
   checking its target the same way (https, public, at most five hops). The
   origin's `robots.txt` is read first, and again for any other origin a
   redirect leads to, and every URL requested (each redirect hop included) is
   judged against its origin's rules by its own path; a site that disallows
   the monitor is recorded `REFUSED` with reason `ROBOTS` and the disallowed
   URL is not requested. A
   refused, unreachable or invalid domain is left ungraded and its outcome
   recorded.

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

**How the monitor identifies itself (Web Bot Auth).** Every TLS-grade request
carries the User-Agent `InflectCompliance-VendorMonitor/1.1 (+<APP_URL>/bots/vendor-monitor)`
and, when `WEB_BOT_AUTH_SIGNING_KEY` is set and `APP_URL` is a bare https
origin, an HTTP Message Signature naming the deployment's key directory
(`<APP_URL>/.well-known/http-message-signatures-directory`). Without a key the
requests go out unsigned, exactly as before. The public page at
`/bots/vendor-monitor` states what the monitor fetches, when (the daily sweep
and on-demand checks, once per monitoring organisation), its key
directory and how a site opts out; its User-Agent links there. The breach
check sends the same User-Agent to HIBP, unsigned. The identity is the
deployment's: nothing in a request names a tenant.

### Registering with Cloudflare Verified Bots (operator act)

Registration is the operator's act, done once in Cloudflare's dashboard. It is
not code and nothing automates it. Do it only after all of these hold:

1. `WEB_BOT_AUTH_SIGNING_KEY` is set in production, `APP_URL` is the public
   https origin, and `GET <APP_URL>/.well-known/http-message-signatures-directory`
   answers 200 with the `application/http-message-signatures-directory+json`
   media type and a `Signature` header, with no bot protection in front of it
   (verifiers fetch it unsigned).
2. Cloudflare's validator accepts the directory:
   `http-signature-directory <APP_URL>/.well-known/http-message-signatures-directory`
   (crate 0.8.0). It requires the response signature to cover
   `content-digest`; the directory served today covers `"@authority";req`
   only, so this step fails until that is added (open in the Phase 2
   implementation note).
3. A signed request answers 200, not 401 or 400, at Cloudflare's format
   checker `https://crawltest.com/cdn-cgi/web-bot-auth` once the key is
   registered (401 before registration is the expected answer for an unknown
   key; 400 means the format is wrong).
4. `<APP_URL>/bots/vendor-monitor` loads without signing in and states what
   the monitor actually fetches.

Then, in the dashboard: **Manage Account → Configurations → Bot Submission
Form**; verification method **Request Signature**; the directory URL above as
the validation instructions; User-Agent pattern `InflectCompliance-VendorMonitor`;
bot kind **Direct**, behaviour **Monitoring & Operations**. Ask at submission
whether Cloudflare re-reads the registered directory on its own or needs to be
told about a rotated key, and write the answer here. Track the status under
**BotBase → Submission history**.

After registration, record the `REFUSED` share of
`vendor_monitor.tls_fetch{reason="NONE"}` for 14 days, signed against the
unsigned baseline, in the Phase 2 implementation note (Web Bot Auth sub-phase 2.5),
whatever the result.

## Adding a new signal source

Mirror the existing provider shape (do NOT fork a second ingestion path):

1. Add a provider interface + a deterministic `TestMode…` stub + a real
   provider under `src/app-layer/services/vendor-monitoring/`. A provider
   that calls a fixed host named in code uses `fetchWithRetry`; one that
   requests a third-party website, or any host a tenant enters (the vendor
   domain is one), uses `botFetch` from `@/lib/web-bot-auth/bot-fetch`
   (`safeFetch` plus the bot's User-Agent and signature; the
   `local/web-bot-auth-single-seam` rule refuses a signature or a bot
   User-Agent made anywhere else) and joins the `BOT_SEAM_CALLERS` of
   `tests/guards/ssrf-egress-coverage.test.ts`.
2. Add a pure evaluator (freshness / threshold) in `evaluate.ts`.
3. Plan a `PlannedEvent` in `runVendorMonitor` (fingerprint for idempotency;
   optional `finding` spec gated on `materializeFindings`).
4. Extend `tests/guardrails/vendor-monitoring-coverage.test.ts`.

## Future work

- Paid security-rating connector (SecurityScorecard / BitSight) behind the
  same provider seam.
- Per-tenant breach-feed webhook ingestion (push, not daily poll).
