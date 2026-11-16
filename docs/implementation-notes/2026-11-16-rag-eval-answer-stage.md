# 2026-11-16 — The Ragas answer stage: the product's answers, in process, with no gate bypass

**Commit:** `feat(evals): the Ragas nightly asks the product its questions in process, through search_knowledge` (see the pull request)

Ragas 1.2's answer half. It lets the nightly ask the product the set's 52
questions and hand the judge answers it can score, so that a passing record can
exist and open the `search_knowledge` mount gate.

## Design

```
rag-eval.yml, judge step (after corpus + retrieval)
  proxy  COST_METER_MAX_OUTPUT_TOKENS=8192 node evals/cost-meter/anthropic-proxy.mjs   holds the key, the ragas share
  unset ANTHROPIC_API_KEY
  ANSWER  ANTHROPIC_API_KEY=held-by-the-metering-proxy AGENT_FLUE_MODEL=<share model> npx tsx scripts/rag-eval/answer.ts
          for each case, as the answer tenant's OWNER:
            withRagEvaluationMount({MOUNTED, measured revision, answer tenant}, () =>
              askAssistant(ctx, { question }, { turnProvider }))           ← the real usecase
                feature gate · rate limit · input guard
                tool loop ── offer (search_knowledge mounted by the scope)
                          ── runGuardedTool → runReadTool → searchKnowledge → pgvector under RLS
                          ── model turn: the product's AnthropicAssistantProvider → http://127.0.0.1:8787/v1/messages
                egress guard · decision log
            contexts = the search_knowledge results as the model saw them (read off the next request)
          → rag-out/answers.json (rag-answers@1: COMPLETE, or BUDGET_EXHAUSTED + the cases not reached → exit 5)
  JUDGE   docker run inflect-ragas:ci --answers /out/answers.json …   (only when the answers are COMPLETE)
```

