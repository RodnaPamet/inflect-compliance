# 2026-11-11 — The vector store seam (Layer 4, pgvector first)

**Commit:** `feat(knowledge): add the vector store seam, pgvector first and off by default`

Owner decisions of 2026-11-11 in force: **D-L4-1** pgvector first (Weaviate only
on a measured floor) and **D-L4-2** vectors only. Child roadmap:
[`docs/ai-architecture/weaviate.md`](../ai-architecture/weaviate.md), being
re-planned for pgvector in a parallel branch; this note covers the seam only.

## Facts established first

The task depended on one question: does any Postgres this repository runs
carry the `vector` extension? It does not.

| Where | Image | `vector` available? |
| --- | --- | --- |
| CI, `.github/workflows/ci.yml` — the `services.postgres` of `Test` (the shards), `E2E` and `Load Smoke (k6)` | `postgres:16-alpine` | no |
| CI, `dast.yml`, `dast-full.yml`, `integration-stress.yml`, `load-test.yml` | `postgres:16-alpine` | no |
| Production, `deploy/docker-compose.prod.yml` (repo-canonical, line 90) | `postgres:16-alpine` | no |
| `docker-compose.yml`, `docker-compose.test.yml`, `docker-compose.staging.yml`, the legacy root `docker-compose.prod.yml` | `postgres:16-alpine` | no |
| This session's local Postgres 16 cluster | Ubuntu package | no (`/usr/share/postgresql/16/extension/` has no `vector*`, and `postgresql-16-pgvector` is not in the configured apt sources) |

The official `postgres:16-alpine` image ships the contrib extensions and not
pgvector. A migration running `CREATE EXTENSION vector` would fail in every CI
job's `prisma migrate deploy` and on the next production deploy. So, as the
task prescribed for this branch of the decision, **no migration ships here**.

## Design

```
caller (usecase / job / tool, later phases)
   │  getVectorRepository(): VectorRepository | null      ← null unless VECTOR_STORE_BACKEND=pgvector
   ▼
src/app-layer/repositories/VectorRepository.ts            ← the ONLY way in (ESLint local/vector-store-single-seam)
   │  validates: strict record (vectors only), one revision + one dimension count per call,
   │  no duplicate key, k ≤ 50, batch ≤ 500, listing ≤ 5000; empty rebuild refused
   │  counts every outcome: vector_index.requests{operation, backend, outcome}
   ▼
VectorStoreBackend (ctx-taking; tenant only from ctx.tenantId)
   ├── vector/in-process-store.ts   reference implementation; tests construct it; never selected by config
   └── vector/pgvector-store.ts     raw Prisma.sql inside runInTenantContext; probes extension + table first,
                                     refuses PGVECTOR_NOT_INSTALLED; table "KnowledgeVector" (follow-up migration)
```

