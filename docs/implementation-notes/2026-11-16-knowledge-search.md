# 2026-11-16 — `search_knowledge`: the query path, guarded, behind a mount gate

**Commit:** see the pull request (vector store Phase 3.1–3.5, `docs/ai-architecture/weaviate.md`)

## Design

```
model / MCP client / assistant
  │  runGuardedTool: egress scan on the arguments, the review latch
  ▼
runReadTool  ── exposure ∩ grant ∩ policy card ∩ scope (policies:read) ∩ policies.view
  │            (allReadTools: a mount-gated tool whose gate is closed is not in the catalogue)
  ▼
search_knowledge (src/lib/mcp/tools/knowledge-tools.ts) ── one usecase call, no repository, no check
  ▼
searchKnowledge (usecases/knowledge-search.ts)
  │  source models the caller's own read policy admits (PolicyVersion: assertCanReadPolicies)
  │  the gate again (MOUNTED, same revision as the provider)
  │  embed the question, input type `query`, the tenant's residency route
  │  VectorRepository.search  k = 20 (the revision's), keep the caller's first `limit`
  │     auto: ≤ 2,000 vectors → exact; above → HNSW, relaxed_order, max_scan_tuples 20,000;
  │           short of k and ≤ 50,000 → exact again
  │  hydrate under RLS: KnowledgeChunk text (decrypted), the citing policy; drop stale hits
  ▼
result → guardUntrustedInput + guardEgress → the model (a flag trips the run's latch)
```

