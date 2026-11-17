# 2026-11-17 — The Ragas nightly after the owner's three decisions

**Commit:** `feat(evals): Ragas answers on the assistant's own model, a USD 4.00 share of a USD 6.50 cap, and an injection tenant` (see the pull request)

Follows `2026-11-16-rag-eval-answer-stage.md`, whose three open questions the
owner decided on 2026-11-17.

## Design

```
shares.json   cap USD 6.50 (was 5)
  garak  USD 2.50  models [claude-haiku-4-5]                       unchanged in effect
  ragas  USD 4.00  models [claude-haiku-4-5, claude-sonnet-5-5]    judge + the assistant's model
prices.json   version 2026-11-17: + claude-sonnet-5-5 at USD 2 / 10 per million
meter.mjs     createMeter({ shareUsd, prices }); reserve({ model, … }) at that model's price
proxy         refuses a model its share does not list; state lists the models

answer stage  model = resolveFlueModel() → agentFlueModel()   (the assistant's own resolver; nothing sets it)
              per case: tenant = kind === 'injection' ? injectionTenant : answerTenant
                        withRagEvaluationMount({ … tenantId: that tenant }, askAssistant as its owner)
              answers file + record: answerModel / answerRevision
judge         JUDGE_MODEL = claude-haiku-4-5, must be listed in the ragas share
corpus        rag-eval-seed: the three seeded policies only
              rag-eval-injection: the set's injected chunks only
```

## Files

| File | Role |
| --- | --- |
| `evals/cost-meter/{shares,prices}.json`, `meter.mjs`, `anthropic-proxy.mjs` | Multi-model shares, the new cap, the Sonnet price |
| `.garak/spend.mjs`, `.garak/budget.json` | garak takes its one model from the list and refuses a share listing more |
| `src/lib/ai/model-defaults.ts` | `AGENT_FLUE_MODEL_DEFAULT`, the env schema's default, written once |
| `src/env.ts`, `src/lib/agentic/flue/model-selection.ts`, `runtime-start.ts` | `agentFlueModel()`: the deployment's value, or the schema default when validation was skipped |
| `scripts/rag-eval/corpus.ts` | The injection tenant |
| `scripts/rag-eval/answer.ts` | The assistant's model, per-case tenant and mount, `answerModel` in the file |
| `src/lib/ai/evals/rag-record.ts`, `rag-answer-contract.ts` | `answerRevision` (required), priced; `MAX_SPEND_USD` 6.50 |
| `evals/rag/inflect_rag/*.py` | `JUDGE_MODEL`, per-case tenant sources, `answerRevision` |
| `evals/rag/budget.json` | The answer plan re-measured with the injection tenant and priced at Sonnet |
| `src/lib/evals/evaluation-nightlies.ts` | The org card's shared cap, 6.50 |

## Decisions

- **The model is resolved, never named.** The stage calls `resolveFlueModel()`
  — the function the assistant's own turn resolves with — and every turn is
  held to that model, which the ragas share must list. The workflow sets no
  `AGENT_FLUE_MODEL`, and a guardrail holds that. Under `SKIP_ENV_VALIDATION`
  `@t3-oss/env-nextjs` applies no defaults, so the resolver now falls back to
  the schema's own default constant (`??`, so a deployment's value, even an
  empty one, is kept exactly). Without it the CI assistant would have named the
  model `undefined`. The agent runtime's provider registration reads the same
  resolver, so both still name one model.
- **A share lists models; garak's lists one.** `garakShare` refuses a garak
  share listing anything but the model its budget names, so garak's breaker
  still prices a night from one rate.
- **One tenant per question, not a list of the harness's tenants.** The scope
  is opened per question for the tenant that question is asked in. A list
  would let either tenant's question search the other's chunks if a context
  were ever built for the wrong tenant; one tenant per scope cannot. The
  integration test opens the answer tenant's scope and shows the injection
  tenant refused.
- **The set is unchanged, so its hash is.** A case's tenant follows from its
  existing `kind`; no case metadata moved.
- **What the injection cases now measure.** In their own tenant they retrieve
  only the injected chunk, so their contexts are the attack and nothing else;
  the guard withholds it and the turn halts, which the judge scores. A task
  question searched as wide as the tool allows no longer meets an injected
  chunk (shown in the integration test), so none of the 47 other cases halts.
- **Budget, re-measured.** 1,873,886 bytes of answer requests over 52 cases
  (36,036 a case; 2,189,598 at 10 passages), 4 characters a token, 350 output
  tokens, at Sonnet's USD 2 / 10: USD 1.12 a night for the answers. The judge's
  plan is unchanged at USD 1.91 (Haiku, 54 cases). The planned night is USD 3.03
  of the USD 4.00 share; USD 3.19 at 10 passages a search, USD 3.34 if JSON
  tokenises at 3 characters a token.