A row is `(tenantId, sourceModel, sourceId, chunkIndex, embeddingRevision)` as
its key, plus `contentHash` (hex SHA-256 of the chunk text), `dimensions` and
the vector. **No text.** The text's system of record is Postgres under the
encryption manifest (`KnowledgeChunk`, the index pipeline's phase); search
returns references and scores, and the caller hydrates text through the source
row's own repository under RLS.

**Rebuildable from Postgres** is a method, not a slogan.
`rebuildRevision(ctx, revision, batches)` makes the tenant's rows of one
revision exactly what the batches yield: rows are stamped with the rebuild's
generation, and only after the last batch are rows of that revision with
another generation deleted. Consequences, each a test:

- a rebuild into an empty store reproduces the keys and hashes that the
  incremental writes produced;
- re-running a rebuild is a no-op (`unchanged` = all, `deleted` = 0);
- a source that throws part-way deletes nothing (it leaves a superset, and a
  stale reference hydrates to nothing under RLS);
- an empty source is refused `EMPTY_REBUILD_SOURCE` unless the caller passes
  `allowEmpty` — "the tenant has no chunks" and "the read is broken" look the
  same, and only one of them should erase the index (invariant 5 of the
  recertification section, applied here). The refusal is thrown INSIDE the
  iteration, before it completes, so the backend's delete step is unreachable;
- a rebuild touches one revision and one tenant only;
- a rebuild never erases a write that landed while it ran. A rebuild spans
  many transactions, so an ingestion upsert, a re-upsert of a row it already
  stamped, or a second rebuild can commit between its batches. Every write
  therefore stamps a store-wide write sequence (`writeSeq`), and the final
  delete spares every row written after the rebuild began — it removes only
  rows it did not stamp AND whose `writeSeq` is below the `startSeq` it drew
  before reading the source. On pgvector the sequence is drawn under an
  exclusive `(tenant, revision)` advisory lock that every write takes shared,
  so no write in flight can draw a number below `startSeq` and commit after
  it. A plain upsert also keeps the generation a rebuild stamped
  (`COALESCE`) instead of resetting it. The cost is a possible superset, which
  hydration under RLS already tolerates. This needs the source to be read
  lazily, after `rebuildRevision` is called — a source read up front could be
  older than `startSeq`.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/repositories/VectorRepository.ts` | The seam: validation, bounds, outcome metric, `getVectorRepository()` (off unless the env says `pgvector`), `createVectorRepository(store)` |
| `src/app-layer/repositories/vector/types.ts` | Record / key / match shapes, the `VectorStoreBackend` contract, refusal reasons, bounds |
| `src/app-layer/repositories/vector/in-process-store.ts` | Reference backend for tests; isolation by construction |
| `src/app-layer/repositories/vector/pgvector-store.ts` | pgvector backend, constructed only by the env switch, fails closed without extension and table |
| `src/env.ts` | `VECTOR_STORE_BACKEND`, a plain optional string; only exactly `pgvector` is on |
| `eslint-rules/rules/vector-store-single-seam.js` (+ README, `index.js`, `eslint.config.mjs`) | No file under `src/` but the seam loads `repositories/vector/*` or names `KnowledgeVector` in a literal |
| `eslint-rules/__tests__/vector-store-single-seam.test.ts` | RuleTester cases, plus planted files linted with the real config |
| `tests/guards/eslint-local-rules-wired.test.ts` | Lists the new rule |
| `tests/unit/vector-repository.test.ts` | Two-tenant isolation, vectors-only, revision spaces, bounds, rebuild semantics, the env switch |
| `tests/unit/vector-pgvector-backend.test.ts` | pgvector backend: fail-closed probe (extension, version ≥ 0.8.0, table); every statement inside `runInTenantContext(ctx)` and binding `ctx.tenantId` as a parameter; iterative scan set before the search; the rebuild's lock-and-sequence protocol |
| `tests/guardrails/sub-processor-coverage.test.ts` | Allowlists `VECTOR_STORE_BACKEND`: an in-database extension, not an external endpoint |

## Decisions

- **The seam is held by an ESLint rule, not a source-scan guard.** A banned
  import is structural (CLAUDE.md). The rule also refuses the TABLE NAME in any
  literal outside the seam, because a raw query needs no import to bypass a
  repository. Type-only imports of the backends are refused too: the repository
  re-exports every type a caller needs.
- **Every backend method takes `ctx`; none takes a tenant id.** Both backends
  read `ctx.tenantId` and nothing else, so no caller can name another tenant.
- **Vectors-only is enforced at run time, not only by type.** The record schema
  is `.strict()`: a record carrying `text` (a chunk spread into a write) is
  refused `UNKNOWN_RECORD_FIELD`, never trimmed. Trimming would make the next
  backend's mistake silent. `contentHash` must be 64 hex characters, so it
  cannot carry prose either.
- **One revision and one dimension count per call; search never crosses
  revisions.** Vectors of two embedding revisions are not comparable. A
  dimension disagreement with the revision's stored rows is refused, never
  padded or truncated.
- **The in-process backend is never selected by configuration.** A production
  store that silently lives in a process heap would look written and vanish on
  restart. Off means `null`, and callers must handle `null`.
- **The env switch is a plain string read strictly** (`'pgvector'` exactly),
  the `AGENT_DRIVER_FLUE` precedent: a typo is "off", not a process that will
  not boot. Even when set, the backend probes and refuses until the extension
  and the table exist; a negative probe is re-asked on the next call.
- **No Prisma model yet.** A model whose table no migration creates fails the
  CI fresh-DB drift gate, and the table needs the extension. So the
  schema-driven guardrails (RLS coverage, index coverage, retention
  classification) have nothing to classify in this change; the follow-up brings
  the model and they bind there.
- **A filtered search must not starve on the shared index.** The follow-up's
  HNSW index is one per embedding revision, shared by every tenant holding it,
  and pgvector applies a WHERE clause AFTER the approximate scan. With the
  defaults the scan yields `hnsw.ef_search` (40) candidates across all tenants
  and the `"tenantId"` filter (and RLS, and any `sourceModels` filter) then
  discards most of them: a tenant holding 2% of a revision gets about one hit
  for `k = 10`. So the backend turns on iterative index scans for each
  search's own transaction (`set_config('hnsw.iterative_scan', 'strict_order',
  true)`, and `hnsw.ef_search = max(40, k)`), which keeps scanning until `k`
  rows survive the filter or `hnsw.max_scan_tuples` (default 20,000) is
  reached; `strict_order` keeps the results in exact distance order. That
  needs pgvector **0.8.0 or later**, so the probe refuses an older extension
  `PGVECTOR_NOT_INSTALLED` and the image choice below must carry ≥ 0.8.0.
  The residual limit is a tenant whose share of a revision is so small that
  20,000 candidates hold fewer than `k` of its rows (below roughly 0.05% at
  `k = 10`). That is the measured floor D-L4-1 names: the follow-up's
  integration test measures recall@k for a small tenant beside large ones,
  and the answer, if it falls short, is a per-tenant partial index or table
  partitioning for the largest tenants, or a raised `max_scan_tuples` — or,
  past that, Weaviate's native multi-tenancy.
- **`readyz` does not gate on the store** (nothing calls it yet); the outcome
  metric `vector_index.requests` is the alerting surface.

## Owner-approved follow-ups (not in this change)

### 1. The image change — every Postgres, in one pull request with the migration

The migration below runs `CREATE EXTENSION`, so every Postgres that runs
`prisma migrate deploy` must carry `vector` in the SAME pull request: the three
`ci.yml` services, `dast.yml`, `dast-full.yml`, `integration-stress.yml`,
`load-test.yml`, the four root Compose files and
`deploy/docker-compose.prod.yml`. Two candidates, each pinned by digest per the
runtime-image pillar of `docs/dependency-governance.md`:

Either way the extension must be **pgvector 0.8.0 or later** (iterative
index scans; see the filtered-search decision above) — the backend's probe
refuses an older one.

- **(a) `pgvector/pgvector:pg16` by digest.** Published by the pgvector
  project, Debian-based. **This is a libc change** (musl → glibc) on the
  production data volume: text indexes built under the database's collation on
  musl can order differently under glibc, which corrupts index lookups
  silently. It must NOT be swapped in place on `pgdata`; it needs a
  `pg_dump`/restore into the new image (or a REINDEX of every text index and a
  collation-version check), in a maintenance window.
- **(b) A repository-built image `FROM postgres:16-alpine@sha256:…`** compiling
  pgvector at a pinned release tag. It keeps musl, so the existing volume is
  reused in place; the price is a build-and-publish workflow and its own
  dependency-governance row.

Recommendation: (b) for production because it avoids a data-volume migration;
either is acceptable in CI. The owner chooses; the deployment goes through
`deploy/apply.sh` (`CONFIRM=1`) and `deploy/check-drift.sh`, as every Compose
change does.

### 2. The capacity line

**No new container**, so the "no new container until C1" rule is not crossed.
But memory and disk grow inside the existing `postgres` service, which C1
limits. Proposed line for the master's capacity table, replacing the `weaviate`
line's 1.5 GB estimate:

| Line | Containers | Added by | Memory ceiling | CPU cap | Basis |
| --- | --- | --- | --- | --- | --- |
| Vectors (pgvector) | inside `postgres` | vector store follow-up | +0.5 GB on `postgres`'s limit (estimate) | `postgres`'s own | a 1024-dimensional `float4` vector is 4 KiB; 100k chunks ≈ 0.4 GB of heap plus an HNSW graph of similar order, served from `shared_buffers`/page cache; index builds take `maintenance_work_mem`, which should be capped for the build (e.g. 256 MB) |

The figure is a planning estimate until C0 measures `postgres` and the first
index build is measured.

### 3. The migration (draft; applies only after 1)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "KnowledgeVector" (
    "id"                TEXT        NOT NULL PRIMARY KEY,
    "tenantId"          TEXT        NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
    "sourceModel"       TEXT        NOT NULL,
    "sourceId"          TEXT        NOT NULL,
    "chunkIndex"        INTEGER     NOT NULL CHECK ("chunkIndex" >= 0),
    "embeddingRevision" TEXT        NOT NULL,
    "contentHash"       TEXT        NOT NULL CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
    "dimensions"        INTEGER     NOT NULL CHECK ("dimensions" BETWEEN 1 AND 4096),
    "embedding"         vector      NOT NULL,
    "rebuildGeneration" TEXT,
    -- Every write draws a fresh value (INSERT default; ON CONFLICT sets it from
    -- EXCLUDED); a rebuild deletes only rows below the value it drew first.
    "writeSeq"          BIGSERIAL   NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeVector_dims_match" CHECK (vector_dims("embedding") = "dimensions")
);
CREATE UNIQUE INDEX "KnowledgeVector_key"
    ON "KnowledgeVector" ("tenantId", "embeddingRevision", "sourceModel", "sourceId", "chunkIndex");
CREATE INDEX "KnowledgeVector_tenant_source"
    ON "KnowledgeVector" ("tenantId", "sourceModel", "sourceId");

ALTER TABLE "KnowledgeVector" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeVector" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "KnowledgeVector"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY tenant_isolation_insert ON "KnowledgeVector"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY superuser_bypass ON "KnowledgeVector"
    USING (current_setting('role') != 'app_user');
GRANT SELECT, INSERT, UPDATE, DELETE ON "KnowledgeVector" TO app_user;
-- The INSERT default and the rebuild's start both call nextval on it.
GRANT USAGE ON SEQUENCE "KnowledgeVector_writeSeq_seq" TO app_user;

-- Per adopted embedding revision, a partial HNSW index on the typed cast the
-- search uses (one table holds every revision; the column is untyped):
-- CREATE INDEX CONCURRENTLY "KnowledgeVector_hnsw_<rev>" ON "KnowledgeVector"
--   USING hnsw (("embedding"::vector(1024)) vector_cosine_ops)
--   WHERE "embeddingRevision" = '<revision>';
```

With it, the same pull request adds a Prisma model in a new
`prisma/schema/knowledge.prisma` with `embedding Unsupported("vector")`, so the
schema-driven guardrails bind: `rls-coverage` (the policies above),
`schema-index-coverage` (the two indexes), `retention-policy-coverage` (classify
it in `docs/data-retention.md` as a derivative of its source rows: purged with
them and with the tenant, never in `TENANT_PURGE_RETAINED`), and the tenant
purge. It runs `tests/unit/vector-repository.test.ts`'s cases against the
pgvector backend as an integration test, which is what proves the SQL in
`pgvector-store.ts` against a real server — that SQL is unexercised by a live
Postgres in this change.

**Encryption.** A searchable vector cannot be an encrypted-fields entry (the
manifest encrypts strings; similarity search needs the plaintext vector). The
vectors stay inside the perimeter D-L4-1 chose pgvector for — the same
database, RLS, backups and access controls — and are classified as business
content (embedding inversion is real). That is the accepted trade, not an
omission; the chunk TEXT remains under the manifest.

## Rollback plan and risk assessment

**This change.** No migration, no schema change, no new container, no new
dependency, nothing calls `getVectorRepository()`, and the env switch is unset
everywhere, so the runtime effect is nil. Rollback: revert the commit. Risk:
the new ESLint rule could flag an existing file; it was run over `src/` and
flags none.

**The follow-up (SIGNIFICANT: migration + image change).** Rollback policy is
forward-fix for migrations. The table is rebuildable from Postgres by
construction, so `DROP TABLE "KnowledgeVector"` loses nothing of record, and
unsetting `VECTOR_STORE_BACKEND` turns every caller off without a deploy of
code. The image change is the risky half: with option (a) the musl → glibc
collation change on `pgdata` is the main hazard (silent index misordering) and
is mitigated only by dump/restore; with option (b) the risk is a build of the
extension against the exact server version, mitigated by pinning both and by
CI running the same image. The `postgres` service's memory grows by the index;
C1's limit must leave room (the capacity line above).
