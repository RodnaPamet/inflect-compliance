# 2026-11-15 — The knowledge store's tables, under the vector seam (vector store 1.3–1.8)

**Commit:** `feat(knowledge): the pgvector extension, KnowledgeChunk and KnowledgeChunkEmbedding under RLS (vector store 1.3-1.8)`

Owner decisions in force: D-L4-1 (pgvector first), D-L4-2 (vectors only),
D-L4-3 (`intfloat/multilingual-e5-small`, 384 dimensions). Roadmap:
[`docs/ai-architecture/weaviate.md`](../ai-architecture/weaviate.md) Phase 1.
Stacks on the image change
([`2026-11-15-postgres-pgvector-image.md`](2026-11-15-postgres-pgvector-image.md),
[`2026-11-15-postgres-pgvector-references.md`](2026-11-15-postgres-pgvector-references.md)):
every Postgres must carry the extension before a migration creates it.

## Design

```
KnowledgeChunk (tenantId, sourceModel, sourceId, chunkIndex) unique
  text ← ENCRYPTED (manifest), the only copy of chunk text (D-L4-2)
  contentHash, chunkerRevision
        ▲ (chunkId, tenantId) composite FK, ON DELETE CASCADE
KnowledgeChunkEmbedding (tenantId, chunkId, embeddingModel) unique
  dimensions = vector_dims(embedding)   (CHECK)
  contentHash, embedding vector (untyped), rebuildGeneration, writeSeq BIGSERIAL
  HNSW ((embedding::vector(384)) vector_cosine_ops)
       WHERE embeddingModel = 'intfloat/multilingual-e5-small'

VectorRepository ── pgvector-store.ts ── the only SQL on KnowledgeChunkEmbedding
  upsert: shared (tenant, model) lock → dimension check → resolve each record's
          chunk in the tenant (CHUNK_NOT_FOUND otherwise) → INSERT … ON CONFLICT
  search: inner ORDER BY distance LIMIT k over the embedding table only
          (sourceModels as a correlated EXISTS), then join chunks for keys
```

The seam (2026-11-11) was written against a draft table, `KnowledgeVector`,
that carried the chunk key itself. The roadmap's Phase 1 asks for a chunk
table and an embedding table, so the backend now keys a vector by its chunk:
a record still names `(sourceModel, sourceId, chunkIndex)`, and the backend
resolves it to the chunk's id inside the caller's tenant. The repository's
contract, its validation and its unit suite are unchanged except for one new
refusal.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261115190000_knowledge_vector_store/migration.sql` | Extension, both tables, CHECKs, composite FK, the e5 HNSW index, RLS triple + FORCE, grants (sequence included) |
| `prisma/schema/knowledge.prisma` (+ `auth.prisma`, `README.md`) | The two models; Tenant back-relations |
| `src/app-layer/repositories/vector/pgvector-store.ts` | Rewritten for the two tables; `buildSearchQuery` exported for the plan test |
| `src/app-layer/repositories/vector/types.ts` | `CHUNK_NOT_FOUND` |
| `src/app-layer/repositories/VectorRepository.ts` | `vector_index.request.duration` beside `vector_index.requests` |
| `eslint-rules/rules/vector-store-single-seam.js` (+ test, README) | The table name is `KnowledgeChunkEmbedding`; the `knowledgeChunkEmbedding` delegate is refused too |
| `src/lib/security/encrypted-fields.ts` | `KnowledgeChunk: ['text']` |
| `tests/guardrails/sanitize-rich-text-coverage.test.ts` | `KnowledgeChunk` classified (a derivative, sanitised at its source) |
| `docs/data-retention.md` | Both models: business records, purged with their source and with the tenant |
| `tests/integration/vector-tenant-isolation.test.ts` | The two-tenant test against the real tables |
| `tests/unit/vector-pgvector-backend.test.ts`, `tests/unit/vector-repository.test.ts` | The new SQL shape, chunk resolution, no text column touched; the two signals |

## Decisions

- **The chunk reference is composite, `(chunkId, tenantId)`.** A foreign-key
  check does not apply RLS to the referenced table, so a single-column FK
  would let a write that bypasses RLS (a superuser, a future job) hang a
  vector of tenant B on a chunk of tenant A. The integration suite shows the
  composite FK refusing exactly that as a superuser.
- **A vector of no chunk is refused (`CHUNK_NOT_FOUND`), not created.** The
  FK would refuse it anyway, with an error that names nothing; the backend
  refuses first, naming the model and position and no id or text. The
  in-process reference backend has no chunks and does not raise it.
- **The search query is shaped for the index, and a test reads its plan.**
  The first draft joined the chunk and ordered by distance and then the chunk
  key in one query; with sequential scans switched off it planned as a btree
  scan and a full sort, never touching HNSW, because an index scan can only
  supply `ORDER BY <distance> LIMIT k`. Now the inner query does exactly that
  over the embedding table, with the `sourceModels` filter as a correlated
  `EXISTS` (a nested loop under the index scan, so the iterative scan keeps
  reading until k rows pass), and the join and the key tie-break run on the k
  rows. Ties exactly at the k-th distance are resolved by the index, not by
  key, which only the in-process reference backend does differently.
- **No drift residue, measured.** The roadmap expected `prisma migrate diff`
  to propose dropping the HNSW index, to be signed off like the `pg_trgm`
  indexes. With Prisma 7.10.1 it does not: an expression index is invisible
  to the diff (the `pg_trgm` ones are column indexes with an operator class),
  as are the extension and the vector column's type. `npm run
  db:check-schema-drift` against a database built from the migrations matches
  the committed 90 statements, so the expected file and `SIGNED_OFF` are
  unchanged; adding the statement would fail the gate's other direction.
- **A wrong-sized vector cannot enter a model's index.** The index's cast is
  `vector(384)`, so a 3-dimensional row under the e5 model is refused at
  insert. The repository already refuses a dimension that disagrees with the
  model's stored rows; this is the database saying the same thing.
- **`KnowledgeChunk.text` is not sanitised again.** It is cut from fields
  sanitised at their own write paths; re-sanitising a chunk would make its
  `contentHash` disagree with its source. Classified, with that reason, in
  `NON_RICH_TEXT_MODELS`.
- **The extension needs a superuser.** pgvector's control file is not
  `trusted`. CI's `migrate deploy` runs as the image's `POSTGRES_USER`, a
  superuser. In production the repository configures `postgres` as the only
  login role, but `DIRECT_DATABASE_URL` lives in the VM's `.env.prod`, so the
  role is read off the VM before the first apply carrying this migration; if
  it is not a superuser, an operator runs `CREATE EXTENSION IF NOT EXISTS
  vector;` as `postgres` first and the migration's statement is a no-op.
- **`readyz` does not gate on the store.** The counter and the histogram are
  the alerting surface (checklist §4).

## Rollback

Forward-fix, per the change-management policy: a later migration drops the
two tables (and, only if nothing else uses it, the extension). Nothing writes
them yet, so dropping loses nothing; `VECTOR_STORE_BACKEND` unset keeps every
caller off them in the meantime.
