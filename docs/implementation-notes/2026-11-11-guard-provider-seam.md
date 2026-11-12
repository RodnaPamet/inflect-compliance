# 2026-11-11 — The AI guard's `GuardProvider` seam

**Commit:** `feat(ai-guard): GuardProvider seam, worst-of composition and a fail-closed NeMo client`

NeMo Guardrails roadmap (`docs/ai-architecture/nemo-guardrails.md`) Phase 1,
minus 1.3 (the server), which the capacity rule holds until C1 lands.

## Design

```
guardUntrustedInput / guardEgress            (index.ts — unchanged API)
  ├─ resolveModeForTenant                     (unchanged, first)
  ├─ scanWithProviders(activeGuardProviders())  providers/compose.ts
  │     ├─ patterns  → scanInjection / scanEgress (same object back)
  │     └─ nemo      → POST {base}/v1/chat/completions via safeFetch
  │                    (only when AI_GUARD_NEMO_BASE_URL is set)
  │   worst-of over verdicts; failed provider = unavailable, never clean
  ├─ resolveEnforcement(mode, composed verdict)  (unchanged)
  └─ audit on non-clean                       (+ decidedBy when >1 provider)
```

A provider answers a verdict and rule ids and nothing else. The tenant's
mode, the enforcement action, the audit row and `GuardOutcome` are still
decided once, above the providers, in `index.ts`. Because `resolveEnforcement`
is monotone in the verdict for a fixed mode and direction, composing worst-of
over verdicts is the same as composing worst-of over actions: block beats flag
beats allow.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/ai/guard/providers/types.ts` | `GuardProvider`, `GuardProviderContext` (requestId + tenantId only) |
| `src/app-layer/ai/guard/providers/patterns-provider.ts` | The deterministic scanners, returned as-is |
| `src/app-layer/ai/guard/providers/compose.ts` | Worst-of, `providerUnavailable`, rule-id namespacing |
| `src/app-layer/ai/guard/providers/nemo-provider.ts` | The NeMo Guardrails HTTP client |
| `src/app-layer/ai/guard/providers/registry.ts` | The only reader of `AI_GUARD_NEMO_BASE_URL` |
| `src/app-layer/ai/guard/index.ts` | Calls the composed provider; `decidedBy` on the outcome and audit row |
| `src/env.ts` | `AI_GUARD_NEMO_BASE_URL` (optional, operator only) |
| `tests/guards/ssrf-egress-coverage.test.ts` | The nemo client joins the safeFetch sink population |

## Decisions

- **Byte-identical means field for field.** `decidedBy` is added to the
  outcome and to the audit row's `detailsJson` only when more than one
  provider was consulted, and a single provider's `ScanResult` passes through
  as the same object. A deployment without the env var therefore produces the
  outcomes and audit rows it produced before; the seam test compares with
  `toStrictEqual` against the pre-seam construction on a fixture set that
  reaches clean and malicious in both directions, including the 64-deep
  unscanned refusal.
- **Unavailable is a verdict, per direction.** Input: `suspicious`, which the
  policy makes `flag` under strict and balanced. Egress: `malicious`, which it
  makes `block`. The rule id `guard.provider_unavailable.<id>` says the guard
  declined rather than found something — the precedent is
  `egr.unscanned.depth_exceeded`. Audit mode still records rather than
  enforces, as it does for every verdict; the verdict is never `clean`.
- **Compose fails closed on its own**, not only the nemo client: a provider
  that throws, rejects or returns a verdict outside the vocabulary is
  unavailable, and an empty provider list is unavailable under the id `none`.
  Zero providers consulted vouches for nothing.
- **"Which provider decided" uses rule ids, not a schema change.** A
  non-patterns provider's ids are namespaced by its id (`nemo.rail.<name>`), so
  the `guardRuleIds` the decision log already stores names the provider. The
  patterns ids (`inj.*`, `egr.*`) stay unprefixed because they predate the
  seam and byte identity requires it.
- **The NeMo request asks for one rail type and reads one thing.** Input sends
  the text as a user message with `options.rails: ['input']`; egress sends it
  as the assistant message with `['output']`; both ask for
  `log.activated_rails`. Only "did an activated rail of that type stop" is
  read; the generated message is ignored. The parser is strict, so a response
  shape it does not recognise fails closed. The shape is NeMo's documented
  server API; it is verified against a live server when 1.3 deploys one, and
  until then a mismatch can only flag or block, never allow.
- **A set but unusable URL is not patterns-only.** `registry.ts` builds the
  provider whenever the value is non-blank; a non-https, credentialed or
  malformed URL makes every scan unavailable. Falling back to patterns alone
  would scan with less than the operator configured — a fail-open.
- **`safeFetch` constrains where the server can live.** It refuses `http:` and
  private addresses (except through the self-hosted egress allowlist), so
  `http://nemo-guardrails:8000` on the Compose network is refused and the
  guard flags or blocks everything. That is the outage rule working, and it is
  the question 1.3 must answer when it adds the service: TLS on the internal
  hop plus an allowlist entry, or a deliberately named operator-internal
  fetch. This slice does not widen `safeFetch`.
- **No change to the Flue or Tool Runner files.** The F5 run-input fix is on
  another branch; both engines reach the seam through `guardUntrustedInput` /
  `guardEgress` with no edit.