The gate is consulted at five places (the invocation's pinned manifest, the
offer, the unmounted list, the funnel's resolution, the usecase), all through
`getKnowledgeSearchMount()`. That one reader now answers the evaluation's
decision when the call runs inside `withRagEvaluationMount`
(`src/app-layer/services/rag-evaluation-mount.ts`, an `AsyncLocalStorage`
scope), and the committed records otherwise.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/services/rag-evaluation-mount.ts` | The scope: one opener, one reader; both refuse in a production process |
| `src/app-layer/services/knowledge-search-mount.ts` | `getKnowledgeSearchMount` asks the scope first; the decision type gains the evaluation variant |
| `src/app-layer/usecases/knowledge-search.ts` | The evaluation decision admits its answer tenant only (`EVALUATION_SCOPE_OTHER_TENANT`) |
| `src/app-layer/usecases/assistant.ts` | `askAssistant(ctx, input, deps?)`: the `turnProvider` seam; `GUARD_REFUSAL_SENTENCE`, `isGuardRefusal` exported |
| `src/app-layer/ai/assistant/turn-provider.ts` | `AnthropicAssistantProvider`'s optional third argument, the endpoint |
| `src/lib/ai/evals/rag-answer-contract.ts` | `RagAnswersFileSchema` (`rag-answers@1`) |
| `scripts/rag-eval/answer.ts` | The stage: the asker, the scope, the capturing provider, the file |
| `scripts/rag-eval/corpus.ts` | `corpusOwnerEmail`, shared with the stage |
| `evals/rag/inflect_rag/{answers,run,meter}.py` | `FileAnswerTarget` replaces the HTTP target; `--answers`; the meter only reads |
| `evals/rag/fixtures/answer-contract.json`, `mini-record.golden.json` | The answers-file examples; the golden's spend no longer double-counts answers |
| `evals/rag/budget.json` | `plannedAnswer`, measured |
| `.github/workflows/rag-eval.yml` | The answer stage in the judge step; `RAG_EVAL_ANSWER_URL` gone |
| `tests/guards/rag-evaluation-mount-unreachable.test.ts` | The import-graph and call-site proof |
| `tests/guardrails/rag-eval-workflow-pinning.test.ts` | The stage's wiring and the plan with answers |

## Decisions

- **No route, no flag (owner rule for this task: no gate bypass may exist in a
  deployed app).** The answers are produced by a script in the CI job, against
  its own loopback database. The opener is a function the script calls; the
  guard walks every git-listed module under `src/` and `scripts/` with the
  TypeScript parser and fails if anything under `src/` names it, if the gate
  imports more than the reader, if `src/` imports from `scripts/`, or if any
  route, page, layout, the middleware, the instrumentation hook, the worker or
  the scheduler reaches `scripts/rag-eval/`. A production process refuses the
  scope at both ends as a second line. There is no value of any variable that
  opens the gate in a running app.
- **A scope, not a parameter threaded through the funnel.** The task's
  suggested shape was a `deps` parameter production never passes. The mount is
  read in five places inside the MCP authorization layer; threading a
  parameter through `buildMcpInvocation`, `allReadTools`, `runReadTool` and
  the tool's `run` would change the funnel's signatures and add five places a
  production caller could pass it. One reader with one importer is smaller and
  is what the guard can prove. The model client, which is not a gate, IS a
  parameter (`askAssistant`'s third), and the guard holds that every call in
  `src/` passes two arguments.
- **The answers are the share's model's (Haiku 4.5), not the deployment's
  `AGENT_FLUE_MODEL`.** The proxy prices one model per share and refuses any
  other; the stage refuses a turn for another model before it is sent. The
  retriever is what the record is keyed by and what the gate measures; the
  answer model is not part of the key. Measuring answer quality on the
  production model would need a price-table entry and a share decision.
- **Contexts are what the model saw.** Read off the loop's next request, so a
  result the guard withheld (the turn then halts) is not a context, and a
  result cut at the loop's 24 KB bound keeps its whole hits.
- **Spend is charged once.** The answer turns go through the proxy's
  `/v1/messages` like the judge's calls; the Python side no longer reserves an
  answer's worst case (the old HTTP target did, which would have charged every
  answer twice), and the golden record's spend moved accordingly.
- **A budget refusal stops the night with no record.** The stage stops at the
  first 402, discards that case's partial answer and writes BUDGET_EXHAUSTED
  with the cases it did not reach; the workflow then runs no judge. Were the
  file judged anyway, the reader turns a missing case into the budget stopping
  the run and the record says BUDGET_EXHAUSTED, which never passes.
- **Any other failure is the stage failing.** No model call, an unavailable
  search, a search under another embedding model, a tool error, a refusal that
  is not the content guard's: exit 1, no file. A provider failure that is not
  the 402 is retried once per question. The content guard withholding a turn
  is an answer the product gave, recorded as the sentence the person would see.
- **Budget: it fits, by about one per cent.** Measured: the answer turns of the
  52 cases are 1,849,982 bytes of request (35,577 a case; 1,918,100 at a
  10-passage limit). At the 4 characters a token the judge's plan counts, and
  350 output tokens a case: USD 0.0107 a case, USD 0.55 a night. With the
  judge's measured plan (USD 0.0354 a case at 10 contexts, 54 cases with the
  sentinels: USD 1.91), the planned night is USD 2.47 of the USD 2.50 share.
  The judge's plan assumes 10 contexts; the product's default is 5, so a real
  night should cost less. If JSON tokenises at 3 characters a token the
  answers cost USD 0.71 and the night USD 2.62, over the share: the proxy then
  stops it BUDGET_EXHAUSTED and no record is written.
- **What the measurement showed about the corpus.** The set's injected chunks
  live in the answer tenant beside the policies. A search whose results carry
  one is withheld whole by the content guard and the turn halts, so a task
  question near an injected topic is answered "I stopped…" with no contexts.
  With the stub embedder that was 6 of 52 cases at the default limit and 14 at
  a limit of 10. That is the product's behaviour, and the stage records it; it
  will lower task-case metrics on the first record.
