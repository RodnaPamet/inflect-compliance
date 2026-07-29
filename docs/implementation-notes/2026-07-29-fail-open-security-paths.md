# 2026-07-29 — Two fail-open paths in security controls

**Commit:** `<sha>` fix(security): close two fail-open paths — session-policy silence, safeFetch redirect

Both were surfaced while implementing the tenant security-settings write path
(`2026-07-29-tenant-security-settings-write-path.md`) and logged there as
adjacent weaknesses. They ship together because they are the same class —
a security control that stops applying without anyone finding out — and both
bear directly on the feature that change made reachable.

## 1. Session policy resolved in silence

`session-tracker.ts` read the tenant's session policy inside a bare `try/catch`
whose entire body was a comment:

```ts
} catch {
    // Fall back to unlimited / NextAuth default lifetime.
}
```

On any error the concurrent-session cap AND the lifetime cap silently stop
applying, for every sign-in, until someone notices — and nothing anywhere makes
it noticeable.

**Staying non-blocking was kept, deliberately.** It is not an oversight in the
surrounding code: eviction failure logs a warning and continues, and the row
insert is explicitly documented as "observable but never block sign-in".
Failing closed here would convert a transient database blip into a tenant-wide
sign-in outage — the worse trade for most operators, and inconsistent with
every sibling handler.

What was not defensible is that this was the ONE handler in the file that
swallowed in *total* silence. It now:

- **retries once** — the stated concern is a transient blip, and one retry
  removes most of the window;
- **logs at ERROR**, not warn, naming the tenant and saying plainly that the
  caps are not being applied;
- **increments `session.policy.resolution{outcome}`**, so the lapse is
  alertable rather than merely loggable.

The metric is registered on the SLO alerting rules rather than parked in the
`diagnosticOnly` exemption — putting it there would have meant "alerted ad-hoc",
which is precisely the property being fixed.

## 2. `safeFetch` followed redirects unchecked

`safeFetch` never set `redirect: 'manual'`, so `fetch` followed up to 20 hops
while `assertPublicAddress` had validated only the FIRST url — and the undici IP
pin does not survive a hop, because Node's `net.connect` skips `options.lookup`
for IP-literal hosts.

An attacker-controlled public endpoint answering

```
302 Location: http://169.254.169.254/latest/meta-data/
```

reached cloud metadata with the scheme check, the host blocklist AND the pin all
bypassed on the redirect leg. There was no redirect test in the suite at all.

**Refused rather than re-validated per hop**, deliberately. Re-validating would
prove only that the NEXT host is public — not that it is a host the operator
ever configured. This client POSTs signed audit batches and automation payloads;
sending that body to a destination nobody entered is the thing worth preventing,
and a per-hop public-address check does not prevent it. A redirect on a POST
endpoint is also a misconfiguration signal, not a normal pattern.

`redirect: 'manual'` is applied AFTER the caller's `init` spread, so a caller
cannot reinstate `'follow'` and reopen the hole. A test asserts exactly that.

### The part that would have been a regression

Both consumers caught `SsrfBlockedError` and **rethrew everything else**. Left
alone, the new `RedirectNotAllowedError` would have escaped as an unhandled
throw — retry storms in the audit streamer (three POSTs of a signed batch to an
endpoint that will redirect again) and a failed dispatcher path in automation.

A redirect is a *configuration* error, so both now map it to the same
non-retryable outcome as an SSRF block, with a distinct message so an operator
sees "your endpoint redirects" rather than "your endpoint is forbidden".

## Files

| File | Role |
|---|---|
| `src/lib/security/session-tracker.ts` | New `readTenantSessionPolicy` — retry + ERROR log + metric. |
| `src/lib/observability/metrics.ts` | New `session.policy.resolution` counter. |
| `infra/observability/prometheus/rules/alerting-rules.yml` | Alert on a sustained non-zero failure rate. |
| `src/app-layer/automation/webhook-safety.ts` | `redirect: 'manual'` + `RedirectNotAllowedError`. |
| `src/app-layer/events/audit-stream.ts` | Maps the redirect refusal to a non-retryable 403. |
| `src/app-layer/automation/action-executor.ts` | Maps it to a clean `{ ok: false }` outcome. |
| `tests/unit/webhook-safety.test.ts` | 7 redirect cases — there were none. |
| `tests/unit/automation/action-executor.test.ts` | Redirect outcome + the mock export it exposed. |

## Decisions

- **Fail-open kept for session policy, fail-closed for redirects.** They look
  like opposite calls; they follow the same rule. Availability loss is the
  dominant risk when the control protects an *ongoing* session, so degrade
  loudly. Payload delivery to an unverified host is the dominant risk when the
  control protects an *outbound request*, so refuse. Neither is "fail closed
  because security".

- **Every new assertion was mutation-proved.** Removing the 3xx throw fails 6
  tests; dropping `redirect: 'manual'` fails 2. Written after the previous PR
  shipped 24 passing tests that were blind to a blocking bug, so a passing suite
  is no longer taken as evidence on its own.

- **The action-executor mock gained `RedirectNotAllowedError` with a comment
  explaining why.** Its absence produced
  `Right-hand side of 'instanceof' is not an object`, which surfaced as a
  *different* test failing with a misleading message. A partial module mock
  fails in a way that points at the wrong line, so the mock now says it must
  mirror every referenced export.
