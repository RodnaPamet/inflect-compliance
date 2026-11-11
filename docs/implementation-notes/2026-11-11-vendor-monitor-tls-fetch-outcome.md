# 2026-11-11 — The vendor monitor records why a TLS grade did not move

**Commit:** `feat(vendor-monitoring): record the TLS-grade fetch outcome and mark a stale grade stale`

Web Bot Auth roadmap, Phase 0, sub-phase 0.4
(`docs/ai-architecture/web-bot-auth.md`). Owner decisions D-L1-5, D-L1-6 and
D-L1-7 were taken on 2026-11-11 (all three defaults adopted) and are recorded
in the child roadmap; initialling them in the master table is the
coordinator's.

## Design

Before: `HeaderGradeTlsProvider` turned every fetch that did not produce a 2xx
into `grade: null`, and `runVendorMonitor` read `null` as "nothing observed".
A vendor that put the monitor behind a bot wall kept its last grade, dated to
when its site was last readable, and nothing anywhere said it refused us.

After, the fetch says what it came to, and the sweep records it:

```
HeaderGradeTlsProvider.grade(domain) ──► TlsSignal { outcome, grade, checkedAt, … }
        │ GRADED | REFUSED | UNREACHABLE | BLOCKED
        ▼
planTlsObservation(previousGrade, signal)          (pure, evaluate.ts)
        │ keeps tlsGrade + tlsCheckedAt unless GRADED;
        │ always tlsFetchOutcome + tlsFetchOutcomeAt
        ▼
runVendorMonitor ──► VendorMonitor row  +  vendor_monitor.tls_fetch{provider,outcome}
        ▼
getVendorPosture ──► tlsGradeStale = isTlsGradeStale(monitor)
        ▼
VendorMonitoringPanel: "Stale" badge + "Last check <date>: <reason>"
```

The taxonomy, as the provider applies it:

| Outcome | When |
| --- | --- |
| `GRADED` | a 2xx homepage, not a challenge; its headers graded |
| `REFUSED` | any 4xx (a 403; a 429 after the one retry), or a recognised challenge on any status |
| `UNREACHABLE` | network failure or timeout after the retry; a 5xx after the retry; a name that does not resolve; a redirect without a location; the redirect limit; the deadline |
| `BLOCKED` | not a bare host name; the SSRF guard refused the start URL or a redirect target (private address, metadata, a hop to http) |

## Files

| File | Role |
| --- | --- |
| `src/app-layer/services/vendor-monitoring/types.ts` | `TLS_FETCH_OUTCOMES`, `TlsFetchOutcome`, `TlsSignal.outcome` |
| `src/app-layer/services/vendor-monitoring/tls-provider.ts` | the outcome per path; `recognisedChallenge` (headers only) |
| `src/app-layer/services/vendor-monitoring/evaluate.ts` | `planTlsObservation`, `isTlsGradeStale` |
| `src/app-layer/usecases/vendor-monitoring.ts` | writes the two columns, emits the metric, returns `tlsGradeStale` |
| `src/app-layer/automation/webhook-safety.ts` | `SsrfBlockedError.kind` (`REFUSED` default, `UNRESOLVED` for DNS) |
| `src/lib/observability/integration-metrics.ts` | `recordVendorTlsFetch` → `vendor_monitor.tls_fetch` |
| `prisma/schema/vendor.prisma`, migration `20261111230000_vendor_monitor_tls_fetch_outcome` | two nullable columns + two CHECKs |
| `VendorMonitoringPanel.tsx`, `messages/{en,bg}.json` | the stale mark and the reason |

## Decisions

- **The outcome never touches the grade.** A refusal is not a failing grade
  (we do not punish a vendor for a WAF), and it is not "no change" either. The
  last real grade and `tlsCheckedAt` stay exactly as they were, which keeps
  their meaning ("graded A on this date"); the outcome columns say the grade
  is now unconfirmed. No posture event is written for a refusal: a daily
  timeline entry per walled vendor would bury the events the timeline exists
  for, and the outcome column plus the metric carry it.
