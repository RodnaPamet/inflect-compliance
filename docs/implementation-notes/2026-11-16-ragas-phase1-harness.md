# 2026-11-16 — Ragas Phase 1: the harness, the retrieval figures and the nightly

**Commit:** `feat(evals): Ragas Phase 1 — the RAG eval harness, D-L4-9's retrieval figures and the rag-eval nightly`

## Design

```
rag-eval.yml (00:40 UTC; off unless RAG_EVAL_ENABLED=true; non-blocking until 2027-02-28)
  Postgres (pgvector image) · Redis · TEI (the canonical Compose digest, model and Hub revision)
  │
  ├─ 1 CORPUS   scripts/rag-eval/corpus.ts      product usecases + the index job only
  │     answer tenant  rag-eval-seed     the three seeded policies + the set's injected chunks
  │     probe tenant   rag-eval-probe    the same policies + distractors → RAG_EVAL_PROBE_TENANT_CHUNKS (5,000)
  │     filler tenants rag-eval-filler-  distractors until the index holds RAG_EVAL_SCALE_MULTIPLE (4) × the probe tenant
  │
  ├─ 2 RETRIEVAL scripts/rag-eval/probe.ts      no model call, no spend
  │     ANN    VectorRepository.search, k = 10, timed       (through search-seam.ts)
  │     EXACT  the store's statement, seq-scanned, in a transaction of the stage's own; its plan read and refused if it touches HNSW
  │     every question's ANN plan read; a run whose plans disagree with the revision is refused
  │     → retrieval.json: setHash, retrieverRevision, probeCorpus, per-case retrievalProbe
  │     scripts/rag-eval/check.ts --probe → recall@10 vs exact, p95, read against D-L4-9
  │
  └─ 3 ANSWER + JUDGE  evals/rag (image; its tests are the first build stage)
        only when RAG_EVAL_ANSWER_URL is set — today it is not, so no record
        node evals/cost-meter/anthropic-proxy.mjs   holds ANTHROPIC_API_KEY and the ragas share
        python -m inflect_rag.run                   sentinels → for each case: ask the product
                                                    (answer-contract.json), map its chunks to the
                                                    answer tenant's sources, Ragas's 4 metrics +
                                                    abstention → record.json
        scripts/rag-eval/check.ts --record          checkRagEvaluationRecord + price table + share
        artifact: commit/evals/rag/records/<ragRetrieverRevisionId>.json for a person's PR
```

## Files

| File | Role |
| --- | --- |
| `.github/workflows/rag-eval.yml` | The nightly. |
| `scripts/rag-eval/corpus.ts` | Builds the three kinds of tenant through the product; writes an id-only manifest. |
| `scripts/rag-eval/probe.ts` | The retrieval stage: ANN vs the stage's own exact scan, latency, plans. |
| `scripts/rag-eval/search-seam.ts` | The one place the probe meets the search: the ANN query, the store's settings, the revision. |
| `scripts/rag-eval/check.ts` | Validates a record or summarises a probe; prints the revision id. |
| `scripts/rag-eval/shared.ts` | Loopback guard, argument parsing, deployment vs stub embedder. |
| `evals/cost-meter/anthropic-proxy.mjs` | The metering proxy: the only socket the judge has to Anthropic. |
| `evals/rag/inflect_rag/` | The judge (`judge.py`), the answer contract (`answers.py`), the meter client, the record builder, the CLI. |
| `evals/rag/{Dockerfile,pyproject.toml,requirements.lock,budget.json}` | The image, the pins, the plan against the share. |
| `evals/rag/fixtures/` | The answer contract, a four-case slice of the set and the golden record the Python harness writes. |
| `src/lib/ai/evals/rag-record.ts` | `probeCorpus` (optional), `retrievalFloorFigures` exported, `probeCorpusFigures`, `ragRetrieverRevisionId`. |
| `src/lib/ai/evals/rag-retrieval-floors.ts` | D-L4-9's two floors and a reading against them. |
| `src/lib/ai/evals/rag-answer-contract.ts` | The answer route's response schema, for the route #5751's follow-up builds. |

## Decisions

- **The recall figure needs a probe tenant that is not seed-sized.** Measured
  locally (Postgres 16, pgvector 0.8.7): the seed corpus is 47 chunks, and at
  that size the planner reads the tenant's B-tree and sorts — an exact search —
  even with sequential scans disabled, so recall@10 is 1 by construction and
  says nothing about the index. At 3,000 chunks in a 9,000-row index every
  question was planned on HNSW (and the stub embedder's vectors scored 0.75 —
  the harness finds what it exists to find). So the figures come from a probe
  tenant grown to a stated size with distractors (real sentences from the
  template library, recombined by a keyed draw, 700–1,150 characters so each
  is exactly one chunk), separate from the answer tenant, whose corpus must
  stay the three policies for the refusal cases' "not in the corpus" to be
  true. The record carries the counts; the multiple is recomputed.
- **Exact is computed by the harness, not the store.** The store's own
  statement (`buildSearchQuery`), with index, bitmap and index-only scans off,
  in the stage's own transaction under the same tenant context: the distance,
  filter and tie-break are the ANN's, only the plan differs, and the plan is
  read and refused if it touches an HNSW index.
- **The plans decide what the record may claim.** A revision stating `hnsw`
  with any question planned off the index would let an exact scan's 1 pass
  D-L4-9, which now gates `search_knowledge`; the stage refuses it.
- **The judge never holds the key.** The proxy reserves each call at the
  request body's byte length (an upper bound on its input tokens) plus
  `max_tokens`, refuses with 402 (which the SDK does not retry), and settles
  to the reported usage, keeping the worst case when there is none. The
  product's answers, once wired, are reserved through the same share.
- **No record without answers.** A record over empty answers would be a record
  about nothing, and a committed record is what the gate reads; the judge stage
  exits `NO_ANSWER_TARGET` before starting anything.
- **The whole Python dependency set is locked.** Ragas 0.4.3 resolved today
  pulls langchain-community 0.4.2, which removed a module Ragas imports; the
  lock is the set as of 0.4.3's release day.
- **Records are committed by a person**, from the artifact, as Inspect's are:
  a committed record opens a gate.

## Wiring left when #5751 is on `main`

`scripts/rag-eval/search-seam.ts`, three bodies: `annQuery` adds
`strategy: 'index'`; `searchSettings` returns `HNSW_SEARCH` (relaxed order,
`max_scan_tuples` 20,000, `ef_search` ≥ 40); `retrieverRevision` returns
`knowledgeRetrieverRevision({ model, dimensions })`, and the probe's `--k`
goes. Forgetting it fails closed: the observed revision differs from the
gate's, so no record matches. Then the answer route (a harness route serving
`answer-contract.json` through the assistant with `search_knowledge`, the gate
bypassed for the answer tenant by a test-mode flag), the app boot in the
workflow, and `RAG_EVAL_ANSWER_URL`.
