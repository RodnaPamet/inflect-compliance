# 2026-08-18 — safeFetch egress decoupled from Node's bundled undici

**Commit:** `<pending>` fix(automation): source safeFetch's fetch from undici so an undici major cannot break egress

## Design

`safeFetch` defends against SSRF by resolving the target, checking every
resolved address is public, and then pinning the connection to those addresses
with a custom `lookup` on an undici `Agent`. The pin is what defeats DNS
rebinding — without it, a hostname can resolve to a public address for the
check and a private one for the connection.

Pinning requires a dispatcher, and a dispatcher has to be handed to a fetch
implementation. The code handed it to the **global** `fetch`:

```
    npm `undici` package  ──> Agent (dispatcher)
                                  │
                                  ▼
    Node's BUNDLED undici ──> global fetch
```

Those are two different copies of undici at two different versions. The handoff
works only while their internal dispatcher-handler interfaces agree — an
undocumented coupling with nothing in the type system to express it, because
both sides type as `Dispatcher`.

undici 8 changed that interface. Verified against a local `node:http` server on
Node 22.23.2:

| undici | `fetch(url, { dispatcher })` |
| --- | --- |
| 7.29.0 | `200 OK` |
| 8.10.0 | `TypeError: fetch failed` → cause `invalid onRequestStart method` |

The fix removes the boundary rather than tracking it: import `fetch` from
`undici` alongside `Agent`, so both halves are always the same copy at the same
version.

```
    npm `undici` package  ──> Agent ──> undici fetch      (one version, no seam)
```

Verified version-agnostic — identical results on 7.29.0 and 8.10.0, with
`redirect: 'manual'` still surfacing the 302 and the DNS pin still forcing an
unresolvable hostname to the pinned address. That is what lets this land ahead
of the bump instead of alongside it.

## Why this was worth pre-empting

`safeFetch` is the egress path for exactly two callers, and both are
fail-silent:

- `events/audit-stream.ts:178` — signed audit batches to a tenant's SIEM.
  Delivery is deliberately out-of-band and fail-safe (the audit row is already
  committed), so a total failure surfaces only as an absence.
- `automation/action-executor.ts:504` — every automation webhook action.

So the bump would have stopped all SIEM delivery and failed every webhook, with
a diff containing no application code to review.

CI would not have caught it. Every pre-existing test reaches `safeFetch` through
a mocked `node:dns` or a stubbed `global.fetch`, so none exercised the real
dispatcher handoff — the one interaction that breaks.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/automation/webhook-safety.ts` | Import `fetch` from undici; call it instead of the global. |
| `tests/unit/webhook-safety-dispatcher-egress.test.ts` | New. Drives a real pinned dispatcher against a real local server. |
| `tests/unit/webhook-safety.test.ts` | Existing redirect tests moved from the `global.fetch` seam to the undici one. |
| `tests/unit/automation-action-executor.test.ts` | Same seam move for the webhook-action test. |
| `docs/_status/doc-classification.json` | Classifies this note. |

## Decisions

- **Import undici's fetch rather than pin undici to `^7`.** Pinning treats the
  symptom and leaves the coupling in place for the next person to rediscover;
  it also blocks undici majors indefinitely for an unrelated reason.

- **`Agent` stays real in the redirect tests; only the transport is stubbed.**
  Mocking the whole `undici` module would hide a future break in how the pinned
  dispatcher is constructed — which is the part carrying the security property.

- **The behavioural tests are the protection, but one structural assertion
  covers the gap they cannot.** On undici 7 a revert to the global `fetch` still
  works, so the behavioural tests would stay green until the major landed —
  reproducing the exact silent interval this change exists to remove. One
  assertion checks the egress call does not cross the boundary, and it strips
  comments first, because the module's own prose discusses the global `fetch(`
  and would otherwise satisfy the check by itself. Delete it once undici 8+ is
  the floor.

- **The `safeFetch` return is cast to the global `Response`.** undici's
  `Response` is spec-compatible and both callers use it as an ordinary
  `Response`; widening the signature would push an undici type into two
  unrelated call sites for no behavioural gain.

- **Dependabot PR #1963 was not merged.** It is green and would have shipped the
  outage. It should be re-evaluated on its merits once this is on main.
