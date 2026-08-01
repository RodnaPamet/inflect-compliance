# 2026-08-01 — AI risk suggestions on the posture summary's Claude key

**Commit:** `<pending> feat(ai): add an Anthropic provider for risk suggestions`

## Design

### What was asymmetric

`ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` (default `claude-haiku-4-5`) already
existed, but only one feature could use them: the compliance-posture summary
behind the dashboard hero (`AI_POSTURE_PROVIDER=anthropic`). Risk suggestions
could reach a real LLM only through OpenRouter or a self-hosted gateway —
`AI_RISK_PROVIDER` had no `anthropic` arm at all.

So an operator who wanted both features on a real model needed two vendors, two
keys, two spend lines, and two model-pinning decisions. This adds the missing
arm: `AI_RISK_PROVIDER=anthropic` now calls the Claude Messages API with the
**same credential and the same default model** the hero is wired to.

### Where the new provider sits

```
getProvider(sel)
  │
  ├─ sel.residency === 'LOCAL_ONLY' ──▶ buildLocalProvider()   ← HARD short-circuit
  │                                      (local gateway, else stub)
  │
  └─ switch (AI_RISK_PROVIDER)
       ├─ 'local'      ──▶ buildLocalProvider()
       ├─ 'openrouter' ──▶ OpenRouterRiskSuggestionProvider   ← EXTERNAL
       ├─ 'anthropic'  ──▶ AnthropicRiskSuggestionProvider    ← EXTERNAL (new)
       └─ default      ──▶ StubRiskSuggestionProvider
```

The new arm is **inside the switch**, which is only reached after the
`LOCAL_ONLY` return. That placement is the whole residency story: a LOCAL_ONLY
tenant cannot construct it, let alone call it.

### Why it mirrors the posture provider rather than using the SDK

`@anthropic-ai/sdk` is not a dependency of this repo. The existing
`compliance-posture/anthropic-provider.ts` calls `POST /v1/messages` over plain
`fetch`, and the new provider is a direct structural sibling of it — same URL,
same `x-api-key` + `anthropic-version` headers, same abort-controller timeout,
same "any failure degrades, never throws" contract.

Adding an SDK for the second of two call sites would have meant a new runtime
dependency (npm-audit + Trivy surface, bundle weight) to duplicate ~40 lines
that already exist and already work. The repo's own convention won.

### The one place the two providers genuinely differ

The OpenRouter provider asks for `response_format: { type: 'json_object' }` and
can therefore call `JSON.parse` on the body directly. **The Claude Messages API
has no request-level JSON mode**, so the model may return the object inside a
` ```json ` fence or wrapped in a sentence of prose. The new provider carries a
tolerant `extractJsonObject` (fence → bare parse → first-`{`-to-last-`}`),
mirroring what the posture parser already does for the same reason.

Truncation is also named explicitly: `max_tokens` matches the OpenRouter
sibling's 4096 so the same feature behaves the same whichever provider serves
it, and a response carrying `stop_reason: "max_tokens"` throws a message that
says *truncated*, rather than surfacing as a confusing JSON parse error three
lines later.

### Sub-processor scope actually changed

This is the part that is not merely configuration. `docs/sub-processors.md`
described Anthropic as receiving **"aggregate compliance-posture metrics
(counts + percentages only — no PII, no entity text)"**. That was true when the
posture summary was the only caller.

Risk-assessment prompts are not aggregates — they carry risk titles,
descriptions, asset names, and tenant industry/context, i.e. the same business
content the OpenRouter row already declares. Enabling `AI_RISK_PROVIDER=anthropic`
therefore widens what that sub-processor receives, and the customer-facing
inventory would have become inaccurate had it been left alone. The entry now
splits the two payloads explicitly, keyed to the env var that enables each.

## Files

| file | role |
| --- | --- |
| `src/app-layer/ai/risk-assessment/anthropic-provider.ts` | the provider — Messages API call, tolerant JSON extraction, truncation naming, AISVS model-pin/mismatch/usage handling, stub fallback |
| `src/app-layer/ai/risk-assessment/index.ts` | `case 'anthropic'` inside the switch (after the LOCAL_ONLY short-circuit); factory docblock lists all four arms |
| `src/env.ts` | `AI_RISK_PROVIDER` documents its four values; `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` marked as shared by two features with different payload sensitivity |
| `docs/sub-processors.md` | Anthropic row + section split into posture (aggregates) vs risk suggestions (business content) |
| `tests/guards/ai-residency-enforcement.test.ts` | generalised from "never OpenRouter" to "never ANY external provider", plus a pinned-constructor-set ratchet |
| `tests/unit/ai/anthropic-risk-provider.test.ts` | provider behaviour — request shape, usage mapping, fenced/prose bodies, every degradation path |
| `docs/_status/doc-classification.json` | classifies this note |

## Decisions

- **Reused `ANTHROPIC_API_KEY` rather than adding `AI_RISK_ANTHROPIC_KEY`.**
  Sharing the credential is the point of the change — one key to rotate, one
  spend line, one model pin. A guard test asserts the factory passes exactly
  `env.ANTHROPIC_API_KEY` + `env.ANTHROPIC_MODEL`, so a later refactor that
  quietly introduces a risk-specific variable fails rather than silently
  splitting the two features apart.

- **The residency guard was generalised, not extended.** Adding a second
  external provider to a guard whose name and assertions said "OpenRouter"
  would have left the next provider unprotected. It now derives the external
  set from the factory source (`new \w*RiskSuggestionProvider`), asserts every
  one of them is constructed after the `LOCAL_ONLY` return, and **pins the full
  constructor set** — so a third provider fails the ratchet until someone
  classifies it as external or not. That failure is the moment to decide
  whether LOCAL_ONLY may reach it, which is exactly when the decision should be
  made.

- **`max_tokens` matches the OpenRouter sibling (4096) rather than a larger
  default.** Two providers serving one feature with different output budgets
  would truncate at different points, making the feature's behaviour depend on
  invisible config. Parity is worth more than headroom here, and the explicit
  `stop_reason` check means hitting the cap is legible in the logs instead of
  looking like a malformed model response.

- **The model default is `claude-haiku-4-5`, not the newest model.** The
  request is bounded and schema-constrained, the posture summary already runs
  there, and "the same model the hero uses" is the property being asked for.
  `ANTHROPIC_MODEL` overrides it, and an override is logged once at
  construction (AISVS C12.4.3) so a runtime swap is never silent.

- **No change to the sanitiser, egress guard, rate limiter, or inference log.**
  Those live in the usecase around the provider, not inside it — the new
  provider inherits them by implementing the same `RiskSuggestionProvider`
  interface, which is why the diff is one file plus a switch arm.
