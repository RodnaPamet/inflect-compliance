# 2026-11-16 — Rebuilding the knowledge index from Postgres (vector store 2.3)

**Commit:** `feat(knowledge): scripts/knowledge-reindex rebuilds a tenant's vectors from KnowledgeChunk (vector store 2.3)`

Roadmap: [`docs/ai-architecture/weaviate.md`](../ai-architecture/weaviate.md)
Phase 2.3. Stacks on
[`2026-11-16-knowledge-index-policy-source.md`](2026-11-16-knowledge-index-policy-source.md).

## Design

```
scripts/knowledge-reindex.ts --tenant=<slug-or-id>
  └ reindexTenantKnowledge(tenantId)                 services/knowledge-reindex.ts
      store off / no embedding route → named outcome, nothing read or written
      count the tenant's chunks (allowEmpty only when there are none)
      VectorRepository.rebuildRevision(model, recomputed())
        recomputed(): KnowledgeChunk pages of 200, id order (text decrypted)
                      → embed 8 at a time ('passage') → VectorRecord batches
        rows of the model not yielded are deleted after the LAST batch only
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/services/knowledge-reindex.ts` | The rebuild, `RECOMPUTE_COSINE_TOLERANCE` |
| `scripts/knowledge-reindex.ts` | Operator CLI: tenant by slug or id, JSON result, exit code |
| `src/app-layer/repositories/KnowledgeChunkRepository.ts` | `countForTenant`, `listForTenant` (id cursor) |
| `src/app-layer/services/knowledge-index.ts` | Exports the job's context and residency read, shared |
| `tests/integration/knowledge-reindex.test.ts` | Store lost → rebuilt: hash set exact, vectors within tolerance |

## Decisions

- **Chunks are the system of record; nothing is re-chunked.** The rebuild
  reads `KnowledgeChunk.text` and never a source row, so it proves the vectors
  are a pure function of what Postgres holds, and it cannot be broken by a
  source that has since changed (that is the index job's business).
- **The tolerance is `1 - cosine ≤ 1e-6`, stated and asserted.** The stub
  embedder is exactly reproducible. A real model on the same revision and
  hardware moves only the last bits (batch padding, the CPU's SIMD path); a
  gap larger than that under one model id means another model is answering
  under it, which is a new retriever revision with its own evaluation record
  (G11), not a rebuild.
- **A healthy index is not recomputed.** The backend keeps a vector whose hash
  matches its chunk, so a rebuild over a complete index embeds every chunk and
  changes no row. The rebuild exists for a lost or partial store, and for a new
  model, whose rows are a new revision beside the old.
- **No `--replace`.** Recomputing present vectors would need the seam to
  delete one model's rows, and nothing needs that yet; a lost store is the case
  the roadmap asks for.
- **Fails part-way, deletes nothing.** An embedding failure stops the
  generator inside `rebuildRevision`, whose delete-what-was-not-seen step runs
  only after the last batch. The batches already written stay, and the next
  run completes them.
