# 2026-11-16 — The Ragas nightly wired to the `search_knowledge` gate

**Commit:** `feat(evals): the Ragas nightly keys its record by the search_knowledge gate's revision and floors` (see the pull request)

Connects #5751 (vector store 3.1–3.5: the search, the tool, the mount gate) and
#5752 (Ragas Phase 1: the harness and the nightly), and records the owner's
four decisions of 2026-11-16.

## Design

```
rag-eval.yml ── probe.ts ──► search-seam.ts ──► VectorRepository.search({ …, strategy: 'index' })
                   │              │                under HNSW_SEARCH (relaxed_order, 20,000, ef ≥ 40)
                   │              └─► knowledgeRetrieverRevision(route) ◄── knowledge-search-mount.ts
                   │                        (the record's key)               (the gate's lookup key)
                   ├─ assertPlansMatchRevision: every question on the HNSW index,
                   │    built AND searched as the revision states, or refused
                   └─ check.ts ──► readRetrievalFloors ◄── knowledge-search-mount.ts
                                    rag-retrieval-floors.ts: D-L4-9's two values, written once
```

Before this change the seam described the store as it was before #5751:
`strict_order`, the server's `max_scan_tuples`, a revision built from what the
probe observed at `--k 10`. A record keyed that way differs from the gate's key
in `k` and in the scan mode, so the gate would never have found it. The three
bodies now read the product: `annQuery` pins the index path, `searchSettings`
returns `HNSW_SEARCH` with `ef_search` at least `k` as the store sets it, and
`retrieverRevision` returns `knowledgeRetrieverRevision`. The probe's `--k`
is gone; the revision's `k` is `KNOWLEDGE_RETRIEVAL_K`.

The floors had two homes: `PROPOSED_RECALL_AT_10_FLOOR` /
`PROPOSED_P95_LATENCY_CEILING_MS` in the gate and the D-L4-9 constants in
`rag-retrieval-floors.ts`. The gate now imports the latter and asks
`readRetrievalFloors`, the function `check.ts` reads a night's figures through,
so the night's verdict and the gate's are one verdict.

## Files

| File | Role |
| --- | --- |
| `scripts/rag-eval/search-seam.ts` | The three bodies, wired to `strategy: 'index'`, `HNSW_SEARCH`, `knowledgeRetrieverRevision` |
| `scripts/rag-eval/probe.ts` | `--k` removed; the plan check also compares `ef_search`, scan mode and `max_scan_tuples`; the server's reported `max_scan_tuples` must equal the one set; `measureRetrieval` split from `runRetrievalProbe` |
| `src/app-layer/services/knowledge-search-mount.ts` | The `PROPOSED_*` constants removed; reads the floors through `readRetrievalFloors` |
| `src/lib/ai/evals/rag-retrieval-floors.ts` | Says it is the one source |
| `tests/unit/rag-eval-gate-agreement.test.ts` | Harness revision = gate revision per route; the probe's settings = the revision's; a record keyed the old way is not found; over records straddling both floors the gate mounts exactly when the reading is met; the gate compares no figure itself |
| `tests/integration/rag-eval-retrieval-probe.test.ts` | Exact plans are measured, then refused as the gate's revision |
| `.github/workflows/rag-eval.yml` | `--k` dropped; `RAGAS_ANTHROPIC_API_KEY` preferred, the workspace header only with the shared key, the source logged by name |
| `evals/rag/requirements.lock`, `requirements-test.lock`, `Dockerfile` | Every requirement by sha256; both installed `--no-deps --require-hashes` and `pip check`ed |
| `tests/guardrails/rag-eval-workflow-pinning.test.ts` | The key pattern; a strict hashed-lock reader; the image installs nothing but the two locks |
| `docs/ai-architecture-roadmap.md` | D-L4-9 and D-EV-2 amended; status rows |
| `docs/ai-architecture/weaviate.md`, `ragas.md` | 3.5, 3.6 (partly), 1.1, 1.2, 2.2 |

## Decisions

- **Direction of the floors import: the gate imports the harness's module.**
  `src/lib/ai/evals/rag-retrieval-floors.ts` is pure with a type-only import,
  so a service importing it loads nothing, and it sits outside the vector
  store's single-seam rule; the reverse would have had the nightly's checker
  load a service that reads the environment and the filesystem.
- **The plan check now compares the search settings too.** Equal revisions are
  only half the claim: a probe whose questions ran under other HNSW settings
  than the revision states would carry the deployment's key over another
  configuration's figures. `assertPlansMatchRevision` refuses that, and the
  probe no longer substitutes its own `max_scan_tuples` for the server's: the
  server must report the value the store set.
- **The integration suite no longer runs the indexed path.** With the
  revision stating `hnsw`, the stub embedder's model has no HNSW index, so the
  probe correctly refuses its exact plans. An index built for the stub model
  was tried: whether a corpus of a few hundred rows is planned on it depends on
  the table's and the index's statistics (autovacuum timing), and the same
  test passed and failed on consecutive runs. A flaky test of the indexed path
  is worse than none, so the suite measures exact plans (`measureRetrieval`),
  checks them as before, and asserts the refusal. The nightly's probe tenant
  (5,000 chunks) is planned on the index; #5752's note measured 3,000 in 9,000.
- **The probe still searches at `k = 10`, and the product retrieves 20.**
  D-L4-9 states its floors at `k = 10`, so the probe measures there. The
  product's search asks for `KNOWLEDGE_RETRIEVAL_K` (20) and keeps the first
  `limit`, and with `relaxed_order` the first ten of a 20-deep search need not
  be a 10-deep search's ten. At the current settings both run with
  `ef_search` 40 and the deeper search reads at least as far, so its top ten
  are expected to be no worse; nothing measures that, and the latency measured
  is expected to be below the product's call. The search does not pass `sourceModels` either, which
  the product does; with one source model the filter selects every row but
  can change the plan. Both are left as they are, because the floors were
  decided at `k = 10`.
- **The secret is `RAGAS_ANTHROPIC_API_KEY`.** The name the request gave;
  garak's and Inspect's are `GARAK_CI_ANTHROPIC_KEY` and
  `INSPECT_CI_ANTHROPIC_KEY`. The pattern is theirs: the dedicated key when
  set, the shared key with its workspace header otherwise, the log naming the
  secret used. The evaluations card does not list the Ragas nightly.
- **The hashes came from PyPI for exactly the pinned versions.** Every file
  PyPI lists for each version (what `pip-compile --generate-hashes` writes),
  verified by installing both locks with `--require-hashes` on CPython 3.12
  and running the harness's tests. pytest's two requirements the runtime set
  lacks (iniconfig, pluggy) were unpinned before; they are pinned at the
  newest release before the runtime lock's 2026-01-14 cut-off.
- **3.6 stays unticked.** The figures are produced and the path to the gate is
  wired, but a record needs answers, and Ragas 1.2's answer half (the
  harness's answer route) is not built, so no record can be written or pass.
