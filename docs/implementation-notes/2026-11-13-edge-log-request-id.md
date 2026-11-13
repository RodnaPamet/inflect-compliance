# 2026-11-13 — Edge log lines reach Cloud Logging

**Commit:** `fix(obs, docs): edge lines carry a requestId; …` (#5492; issues #5131, #5132, #5135, #5310)

## Design

The production Ops Agent (`deploy/ops-agent-config.yaml`) keeps a container line
only when its text contains both `requestId` and `msg`. The Node logger always
writes `requestId`; `edgeLogger` never did, so every edge line was dropped at
the VM: the middleware's `document_load` / `soft_navigation` denominator and
every edge warning (consent callbacks, webhook verification, edge rate limits).

`emit()` in `src/lib/observability/edge-logger.ts` now always writes
`requestId` — the caller's if given, else `'unknown'`, the Node logger's
fallback — and the middleware passes its own id on the two denominator lines.

## Files

| File | Role |
| --- | --- |
| `src/lib/observability/edge-logger.ts` | `requestId` on every line |
| `src/middleware.ts` | passes `requestId` on the two denominator lines |

## Decisions

- **Written after the caller's fields**, so a caller cannot remove it by
  passing `requestId: undefined`; a caller's non-empty string still wins.
- **`'unknown'`, not omission**, for a line with no request in scope: the
  filter needs the word, and the Node logger already uses that value, so one
  query reads both.
- **Shipped after #5130**, which collapsed bearer tokens in the logged route;
  shipping these lines first would have sent share and invite tokens to Cloud
  Logging.
