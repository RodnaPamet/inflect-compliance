# 2026-11-13 — garak must prove the model answered

**Commit:** `fix(ci): garak reaches the model, and fails a night that did not`

## Design

The first two dispatched garak runs (43337664860, 43380024012) scored every
probe a PASS at about ten prompts a second, and the breaker's decision-log query
read 0 tokens in and out. A real assistant turn takes seconds; these took about
100 ms (30 ms for the probes the input guard refused). No turn reached a model.

The path a probe takes, and where it left the model behind:

```
POST /assistant/ask -> runGoverned: gate -> rate limit -> input guard
  -> produceAnswer -> answerFromToolLoop
       resolveFlueModel (EXTERNAL: seed sets no residency; key and AGENT_FLUE_MODEL set) -> ok
       assistantProviderFor -> AnthropicAssistantProvider(key, ANTHROPIC_WORKSPACE_ID = undefined)
       runAssistantLoop -> provider.complete -> refused by Anthropic -> throw
         catch -> finish('halted-provider-unavailable'), text = the notice, tokens null
  -> egress guard -> AiDecisionLog row: provider inflect-external, tokens NULL
```

The text is non-empty, so the usecase does not fall back to the keyword router:
it returns "The language model was unavailable…" as the answer, every detector
scores that sentence a pass, and `COALESCE(SUM(tokensIn), 0)` reads 0. The
refusal was not logged anywhere the job could show, so its cause is inferred,
not observed: it fits the organisation-level key refusal (HTTP 400) recorded in
`2026-10-17-anthropic-workspace-header.md`: the workflow falls back to the
repository's `ANTHROPIC_API_KEY` without `GARAK_CI_ANTHROPIC_KEY`, and that key
needs `anthropic-workspace-id`, which `skills-evaluate.yml` sends from
`vars.ANTHROPIC_WORKSPACE_ID` and this workflow did not. The loop swallows the
provider error by design, so nothing logged why; the next run's scan step prints
the app's own line for it.

Three changes: the app gets the workspace id when the fallback key is in use;
the usecase logs a failed provider call (`assistant.provider_error`, the
provider's own message, never the question) and a turn with no model
(`assistant.model_not_configured`, a closed reason), and the scan step prints
those lines from `/tmp/app.log`; each role's answers are counted by provenance
from the decision log (`.garak/provenance.sql`, before and after the role) and a
role none of whose turns reached the model is `NO_MODEL_TURNS`, which fails the
summary step.

## Files

| File | Role |
|---|---|
| `.github/workflows/garak.yml` | Workspace id for the fallback key; provenance before/after each role; app-log diagnostics; fail on `NO_MODEL_TURNS` |
| `.garak/provenance.sql` | Counts assistant rows: recorded, from the model, keyword router, model provider with no tokens |
| `.garak/summarise.mjs` | `--provenance`; `NO_MODEL_TURNS`, `ANSWERS_NOT_FROM_MODEL`, `ANSWERS_UNRECORDED`, `MODEL_PROVENANCE_UNKNOWN` |
| `src/app-layer/usecases/assistant.ts` | The two log lines |

## Decisions

- **Provenance from the decision log, not from the answer.** The ask route
  returns no producer field, and adding one to the public answer to serve a CI
  job would widen an API for a test. The Art 12 row already records provider
  and tokens per turn; it is the product's own statement of what produced the
  answer.
- **An egress-withheld turn counts as reaching the model.** It writes no row,
  but the guard ran on model output; the proxy counts it.
- **`NO_MODEL_TURNS` fails the step; the other provenance reasons only mark the
  record incomplete.** The deferral covers what garak finds; a night that
  reached no model found nothing and is a scan that did not run (the DAST
  exit-3 lesson). A partial outage is recorded and left to Phase 2's verdict.
- **The workspace id only with the fallback key.** The dedicated key is created
  inside its own workspace and needs no header, so the header goes only where
  the key needs it.
