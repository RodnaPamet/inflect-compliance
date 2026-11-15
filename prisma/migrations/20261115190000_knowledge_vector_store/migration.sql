-- Layer 4's knowledge store: the pgvector extension, chunk text (encrypted)
-- and one embedding per chunk per model, under RLS. Vector store Phase 1.3,
-- 1.4 and 1.6 (docs/ai-architecture/weaviate.md; owner decisions D-L4-1
-- pgvector first, D-L4-2 vectors only, D-L4-3 the embedding model).
--
--   KnowledgeChunk           one chunk of one source row; `text` is in the
--                            encryption manifest and is the ONLY copy of
--                            chunk text anywhere
--   KnowledgeChunkEmbedding  one model's vector of one chunk: a key, a
--                            content hash, the dimension count and the
--                            vector, never text. Read and written only by
--                            src/app-layer/repositories/vector/pgvector-store.ts
--                            behind VectorRepository.ts.
--
-- ── THE EXTENSION NEEDS A SUPERUSER ────────────────────────────────
-- pgvector's vector.control does not declare itself `trusted`, so
-- CREATE EXTENSION vector needs a superuser (pg_trgm, the only extension an
-- earlier migration creates, is trusted). Every Postgres the repository runs
-- is ghcr.io/rodnapamet/postgres-pgvector:16-alpine, which carries the
-- extension's files; CI's `migrate deploy` runs as the image's
-- POSTGRES_USER, a superuser. In production `prisma migrate deploy` runs in
-- the `app` container's entrypoint over DIRECT_DATABASE_URL (or DATABASE_URL,
-- through PgBouncer, when that is unset); the only login role the repository
-- configures on the VM is `postgres`, the image's superuser
-- (deploy/docker-compose.prod.yml: POSTGRES_USER and PgBouncer's DB_USER).
-- If the VM's DIRECT_DATABASE_URL names any other role, an operator runs
-- `CREATE EXTENSION IF NOT EXISTS vector;` once as `postgres` before this
-- migration, and the statement below is then a no-op.
--
-- ── WHY THE TABLES LOOK LIKE THIS ──────────────────────────────────
-- `embedding` is the untyped `vector`, so one table holds every model's
-- vectors; a CHECK holds `dimensions` to vector_dims(embedding). The chunk
-- reference is the composite (chunkId, tenantId), so an embedding can never
-- point at another tenant's chunk, even through a write that bypasses RLS
-- (a foreign-key check does not apply RLS to the referenced table). An
-- embedding goes with its chunk (ON DELETE CASCADE); a chunk's source is
-- polymorphic, so no foreign key removes a chunk with its source — the index
-- pipeline does that (Phase 2), and the tenant purge removes both tables.
--
-- `writeSeq` is drawn from the table's sequence on every write; a rebuild
-- draws its start value under an exclusive (tenant, model) advisory lock and
-- deletes only the rows written before it, so a concurrent write is never
-- erased. app_user needs the sequence for the column default and for the
-- rebuild's nextval.

CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceModel" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "chunkerRevision" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "KnowledgeChunk_chunkIndex_check" CHECK ("chunkIndex" >= 0),
    CONSTRAINT "KnowledgeChunk_contentHash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$')
);

-- CreateTable
CREATE TABLE "KnowledgeChunkEmbedding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector NOT NULL,
    "rebuildGeneration" TEXT,
    "writeSeq" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeChunkEmbedding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "KnowledgeChunkEmbedding_contentHash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "KnowledgeChunkEmbedding_dimensions_check" CHECK ("dimensions" BETWEEN 1 AND 4096),
    CONSTRAINT "KnowledgeChunkEmbedding_dims_match" CHECK (vector_dims("embedding") = "dimensions")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_id_tenantId_key" ON "KnowledgeChunk"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_tenantId_sourceModel_sourceId_chunkIndex_key" ON "KnowledgeChunk"("tenantId", "sourceModel", "sourceId", "chunkIndex");

-- CreateIndex
CREATE INDEX "KnowledgeChunkEmbedding_tenantId_embeddingModel_idx" ON "KnowledgeChunkEmbedding"("tenantId", "embeddingModel");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunkEmbedding_tenantId_chunkId_embeddingModel_key" ON "KnowledgeChunkEmbedding"("tenantId", "chunkId", "embeddingModel");

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunkEmbedding" ADD CONSTRAINT "KnowledgeChunkEmbedding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunkEmbedding" ADD CONSTRAINT "KnowledgeChunkEmbedding_chunkId_tenantId_fkey" FOREIGN KEY ("chunkId", "tenantId") REFERENCES "KnowledgeChunk"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- The HNSW index for multilingual-e5-small (D-L4-3, 384 dimensions)
-- ═══════════════════════════════════════════════════════════════════
-- One partial expression index per embedding model: the expression is the
-- cast the backend's search orders by, `("embedding"::vector(384))`, and the
-- predicate names the model exactly as AI_EMBED_LOCAL_MODEL spells it. Two
-- models can therefore be indexed side by side during a model change.
-- `vector` indexes at most 2,000 dimensions; 384 is well inside it.
--
-- Not CONCURRENTLY: a migration runs in a transaction, and the table is new
-- and empty, so the build is instant (the pg_trgm migration's note says
-- the same of its indexes). Prisma cannot declare a partial expression index
-- with an operator class, so `prisma migrate diff` proposes dropping it; that
-- statement is signed off in prisma/fresh-db-schema-drift.expected.sql
-- (group 2) and tests/guardrails/schema-drift-gate-runs-in-ci.test.ts.
CREATE INDEX "KnowledgeChunkEmbedding_hnsw_multilingual_e5_small_idx"
    ON "KnowledgeChunkEmbedding"
    USING hnsw (("embedding"::vector(384)) vector_cosine_ops)
    WHERE "embeddingModel" = 'intfloat/multilingual-e5-small';

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: the canonical triple on both tables
-- ═══════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE, DELETE ON "KnowledgeChunk" TO app_user;
ALTER TABLE "KnowledgeChunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeChunk" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "KnowledgeChunk";
CREATE POLICY tenant_isolation ON "KnowledgeChunk"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "KnowledgeChunk";
CREATE POLICY tenant_isolation_insert ON "KnowledgeChunk"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "KnowledgeChunk";
CREATE POLICY superuser_bypass ON "KnowledgeChunk"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "KnowledgeChunkEmbedding" TO app_user;
GRANT USAGE, SELECT ON SEQUENCE "KnowledgeChunkEmbedding_writeSeq_seq" TO app_user;
ALTER TABLE "KnowledgeChunkEmbedding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeChunkEmbedding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "KnowledgeChunkEmbedding";
CREATE POLICY tenant_isolation ON "KnowledgeChunkEmbedding"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "KnowledgeChunkEmbedding";
CREATE POLICY tenant_isolation_insert ON "KnowledgeChunkEmbedding"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "KnowledgeChunkEmbedding";
CREATE POLICY superuser_bypass ON "KnowledgeChunkEmbedding"
    USING (current_setting('role') != 'app_user');