- **A name that does not resolve is UNREACHABLE, not BLOCKED.** The roadmap
  wording ("the SSRF guard refused the domain") could be read to include it,
  because `assertPublicAddress` throws `SsrfBlockedError` for DNS failure too.
  But BLOCKED tells the operator to correct the vendor record, and a resolver
  having a bad night would then say that for every vendor at once. So the
  guard's error gained a `kind` (`REFUSED` by default, `UNRESOLVED` for the two
  DNS throws) — additive, no other caller reads it — and the provider maps
  `UNRESOLVED` to UNREACHABLE. **Owner question:** if a permanently NXDOMAIN
  vendor should read BLOCKED, that needs a "failed N nights running" rule, not
  a different mapping.
- **Every other 4xx is REFUSED, not only 403.** The roadmap lists 403, an
  exhausted 429 and a challenge; WAFs also answer 401, 405, 406 and 451, and
  a site that answers anything 4xx was reached and declined. A 404 homepage
  lands here too. It is constant across the Phase 2 before/after comparison,
  so it does not bias the baseline. **Owner question** if REFUSED should be
  narrower.
- **Challenges are recognised from headers only, from two documented
  markers**: Cloudflare's `cf-mitigated: challenge` and AWS WAF's
  `x-amzn-waf-action: challenge|captcha`. The body is never read, so a
  vendor-specific HTML fingerprint is out by construction. A challenge is
  checked before `ok`, because AWS WAF challenges with a 202 — graded, its
  headers would have been reported as the vendor's posture — and before the
  5xx retry, because Cloudflare challenges with a 503. A challenge is not
  retried.
- **TEXT + CHECK, not a Postgres enum.** A new outcome is one migration that
  widens the CHECK; an enum value is a two-deploy change, because an older
  Prisma client fails every read of a row carrying a value it was not
  generated with. A second CHECK pairs `tlsFetchOutcome` with
  `tlsFetchOutcomeAt`.
- **Staleness is decided on the server** (`isTlsGradeStale`, returned as
  `tlsGradeStale` by the posture read). No grade is never stale, and a monitor
  whose outcome is NULL (it has not fetched since the migration) is not called
  stale on no evidence.
- **Metric labels: `provider` and `outcome` only.** Four outcomes times two
  providers. No vendor or tenant label.

## Risk assessment (SIGNIFICANT: schema migration)

- **Migration.** Two `ADD COLUMN` with no default on `VendorMonitor`: catalogue
  only, no rewrite, a brief `ACCESS EXCLUSIVE` lock on a small table. The two
  CHECKs are validated at add time; every existing row is NULL/NULL and passes
  both, so validation is a scan of a small table. No backfill.
- **Rolling deploy.** An old container's Prisma client does not know the
  columns and never selects or writes them; a new container writes them. No
  enum, so no SQLSTATE 42704 class of failure. The RLS policies on
  `VendorMonitor` are row-level and unchanged.
- **Behaviour.** The grade, `tlsCheckedAt`, posture events and findings are
  computed exactly as before for a GRADED fetch. The one change in what is
  graded: a 2xx carrying a recognised challenge marker is no longer graded.
- **Security surface.** `SsrfBlockedError` gains a defaulted constructor
  parameter; every existing `new SsrfBlockedError(msg)` keeps meaning
  `REFUSED`, and no request is admitted that was refused before.
- **Exposure.** The outcome is one of four words and a timestamp. No response
  body, header or status is stored; the HTTP status reaches only the log line.

## Rollback

- **Application:** redeploy the previous image. The old code never reads the
  columns; they stay and go unwritten.
- **Schema:** forward-fix, never revert (change-management policy). If the
  columns must go, a new migration drops the two constraints and then the two
  columns, shipped only after no running image writes them.
