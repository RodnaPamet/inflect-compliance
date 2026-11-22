# 2026-11-16 — The knowledge-index job (vector store 2.1, 2.4)

**Commit:** `feat(knowledge): the knowledge-index job — paragraph chunks, encrypted, embedded 8 at a time (vector store 2.1, 2.4)`

Roadmap: [`docs/ai-architecture/weaviate.md`](../ai-architecture/weaviate.md)
Phase 2. Owner decisions in force: D-L4-1 (pgvector first), D-L4-2 (vectors
only), D-L4-3 (`intfloat/multilingual-e5-small`, 384 dimensions), and the
2026-11-15 batch decision (`INDEX_EMBED_BATCH` = 8 passages per call, the
seam's 15 s deadline kept). Stacks on Phase 1
([`2026-11-15-knowledge-store-tables.md`](2026-11-15-knowledge-store-tables.md)).

## Design

```
enqueueKnowledgeIndex(tenant, model, id)   ← a source's write path, after commit (2.2)
  │  store off or no embedding route → returns, queue untouched
  ▼
knowledge-index job (worker, runJob)  →  indexKnowledgeSourceObserved
  1. VECTOR_STORE_BACKEND=pgvector?           no → VECTOR_STORE_DISABLED
  2. embedding route for the tenant residency? no → EMBEDDING_NOT_CONFIGURED
  3. ONE transaction, runInTenantContext + pg_advisory_xact_lock(source):
       KNOWLEDGE_SOURCES[model](db, ctx, id)   PolicyVersion: approved only
       chunkParagraphs(text)                   paragraph@1, ≤ 1,200 chars
       KnowledgeChunkRepository.reconcileSource
         keep same hash+revision · replace changed (delete+insert) · delete tail
  4. VectorRepository.listSourceKeys → chunks whose vector is missing/stale
  5. embed 8 at a time ('passage') → VectorRepository.upsert per batch
  ▼
one KnowledgeIndexOutcome → knowledge_index.runs{source_model, outcome}
```

## Files

| File | Role |
| --- | --- |
| `src/lib/knowledge/paragraph-chunker.ts` | `paragraph@1`: blank-line paragraphs, packed to ≤ 1,200 chars, long ones cut at sentences, words, code points |
| `src/lib/knowledge/index-outcome.ts` | The closed outcome set, success vs named failure |
| `src/app-layer/services/knowledge-sources.ts` | Which models the index reads and how; `PolicyVersion` (approved only) |
| `src/app-layer/services/knowledge-index.ts` | The job's body |
| `src/app-layer/repositories/KnowledgeChunkRepository.ts` | Chunk rows: per-source lock, list, reconcile, delete |
| `src/app-layer/jobs/knowledge-index.ts`, `knowledge-index-enqueue.ts` | The job, and its one enqueue site |
| `src/app-layer/jobs/types.ts`, `executor-registry.ts` | Payload, retry policy, registration |
| `src/app-layer/repositories/VectorRepository.ts`, `vector/*` | `listSourceKeys`; `CONTENT_HASH_MISMATCH` in the pgvector backend |
| `src/lib/observability/integration-metrics.ts` | `knowledge_index.runs`, `.run.duration`, `.chunks_embedded` |
| `docs/encryption-data-protection.md` | 2.4: the embedding column, a plaintext derivative |
| `tests/guardrails/runtime-wiring-coverage.test.ts`, `schema-index-coverage.test.ts` | On-demand reason; `KnowledgeChunk`'s list read |

## Decisions

- **Re-run is a no-op by content, not by job id.** A chunk is kept when its
  hash and chunker revision match; a chunk is embedded only when the model's
  stored vector for it carries another hash or none. So a duplicate enqueue, a
  BullMQ retry and a manual re-run all converge, and no custom job id is needed
  (one would also block a re-index while the completed job is retained).
- **A changed chunk is replaced, not updated.** Deleting the row takes every
  model's vector of the old text with it by cascade; an in-place update would
  leave other models' vectors beside text they were not computed from.
- **Two overlapping runs of one source cannot cross.** The chunk write runs
  under a per-source advisory lock, so the later read of the source is the one
  left standing; and the pgvector backend now refuses a vector whose
  `contentHash` is not its chunk's (`CONTENT_HASH_MISMATCH`), so the earlier
  run's vectors are refused rather than filed against the newer text. That run
  ends `SUPERSEDED`, which is a success: the newer run owns the write.
- **`MAX_CHUNK_CHARS` is 1,200 because `tei-embed` truncates silently.** The
  Compose file runs it with `--auto-truncate`, so a chunk past the model's 512
  tokens would be stored whole and embedded in part. Characters are the proxy;
  a model with a shorter window needs a new chunker revision.
- **A source too big to hold is refused whole, and its old chunks removed.**
  `MAX_CHUNKS_PER_SOURCE` (2,000) bounds every read; indexing the first 2,000
  chunks would answer about a document's beginning and say nothing of the
  rest, and keeping the previous version's chunks would answer from superseded
  text.
- **Off is a named failure, and off enqueues nothing.** The job reads both
  switches before it reads the source, and reports the one that is off as an
  `ERROR` with `noRetry`. The enqueue helper checks the same switches so a
  deployment that has not turned the index on writes nothing to Redis on the
  write path and fills no failed set. Only a transient embedding failure
  (timeout, network, HTTP status) is retried.
- **"Approved" is a `PolicyApproval` row for the exact version.** That is what
  `decidePolicyApproval` writes. A version published through the bypass, a
  draft, an external link and any version of a soft-deleted policy are not
  indexable, and a run over one removes whatever chunks it had. An archived
  policy's approved version stays indexed: what a search may cite is the query
  path's decision (Phase 3).
- **The job runs as the tenant's JOB context with no admin or audit
  authority.** It calls no usecase; chunks are a derivative of rows the tenant
  already holds, and the context only binds RLS and the tenant DEK.
- **HTML is flattened, Markdown is kept.** Block ends in HTML content become
  paragraph breaks and tags are dropped (`sanitizePlainText`); Markdown is
  already the text a reader sees.
