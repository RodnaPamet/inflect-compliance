# 2026-11-12 — Ragas 0.6: the record meets the pgvector store, and one cost meter for the CI evals

**Commit:** `wf/ragas-cost-meter` — feat(ai-evals): align the RAG record with pgvector and share one cost meter with garak

Sub-phase 0.6 of `docs/ai-architecture/ragas.md`, from the 2026-11-11 knowledge
re-plan. Two halves: the RAG evaluation record now describes the store that
exists (dense pgvector, not hybrid Weaviate), and the USD 5 nightly CI cap that
garak (D-EV-1) and Ragas (D-EV-2) share is enforced from one place.

**The split is not an owner decision.** The shared USD 5 cap is decided (D-EV-2:
"as D-EV-1, one shared cap"). How it divides is D-EV-11, which the master
roadmap lists as **open**, with "shared, USD 2.50 each by default" as its
PROPOSAL. `shares.json` carries that proposed default so the two jobs together
cannot pass USD 5 while the owner decides; its `decision` text, the guardrail's
test name and this note say so, and none of them attributes the split to the
owner. When D-EV-11 is initialled, the split moves (if it moves) by an edit to
`shares.json`, which the meter re-checks.

## Design

```
evals/cost-meter/
  prices.json   pinned list prices, keyed by model id  ──┐ sha256(exact bytes) = priceTableHash
  shares.json   nightly cap 5.00; garak 2.50, ragas 2.50 │
  meter.mjs     shareProblems  (cap ≤ 5.00, Σ shares ≤ cap in cents, every model priced)
                jobBudget      (a share is handed out only from a split that checks)
                createMeter    reserve(input + max_tokens, rounded up)  → refuse past the share
                               settle(reported usage | null → keep the worst case)
                               status() COMPLETE | BUDGET_EXHAUSTED
        ▲                                   ▲
        │ price + garak's share             │ (Phase 1: the Ragas harness reserves each
.garak/spend.mjs (between-role breaker)     │  judge call; the record states spendUsd,
.github/workflows/garak.yml                 │  status, priceTableHash)
                                            │
src/lib/ai/evals/rag-record.ts ─ checkRagEvaluationRecord(record, set, { shareUsd, priceTable })
   retrieverRevision {embeddingModel, rerankModel, chunker, k, dimensions, indexParams}
   judgeRevision     {…, priceTableHash}
   record            {…, status, spendUsd}, per case retrievalProbe {ann[≤10], exact[≤10], latencyMs}
   → aggregates (answered cases only), unanswered[], retrievalFloors (recomputed), floor
```

The record's new figures follow the rule the record already had: nothing a run
claims is believed. Recall@10 against exact search and p95 latency are derived
from each case's raw probe, never stored; `floor.eligible` is derived from
`status`, never declared.

## Files

| File | Role |
| --- | --- |
| `evals/cost-meter/prices.json` | The pinned price table, keyed by model id (Haiku 4.5 at USD 1 / 5 per million, the rates `.garak/budget.json` carried). |
| `evals/cost-meter/shares.json` | The nightly cap (5.00) and each job's share and model: garak and Ragas, 2.50 each (D-EV-11's proposed default, open). |
| `evals/cost-meter/meter.mjs` | The meter: share check, price lookup, reserve/settle in integer micro-dollars, `hash` / `check-shares` / `share` CLI. |
| `.garak/spend.mjs` | garak's between-role breaker now prices from the table and caps at garak's share; adds a `cap` command. |
| `.garak/budget.json` | Loses `nightlyCapUsd` and both rates; keeps `model`, which must equal garak's share's model. |
| `.github/workflows/garak.yml` | Header says the cap is shared; the job summary reports spend against garak's share. |
| `src/lib/ai/evals/rag-record.ts` | Dense revision, price table hash, spend, status, retrieval probes, recomputed floor figures, floor eligibility, three new refusals. |
| `tests/unit/rag-evaluation-record.test.ts` | The fixture record migrated to the new shape; three new blocks for 0.6. |
| `tests/unit/eval-cost-meter.test.ts` | The meter's behaviour, run in a child `node` as CI runs it. |
| `tests/guardrails/eval-cost-meter-shares.test.ts` | The committed shares pass the meter's own check; Σ ≤ 5.00; every model priced; the proposed default split. |
| `tests/guardrails/garak-workflow-pinning.test.ts`, `tests/unit/garak-wire-cap-and-record.test.ts` | Read the price and garak's share from the meter instead of `budget.json`. |
| `.garak/config.yaml`, `.garak/budget.json`, `.github/workflows/garak.yml` | garak's planned night cut to fit its share: 4 prompts per probe, 40 per role, 80 a night (`AI_RISK_DAILY_QUOTA`). |
| `docs/ai-architecture/ragas.md` | 0.6 ticked; a current-state bullet. |
| `docs/ai-architecture/garak.md` | 1.4's four spend layers restated at the new numbers. |

## Decisions

- **The retrieval floor figures are recomputed, not stored — a deviation from
  the sub-phase's wording.** 0.6 said the record "gains the two retrieval
  floor figures". Storing `recallAt10VsExact` and `p95LatencyMs` would be the
  one place the record believes a number, which is exactly what 0.4 refused
  for `passRate`. So each case carries `retrievalProbe` — the ANN top-10 under
  the revision's index parameters, the exact top-10 over the same rows, the
  ANN wall time — and `checkRagEvaluationRecord` derives both figures. A
  `retrievalFloors` member on a record is an unknown key. Recall is the mean
  per-case overlap over cases with a non-empty exact list (`null` over none);
  p95 is nearest-rank, the definition `scripts/retriever-benchmark/scoring.ts`
  uses. A top-10 list naming a chunk twice is refused, because it would count
  twice. The probe is always at depth 10, whatever `k` the answer path uses.