The gate (`services/knowledge-search-mount.ts`) is the PII detector gate's
shape: ABSENT while `VECTOR_STORE_BACKEND` or the embedding route is off;
otherwise the newest record in `evals/rag/records/` whose `retrieverRevision`
keys equal to `knowledgeRetrieverRevision(route)` decides, through Ragas Phase
0's `checkRagEvaluationRecord` against the authored set it hashes to and the
cost meter's price table and Ragas share, then the two recomputed retrieval
figures against the floors. Resolved once per process: the route is env and the
records ship in the image.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/repositories/vector/types.ts`, `VectorRepository.ts` | `strategy` (`auto` / `index` / `exact`), `EXACT_SCAN_MAX_ROWS`, `HNSW_SEARCH`, `HNSW_BUILD` |
| `src/app-layer/repositories/vector/pgvector-store.ts` | the three-path search; the exact path orders by an expression the HNSW index cannot match |
| `src/app-layer/repositories/KnowledgeChunkRepository.ts` | `findByKeys`: the hydration read, at most 50 keys |
| `src/app-layer/services/knowledge-sources.ts` | `KNOWLEDGE_CITATIONS`: what a hit cites (policy id, title, version); a soft-deleted policy cites nothing |
| `src/app-layer/services/knowledge-search-revision.ts` | the retriever revision this build runs, from the route's model and dimensions |
| `src/app-layer/services/knowledge-search-mount.ts` | the gate, and the two PROPOSED floor constants |
| `src/app-layer/usecases/knowledge-search.ts` | the read usecase |
| `src/lib/mcp/tools/knowledge-tools.ts` | the read tool |
| `src/lib/mcp/tools/registry.ts` | registration; `allReadTools` keeps only mounted tools |
| `src/lib/mcp/mount-gated-tools.ts`, `src/lib/mcp/tool-visibility.ts`, `src/lib/mcp/knowledge-search-descriptor.ts` | the gated tools and their state (`readToolMounted`, `unmountedReadTools`), holding each tool's name and keys but never the tool; `canSee`, moved out of the registry so both share it; the tool's name and keys, read by the tool and the gate list alike |
| `src/app-layer/repositories/vector-search-params.ts` | the search and build parameters as a leaf, so the revision reads them without loading a backend |
| `tests/flue/driver-conformance.test.ts` | fakes the gated list beside the registry it already fakes |
| `messages/en.json`, `messages/bg.json` | the agent canvas's sentence for `RETRIEVER_NOT_EVALUATED` |
| `src/lib/agentic/engine-tools/offer-tools.ts`, `empty-catalogue-message.ts`, `knowledge-search-not-evaluated.ts` | `RETRIEVER_NOT_EVALUATED`: a run granted the tool says why it was not offered |
| `src/lib/ai/embeddings/revision.ts`, `src/lib/ai/evals/rag-record.ts` | the revision key is the record's own shape (`dimensions`, `indexParams`, no `alpha`) |
| `src/lib/mcp/tool-catalogue.ts`, `src/lib/agentic/content-provenance.ts` | the name, its key scope, its corpus label |
| `Dockerfile`, `evals/rag/records/.gitkeep` | the runtime image carries what the gate reads |
| `docs/sub-processors.md` | the Anthropic row gains retrieved passages; OpenRouter says it gets none |

## Decisions

- **The tool calls a usecase.** The roadmap's prompt says "no permission
  check, usecase or Prisma call inside the tool module". That sentence is the
  CLAUDE.md rule for ENGINE modules; read tools have their own house rule,
  held by `tests/guardrails/mcp-read-suite-coverage.test.ts`: a tool calls one
  read usecase, imports no repository, and holds no check of its own. The tool
  module holds none; the usecase applies the source's own read policy, as every
  read usecase does, so a source a caller may not read is never searched rather
  than searched and filtered (which would also crowd out the hits it may see).
- **`limit`, not `k`, on the wire.** Every bounded read tool names its count
  `limit`, and the read-suite guardrail requires a `limit` or `days`. The
  retriever's `k` stays the internal name.
- **Retrieve 20, return the first `limit`.** The revision's `k` is the maximum,
  so a call at any `limit` returns a prefix of exactly the ranking the record
  measured. With `relaxed_order` a smaller `LIMIT` is not guaranteed to be a
  prefix of a larger one, which is why the search does not take the caller's
  number.
- **Exact below 2,000 vectors, plus a bounded exact fallback.** The threshold
  is a tuning value (a few MB of floats read through the tenant-leading btree),
  not an owner decision; 3.6's figures move it. The fallback catches an indexed
  search that hit `max_scan_tuples` before finding `k` of the tenant's rows,
  and is bounded at 50,000 vectors so one search can never read a very large
  tenant whole; past that the index's answer stands and is logged.
- **The exact path cannot be served by HNSW, by construction.** It orders by
  `"embedding" <=> q` on the uncast column, an expression the
  `(embedding::vector(384))` index does not match, rather than relying on a
  planner setting. The integration suite reads both plans.
- **The floors are PROPOSED constants.** `PROPOSED_RECALL_AT_10_FLOOR` (0.95)
  and `PROPOSED_P95_LATENCY_CEILING_MS` (300). The master's decision table
  records D-L4-9 adopting these values as the trigger for Phase 4 (Weaviate);
  holding the same values as the condition for offering the tool at all is a
  separate use, proposed here and waiting on the owner. Ragas Phase 2.1's
  per-metric floors (`evals/rag/floors.json`) do not exist and are not read.
- **The newest record decides, file names mean nothing.** A record is this
  deployment's by its `retrieverRevision` key, whatever the Ragas harness names
  the file; a newer failing record is not covered by an older pass; a malformed
  record refuses rather than being skipped (the PII gate's rule).
- **Closed means absent.** A gated tool is filtered out of `allReadTools`, so
  `tools/list`, every engine's offer and the assistant agree, and a call naming
  it is an unknown tool. A run that would have been offered it records
  `RETRIEVER_NOT_EVALUATED` instead of looking as if its grant were missing —
  but only while the gate is UNMOUNTED (store and route on, no passing record).
  While the feature is ABSENT (the default: store or route off) the run records
  nothing about it, so every person's assistant turn does not log an omission
  for a feature the deployment does not have. The gating lives in its own
  module, not the registry and outside `tools/` (the read-suite guardrails read
  every file there as a tool), because a dozen suites replace the registry with
  a few functions and the engines' offer must not depend on which ones; and it
  holds the tool's name and keys, never the tool, so the offer does not load
  the tool's usecase and the database layer behind it.
- **Scope `policies:read`.** Approved policy text is the only source. A later
  source adds its read policy to `KNOWLEDGE_SOURCE_READ_POLICY` (keyed
  exhaustively on the source union, so a source without one does not compile)
  and its own row rule; whether a key then needs a scope per source is that
  pull request's question.
- **The gate is re-asked at execution.** The usecase refuses `NOT_EVALUATED`
  and `REVISION_CHANGED` itself, so "no record, no search" does not depend on
  the registry being the only caller.
