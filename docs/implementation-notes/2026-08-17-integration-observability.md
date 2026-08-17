# 2026-08-17 — Integrations: making the hardening visible

**PR:** #1959 — feat(observability): instrument the integrations hardening

## Design

The four preceding PRs each added a behaviour whose only signal was a log line:

| Behaviour | Signal before |
| --- | --- |
| a throttle absorbed, or deferred to the next tick | `logger.warn` |
| a credential marked revoked, or recovered | `logger.warn` / `logger.info` |
| a queue retry deliberately suppressed | nothing |
| a fan-out enqueue dropped | `logger.error` |
| a sync lock contended, or a lease reaped | `logger.info` / `logger.warn` |

Every one is something an operator would want to alert on, and none was
countable. Modelled on the Epic E.2 audit-stream set (success/failure counters
plus an attempts histogram for retry pressure), because the failure shapes are
the same: an out-of-band path that fails safe, where the only way to notice
degradation is a metric.

The two most useful:

- **`integration.http.throttled{outcome}`** — `absorbed` vs `deferred`. A
  rising `absorbed` rate is a provider getting tighter. Any sustained `deferred`
  rate means syncs are being pushed to the next cycle, which is the point at
  which data starts going stale and nothing else says so.
- **`integration.sync.lock{outcome=reaped}`** — a lease was taken from a
  previous holder, so either syncs are overrunning their TTL or workers are
  being killed mid-sync. Both need a human.

## Cardinality was the real design problem

The natural label for an HTTP metric is the host. It is also unusable here:
Okta and SharePoint hosts are **per-tenant** (`acme.okta.com`,
`contoso.sharepoint.com`), so labelling by host creates one metric series per
customer. That is the classic way to take down a metrics backend with an
observability change — a worse outage than the one the metric was added to
detect.

`providerLabelFor` maps a URL onto a fixed set of known provider suffixes and
falls back to a single `other`, so an unrecognised provider costs one shared
series rather than unbounded ones. Matching is on a host boundary (`===` or
`.suffix`), not a bare substring, so `notokta.com` and
`okta.com.attacker.test` do not merge into the `okta` series.

## Files

| File | Role |
| --- | --- |
| `src/lib/observability/integration-metrics.ts` | Six new recorders. |
| `src/app-layer/integrations/http-resilience.ts` | Throttle + attempts; `providerLabelFor`. |
| `src/app-layer/integrations/connection-health.ts` | Auth marked/recovered. |
| `src/app-layer/integrations/connection-lock.ts` | Lock acquired/busy/reaped/release_lost. |
| `src/app-layer/jobs/fan-out.ts` | Dropped enqueues. |
| `src/app-layer/jobs/executor-registry.ts` | Queue-retry bypass, by reason. |

## Decisions

- **Counters, not a gauge of currently-broken connections.** A gauge would need
  a per-scrape DB query across every tenant. The `marked` rate is the alertable
  signal, and `recovered` is what distinguishes "an operator fixed it" from "the
  alert simply went quiet".

- **`recovered` fires only when something was actually cleared.** Counting every
  success-path call would drown the signal in the common case and make an
  operator's fix indistinguishable from a routine sync.

- **The lock gained a read, and it is deliberately not load-bearing.** Labelling
  `acquired` vs `reaped` needs the prior state, so `acquireSyncLock` now reads
  before it claims. The claim is still the single conditional UPDATE — a stale
  read can only mislabel a counter, never admit a second concurrent sync. The
  test asserts exactly that, including the case where the read is stale.

- **A comment tripped the `: any` ratchet.** The prose "counted: any non-zero
  rate" matched the regex. Reworded rather than touching a repo-wide ratchet
  from an observability PR — changing its comment handling could unmask real
  occurrences elsewhere and make this diff unpredictable.