- **`indexParams` is a discriminated union, `hnsw` or `exact`.** `hnsw` names
  everything the store sets that moves recall or latency: the distance, `m`,
  `efConstruction`, `efSearch`, the iterative scan mode and
  `maxScanTuples` (`pgvector-store.ts` sets `strict_order` and
  `ef_search = max(40, k)` per query). `exact` is the small-tenant sequential
  scan; its recall is 1 by construction, and the probe still records it rather
  than the check assuming it.
- **A BUDGET_EXHAUSTED record is checkable, partial, and never floor-eligible.**
  A COMPLETE record must still answer every case (`UNANSWERED_CASE`
  otherwise). A budget-stopped one may leave cases, which are listed, and its
  aggregates are over what was answered, with an `unanswered` count per kind.
  It is refused by nothing for being partial — the night it ran out is worth
  committing — but `floor` is `{ eligible: false, reason: 'BUDGET_EXHAUSTED' }`
  even when every case was answered and every figure is perfect: the meter
  refused something, so the record is not the run it would have been.
- **The price table is named by the hash of its exact bytes**, not a canonical
  form. `src/lib/canonical-json.ts` is the one canonical form in the repo and a
  second copy in the `.mjs` meter would drift; hashing bytes needs none, and
  costs only that a reformat reads as a new table — an over-report.
- **The meter is an ES module run by plain `node`, not TypeScript.** garak's
  breaker runs in a workflow step with no TS toolchain, and the Ragas harness
  (Phase 1) is Python, which will call the same rules through the same files.
  The TS record check takes the meter's facts as `options` (`shareUsd`,
  `priceTable { hash, models }`) rather than importing the module.
- **Arithmetic is integer micro-dollars, rounded up.** One token at USD r per
  million costs exactly r micro-dollars, so a night of sums cannot drift, and a
  reservation can only round towards refusing. Shares must be whole cents and
  are summed in cents, so 2.50 + 2.51 is caught exactly.
- **An unknown cost is the worst case.** `settle(id, null)` keeps the
  reservation, and so does usage that cannot be read (a partial object, a
  negative or fractional count: `usageUnreadable`). The charge is computed
  before any state changes, so a reservation leaves `reserved` only by entering
  `spent`; an earlier draft released it first and then threw on bad usage,
  which read the cost as zero and reopened the share. Usage reported above the
  reservation is charged as reported and flagged (`overran`). Once a call is refused, the meter stays exhausted:
  a smaller later call that would fit is refused too, so a record's `status`
  cannot be COMPLETE over a run that skipped a call.
- **garak's planned night is cut to fit its share, not left to the breaker.**
  garak planned 2 roles × 50 requests at USD 0.03 = USD 3.00, which fitted its
  old private USD 5 cap and does NOT fit a USD 2.50 share. Left alone, the
  breaker (spent + one planned role must fit the share) would have skipped the
  editor role whenever the owner role cost more than USD 1.00, against a
  planned USD 1.50, with only a warning in a non-blocking job, while
  `budget.json` still listed both roles. So the planned night now fits the
  share: `soft_probe_prompt_cap` 4 (9 × 4 = 36 per role), wire cap 40 per
  role, 80 a night, `AI_RISK_DAILY_QUOTA` 80, i.e. USD 2.40 at the planned
  turn. The pinning guard holds the planned night against garak's SHARE (the
  cap the breaker enforces), not against the whole USD 5. The cost is one
  prompt per probe; the Phase 0.4 baseline's measured p99 turn replacing the
  USD 0.03 estimate is what should move it back, through this same guard.

## What remains

- **The per-request reservation at garak's proxy.** The re-plan's "each
  harness-route call is RESERVED at the route's stated worst case first and
  settled to the usage the route reports" is not built: garak's spend is still
  checked between roles only, from the decision log. `createMeter` is the seam
  for it (`target-proxy.mjs` would reserve before forwarding and settle from
  the response's usage).
- **The Ragas harness itself** (Phase 1) reserves each judge call through the
  meter and writes `spendUsd`, `status` and `priceTableHash`; nothing produces
  a record yet.
- **The retriever revision KEY still carries `alpha`.**
  `src/lib/ai/embeddings/revision.ts` (`retrieverRevisionKey`, read by the
  `search_knowledge` mount gate) belongs to the nemotron-retriever and
  weaviate roadmaps; the record's revision no longer matches that interface
  field-for-field. Dropping `alpha` and adding `dimensions` / `indexParams`
  there is the matching change, and the mount gate's comparison should use the
  same fields as the record.
- **The judge's embedding model is not priced.** Ragas's `answer_relevancy`
  embeds through `judgeRevision.embeddingModel`; if that is a billed external
  model it needs a row in `prices.json` and a share line, and the record check
  should refuse it unpriced as it does the judge.
- **D-EV-11 is open.** The master roadmap's register still lists it, and the
  master's Ragas row still reads 0.6 open; this branch may not edit the master
  roadmap (a parallel branch rewrites it). Initialling D-EV-11, and ticking 0.6
  in the master, are the owner's and that branch's acts.
