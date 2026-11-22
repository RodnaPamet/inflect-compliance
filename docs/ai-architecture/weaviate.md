inflect · ai architecture · vector store · roadmap v2 · 2026-11-11

# The vector store: pgvector in Postgres first, Weaviate only on a measured floor, Layer 4

> **Status: living design** — the integration roadmap for Layer 4's "vector DB &
> multi-tenant isolation" box, which the target architecture fills with
> Weaviate. The owner decided on 2026-11-11 (D-L4-1) to deliver it first with
> the **pgvector** extension inside the existing Postgres, under the RLS that
> already protects every tenant row, and to bring Weaviate in only if a
> measured recall or latency floor is not met. The owner also adopted the
> **vectors-only rule** the same day (D-L4-2): no chunk text outside Postgres.
> The **Current state** section is true today (main 3.399.0, `674c9df33`, plus
> Phase 3.1–3.5's query path). The **Roadmap** section is the plan. This is a child of
> [`docs/ai-architecture-roadmap.md`](../ai-architecture-roadmap.md): read that
> first for the target map, the global rules **G1–G13** every phase here
> inherits, and the sequencing. The filename keeps the box's name so links into
> it stay stable (the [`langflow.md`](./langflow.md) precedent). If the code
> contradicts a fact here, the code wins and the pull request that finds it
> corrects this document.

## Where it sits in the master roadmap

| | |
| --- | --- |
| Layer · box | 4 — Knowledge & deep RAG · "Weaviate (vector DB & multi-tenant isolation)" |
| Wave | 1 (the first Layer 4 wave, zero-GPU) — see master § Sequencing. Phase 4 (Weaviate) is conditional and has no wave until a floor is missed |
| Depends on | a Postgres image that carries the pgvector extension (Phase 1.1 — the image on the VM today does not); **an embedding provider to be useful** → [`nemotron-retriever.md`](./nemotron-retriever.md) |
| Unblocks | [`ragflow.md`](./ragflow.md) (somewhere for parsed chunks to go), [`ragas.md`](./ragas.md) / [`ares.md`](./ares.md) (something to evaluate), the assistant's `search_knowledge` tool |
| Owner decisions | **D-L4-1** decided 2026-11-11 (owner): pgvector first, in the existing Postgres under RLS; Weaviate only later, if a measured recall/latency floor is not met. **D-L4-2** decided 2026-11-11 (owner): vectors-only — no chunk text outside Postgres. **D-L4-8** decided 2026-11-12 (owner): the self-built Postgres image keeps the 2026-10-10 tag rule, rebuilt weekly and whenever the upstream `16-alpine` digest changes, as a moving line tag plus an immutable per-build tag. **D-L4-7** (lexical arm: a keyed blind-token index) and **D-L4-9** (the floors that trigger Phase 4: recall@10 at least 0.95 of exact, p95 at most 300 ms at `k = 10`) are recorded as decided on 2026-11-12 in the master's decision table. **D-L4-9 amended 2026-11-16** (owner): the same two values also decide whether `search_knowledge` is offered (Phase 3.5's gate), until Ragas Phase 2's answer-quality floors join them; the figures are measured on a probe tenant of 5,000 chunks in an index of 4 times that, re-sized once production's largest tenant is indexed |
| Complete at | Phase 3. Phase 4 runs only if Phase 3's record misses a floor; until then it is not part of completion |

## At a glance

Green: decided, or on `main`. Blue: a phase not yet on `main`; it turns green (`done`) in the pull request that meets its "done when". Slate dashed: a conditional phase that starts only on a measured trigger. Dashed white: another roadmap this one waits on or unblocks. Pink: an evaluation record or a behavioural test.

```mermaid
flowchart LR
  P0(["Phase 0 · decided 2026-11-11<br/>D-L4-1 pgvector first<br/>D-L4-2 vectors only"]):::done
  P1["Phase 1 · pgvector in Postgres<br/>image carrying the extension<br/>KnowledgeChunk + embedding table<br/>VectorRepository sole SQL seam<br/>RLS two-tenant test"]:::todo
  P2["Phase 2 · index pipeline<br/>knowledge-index job<br/>chunk text encrypted<br/>rebuildable from Postgres"]:::todo
  P3["Phase 3 · guarded query path<br/>search_knowledge read tool<br/>through the funnel and guards<br/>mount gate on the Ragas record<br/>floors measured"]:::todo
  P4["Phase 4 · Weaviate<br/>only if a floor is missed<br/>same seam, vectors only"]:::optional
  EMB["nemotron-retriever P1<br/>embedding seam"]:::ext
  RER["nemotron-retriever P2<br/>reranker"]:::ext
  REC["Ragas record<br/>for the retriever revision"]:::eval
  RF["ragflow P2<br/>layout-aware chunks"]:::ext
  ISO["Two-tenant tests<br/>repository, job, tool"]:::eval
  P0 --> P1 --> P2 --> P3
  P3 -->|only if the record<br/>misses a floor| P4
  EMB -.-> P2
  RER -.-> P3
  REC -.->|opens the gate| P3
  P2 -.->|unblocks| RF
  P1 --- ISO

  classDef done fill:#d1fae5,stroke:#047857,color:#064e3b
  classDef todo fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a
  classDef gate fill:#ede9fe,stroke:#6d28d9,color:#3b0764
  classDef ext fill:#ffffff,stroke:#64748b,color:#334155,stroke-dasharray:3 3
  classDef eval fill:#fce7f3,stroke:#be185d,color:#831843
  classDef declined fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-dasharray:4 3
  classDef optional fill:#f1f5f9,stroke:#475569,color:#334155,stroke-dasharray:6 3
```

## Current state (true today)

- **The knowledge store exists and nothing writes to it.** Migration
  `20261115190000_knowledge_vector_store` creates the `vector` extension and
  two tenant-scoped tables under RLS + `FORCE`
  (`prisma/schema/knowledge.prisma`): `KnowledgeChunk` (the chunk's key, its
  `text` in the encryption manifest, the hex SHA-256 of the text, the chunker
  revision) and `KnowledgeChunkEmbedding` (the composite chunk reference
  `(chunkId, tenantId)` with `ON DELETE CASCADE`, the embedding model, the
  dimension count held to `vector_dims` by a CHECK, the content hash and an
  untyped `vector`, never text). One partial HNSW expression index exists, for
  `intfloat/multilingual-e5-small` at 384 dimensions (D-L4-3).
  `src/app-layer/repositories/VectorRepository.ts` is the only way in, held by
  ESLint `local/vector-store-single-seam` (no other file under `src/` loads a
  backend, names `KnowledgeChunkEmbedding` in a literal or touches the
  `knowledgeChunkEmbedding` Prisma delegate); it is off unless
  `VECTOR_STORE_BACKEND=pgvector`, it counts and times every request
  (`vector_index.requests`, `vector_index.request.duration`), and
  `tests/integration/vector-tenant-isolation.test.ts` proves two tenants apart
  against the real tables
  ([implementation note](../implementation-notes/2026-11-15-knowledge-store-tables.md);
  the seam's own: [2026-11-11](../implementation-notes/2026-11-11-vector-store-seam.md)).
- **The index job exists, and an approved policy version is its one source.** `knowledge-index`
  (`src/app-layer/jobs/knowledge-index.ts`, body in
  `src/app-layer/services/knowledge-index.ts`) takes `(tenantId, sourceModel,
  sourceId)`, reads the row under `runInTenantContext`, cuts it with the plain
  paragraph chunker (`src/lib/knowledge/paragraph-chunker.ts`, revision
  `paragraph@1`, at most 1,200 characters a chunk because `tei-embed` truncates
  past the model's 512 tokens without an error), makes the source's
  `KnowledgeChunk` rows exactly those chunks (keep by `contentHash`, replace a
  changed position so its vectors of every model go by cascade, delete
  positions past the end), and embeds only the chunks whose vector for the
  model is missing or of other text, `INDEX_EMBED_BATCH` (8) passages per call.
  A re-run over an unchanged source makes no embedding call and writes nothing.
  The only reader is `PolicyVersion`, approved versions only. With the store or
  the embedding route off, the job reads and writes nothing and ends
  `VECTOR_STORE_DISABLED` / `EMBEDDING_NOT_CONFIGURED`, a failure, never a
  success; every run counts on `knowledge_index.runs{source_model, outcome}`.
  Its one enqueue site, `enqueueKnowledgeIndex`, enqueues nothing while either
  switch is off; `decidePolicyApproval` calls it after an approval commits, and
  a policy's soft delete and restore queue its approved versions, so the index
  follows the policy both ways. The `data-lifecycle` purge and the admin's
  manual purge delete a row's chunks before they hard-delete it
  (`services/knowledge-purge.ts`), and the tenant purge removes both tables
  ([implementation notes](../implementation-notes/2026-11-16-knowledge-index-job.md),
  [policy source](../implementation-notes/2026-11-16-knowledge-index-policy-source.md)).
  `scripts/knowledge-reindex.ts --tenant=<slug-or-id>` rebuilds a tenant's
  vectors of the configured model from the stored chunk text alone
  (`services/knowledge-reindex.ts`), which is what makes the index
  rebuildable from Postgres and is the path to a new embedding model
  ([implementation note](../implementation-notes/2026-11-16-knowledge-reindex.md)).
  The backend also refuses a vector whose `contentHash` is not its chunk's
  (`CONTENT_HASH_MISMATCH`), so two overlapping runs of one source cannot file
  the older text's vector against the newer text.
  `weaviate` returns nothing under `src/`; the 18 files matching `embedding`
  use the word in its prompt/UI sense (`risk-assessment/prompt-builder.ts`,
  `EvidenceGallery.tsx`). The database is PostgreSQL 16 behind PgBouncer, and
  the production stack (`deploy/docker-compose.prod.yml`, repo-canonical since
  #2849) runs `postgres`, `pgbouncer`, `redis`, `clamav`, `app`, `worker`,
  `watchtower`, `caddy` — nothing else.
- **Every Postgres the repository runs carries pgvector.**
  `deploy/postgres/Dockerfile` is `postgres:16-alpine` plus pgvector `v0.8.7`
  (pinned by tag and commit, compiled without `-march=native`, toolchain
  removed in the same layer), with the entrypoint's `gosu` rebuilt from the
  same release on a current Go (the upstream binary's Go standard library
  carried findings the Trivy gate blocks on). ci.yml's `Postgres image` job builds it,
  smoke-tests it (`deploy/postgres/smoke.sh`: musl, no toolchain, `CREATE
  EXTENSION vector`, a cosine query by sequential scan and through HNSW) and
  gates it with Trivy on every change to `deploy/postgres/`;
  `.github/workflows/postgres-pgvector-image.yml` publishes it to
  `ghcr.io/rodnapamet/postgres-pgvector` as the line tag `16-alpine` plus an
  immutable per-build tag, from `main` only, on dispatch, every Wednesday, and
  on any day the upstream `16-alpine` digest moved (D-L4-8)
  ([implementation note](../implementation-notes/2026-11-15-postgres-pgvector-image.md)).
- **Every Postgres reference is that image's line tag**,
  `ghcr.io/rodnapamet/postgres-pgvector:16-alpine`:
  `deploy/docker-compose.prod.yml`, the four root Compose files
  (`docker-compose.yml`, `.test`, `.staging`, `.prod`) and the service
  containers of seven workflows (`ci.yml` three times, `agent-evals.yml`,
  `dast.yml`, `dast-full.yml`, `garak.yml`, `integration-stress.yml`,
  `load-test.yml`). `tests/guards/postgres-pgvector-image.test.ts` holds the
  whole population to that tag, and the official `postgres:16-alpine` is only
  the Dockerfile's base. On the VM the change takes effect when the owner's
  `VM apply` recreates `postgres` on the same volume (`docs/deployment.md`,
  "`postgres`: the image carries pgvector").
- **The one extension a migration creates is `pg_trgm`**
  (`20260806150000_control_index_fit`), a contrib extension marked trusted,
  which a database owner may create without superuser. pgvector's
  `vector.control` (0.8.7, the current release) does not declare itself
  trusted, so `CREATE EXTENSION vector` needs a superuser.
- **The images that do carry pgvector are Debian.** `pgvector/pgvector`
  publishes `0.8.7-pg16`, `-bookworm` and `-trixie` tags, all built `FROM
  postgres:<major>-<debian>`. Moving the existing data volume from the
  Alpine (musl) image to a Debian (glibc) one changes the C library that
  orders text, so every index on a text column built under the old collation
  is suspect until it is rebuilt. Docker Hub lists `pgvector/pgvector:0.8.7-pg16-bookworm`
  at about 156 MB compressed against about 116 MB for `postgres:16-alpine`
  (read 2026-11-11).
- **The query path exists, and its mount gate keeps it closed.**
  `VectorRepository.search` takes a `strategy` (`auto`, the default; `index`;
  `exact`): a tenant holding at most `EXACT_SCAN_MAX_ROWS` (2,000) vectors of
  the revision is searched EXACTLY, by an expression the HNSW index does not
  match; above that the shared index serves, with `hnsw.iterative_scan =
  relaxed_order`, `hnsw.max_scan_tuples` bounded at 20,000 and `ef_search` at
  least 40, all set per transaction (`HNSW_SEARCH`); and an indexed search that
  came back short of `k` is repeated exactly for a tenant of at most
  `EXACT_FALLBACK_MAX_ROWS` (50,000). `tests/integration/vector-filtered-search-recall.test.ts`
  shows a 24-vector tenant beside a 2,400-vector one starving without the
  iterative scan and getting `k` with it. The read usecase `searchKnowledge`
  (`usecases/knowledge-search.ts`) embeds the question as a `query`, searches
  only the source models the caller's own read policy admits
  (`assertCanReadPolicies` for `PolicyVersion`), retrieves the revision's
  `k` (20) and returns the caller's first `k`, and hydrates each hit's text
  from `KnowledgeChunk` and its citation (the policy, title, version) under
  RLS, dropping a hit whose chunk no longer hashes to the vector's
  `contentHash` or whose policy is gone. The MCP read tool `search_knowledge`
  (`src/lib/mcp/tools/knowledge-tools.ts`, `policies:read`, `policies.view`,
  a `limit` of at most 20, the name every bounded read tool gives its count)
  wraps it; every engine and the assistant reach it through
  `runGuardedTool → runReadTool`, so its text is scanned by `guardUntrustedInput`
  and `guardEgress` like any read result. It is offered only while the mount
  gate (`services/knowledge-search-mount.ts`) finds a passing RAG evaluation
  record for the deployment's retriever revision
  (`services/knowledge-search-revision.ts`) — one whose recomputed figures
  meet D-L4-9's two floors, which the owner decided on 2026-11-16 gate the tool
  as well as Phase 4 — and **none exists**, so the tool is in no catalogue
  today; with the store and route on, a run granted it records
  `RETRIEVER_NOT_EVALUATED`. The Ragas nightly measures both figures and keys
  its output by that same revision (`scripts/rag-eval/search-seam.ts`), so the
  record it writes is the one the gate looks up. Its answer stage asks the
  assistant in process with the tool mounted by the evaluation's own scoped
  decision (`services/rag-evaluation-mount.ts`), which no deployed app can
  open; no keyed night has run, so no record exists yet
  ([note](../implementation-notes/2026-11-16-rag-eval-gate-wiring.md),
  [answer stage](../implementation-notes/2026-11-16-rag-eval-answer-stage.md)).
  The questionnaire feature still grounds answers from the answer library and
  ships evidence *titles* only, and agents otherwise read through the audited
  MCP read tools (`src/lib/mcp/tools/`)
  ([implementation note](../implementation-notes/2026-11-16-knowledge-search.md)).
- **Two isolation layers protect every tenant row, and both are in Postgres.**
  RLS with `FORCE ROW LEVEL SECURITY` on every tenant table plus the
  application-layer `tenantId` filter in every repository
  (`tests/guardrails/rls-coverage.test.ts`,
  `tests/unit/tenant-isolation-structural.test.ts`). A table added in Postgres
  inherits both and the coverage guardrail fails CI until it has its
  policies; a store outside Postgres has neither.
- **Business content is encrypted at rest by a manifest.** `Finding.description`,
  `Risk.treatmentNotes`, `PolicyVersion.contentText`, `TaskComment.body` and the
  rest of `src/lib/security/encrypted-fields.ts` are ciphertext in the database
  and decrypted on read. Postgres cannot search ciphertext, lexically or
  otherwise.
- **Tenant data leaves with the tenant through one purge.** The tenant purge
  (`usecases/tenant-purge.ts`, the last step of `data-lifecycle`) deletes every
  tenant-scoped table except `TENANT_PURGE_RETAINED`, and soft-deletes are
  purged after 90 days (`docs/data-retention.md`). A tenant-scoped Postgres
  table is covered by that purge as soon as it exists; a second store is not.

## Fit, and what is deliberately not adopted

**Adopted (D-L4-1, 2026-11-11).** pgvector as the vector store, inside the
existing Postgres: the vectors sit in a tenant-scoped table under RLS and the
repository's `tenantId` filter, in the same backups, purged by the same tenant
purge, with no new service to deploy, secure or watch. Similarity is cosine
over an HNSW index, one partial expression index per embedding model, so two
models can be indexed side by side during a model change. D-L4-3 chose
`intfloat/multilingual-e5-small` (384 dimensions) on 2026-11-13.

**Adopted (D-L4-2, 2026-11-11): the vectors-only rule.** Chunk text lives in
exactly one place: `KnowledgeChunk.text`, a Postgres column in the encryption
manifest. The embedding row carries `tenantId`, the chunk reference, the
embedding model id, the dimension count, a `contentHash` and the vector —
never the text. No other store, cache, log or service holds chunk text past
the job that produced it: not Weaviate if Phase 4 ever runs, not the parsing
service ([`ragflow.md`](./ragflow.md)), not a trace exporter.

**What the rule costs, said plainly.**

- *The vector itself is not encrypted.* An approximate-nearest-neighbour index
  needs plaintext floats, so the embedding column is a plaintext derivative of
  encrypted text, and embedding inversion is a real attack. It is classified
  as business content, it never leaves Postgres, and a database backup now
  carries it. Phase 2 records this in `docs/encryption-data-protection.md`
  rather than leaving it to be discovered.
- *There is no lexical arm.* Full-text search (BM25 in Weaviate, `tsvector` in
  Postgres) needs readable text or a plaintext token index next to the
  ciphertext. The earlier plan promised "hybrid BM25 + vector" in Weaviate
  while also keeping text out of Weaviate; those two cannot both hold, because
  Weaviate's BM25 indexes text properties. So Phase 3 is dense-only and its
  revision key carries no `alpha`. A lexical arm is an open question for the
  owner: none (rely on the reranker), a keyed blind-token index (an HMAC of
  each normalised token under a per-tenant key, matching exact terms without
  storing them), or a plaintext `tsvector` (which this document recommends
  against: it is the text, tokenised).

**Not adopted, with the reason.**

- *Weaviate now.* A second store whose isolation is a property of application
  code alone, a second backup and restore story, a second purge hook, and a
  1.5 GB line on a VM whose capacity budget already does not close (master §
  Capacity). It stays the measured alternative: Phase 4, triggered only by a
  missed floor.
- *An embedding computed inside the database* (any extension or module that
  calls a model from Postgres or Weaviate). The embedding comes from the
  retriever seam ([`nemotron-retriever.md`](./nemotron-retriever.md)) and
  nowhere else, so residency is decided once (G1).
- *Swapping the production image for `pgvector/pgvector` as the default path.*
  It changes the C library under an existing data directory (see Current
  state). Phase 1.1 builds pgvector onto the same Alpine base instead, and
  keeps the Debian image as the fallback that needs a reindex window.
- *A vector column on the source models.* Each source keeps its own table
  untouched; chunks and embeddings are their own models, so a re-chunk or a
  model change never rewrites a policy or a finding.

## Roadmap (future direction)

### Phase 0 — Decide the store and the rule (decided)

**Sub-phases.**
- [x] 0.1 D-L4-1 decided by the owner on 2026-11-11: pgvector first, in the
      existing Postgres under RLS; Weaviate only later, if a measured recall
      or latency floor is not met.
- [x] 0.2 D-L4-2 decided by the owner on 2026-11-11: vectors-only, no chunk
      text outside Postgres.
- [x] 0.3 The decision, the image fact-check and the lexical-arm finding are
      recorded in
      `docs/implementation-notes/2026-11-11-knowledge-stack-replan.md`.

**Done when.** The note is on `main` and the owner's initials and date are in
the master roadmap's decision table for D-L4-1 and D-L4-2.

### Phase 1 — pgvector in Postgres, and the single seam

**Goal.** Every Postgres the product runs against can load pgvector; the
knowledge tables exist under RLS; exactly one module issues SQL against a
vector column.

**Sub-phases.**
- [x] 1.1 **The image.** `deploy/postgres/Dockerfile`: `FROM
      postgres:16-alpine`, compiling pgvector at a pinned tag (`v0.8.7`
      today) against the image's own server headers, the build toolchain
      removed in the same layer. Same base, same musl, same collation, so the
      existing `pgdata` volume mounts unchanged. **The base stays on the tag,
      not a digest, on purpose:** the owner decided on 2026-10-10 that the
      production database is baselined by tag because "a digest pin would
      freeze security patches that the alpine tag delivers"
      (`tests/guardrails/runtime-image-pinning.test.ts`, the `postgres`
      entry). A self-built image would freeze them anyway unless it is
      rebuilt, so the workflow that publishes it to GHCR runs **on a
      schedule** (weekly) and whenever the upstream `16-alpine` digest
      changes, republishing a moving line tag (`…/postgres-pgvector:16-alpine`)
      plus an immutable per-build tag for rollback. Compose and CI reference
      the line tag, never `latest`, and the new repository gets its own
      `BASELINE` entry in that guard with the same reason as `postgres`. A
      patch then reaches the VM the way it does today, on a pull and
      `deploy/apply.sh` (Watchtower does not manage `postgres`). Pinning the
      base and the references by digest instead, with a bump pull request on
      the same cadence, would reverse the 2026-10-10 decision, so it is raised
      for the owner (§ Owner decisions) rather than taken here. The fallback,
      `pgvector/pgvector:0.8.7-pg16-bookworm`, is taken only with a planned
      `REINDEX DATABASE` (or dump and restore) window, written into the pull
      request's rollback plan. *Landed in two steps, as tei-embed's image did
      (#5687 then #5702):* the Dockerfile, the smoke test, ci.yml's
      `Postgres image` job and the publishing workflow first; the image is
      then published by the owner's dispatch of `Postgres pgvector image` from
      `main`, and only then do the references and the `BASELINE` entry move
      (1.2), because a CI service container cannot pull an unpublished image
      and the guard refuses a baseline entry nothing references.
- [x] 1.2 **Every Postgres moves together.** The production Compose file, the
      four root Compose files and the seven workflows' service containers all
      reference the same image and line tag, or the fresh-DB migration gate
      fails in CI the day the first `CREATE EXTENSION vector` lands. A guard
      pins that every Postgres image reference in the repository is that one
      image.
- [x] 1.3 **The extension.** A migration runs `CREATE EXTENSION IF NOT EXISTS
      vector`. Because the extension is not trusted, the role that runs
      `prisma migrate deploy` must be a superuser, or the operator creates the
      extension once as `postgres` before the migration (which is then a
      no-op). The pull request states which role the production
      `DIRECT_DATABASE_URL` uses, read off the VM, not assumed. *What the
      repository shows (2026-11-15):* `prisma migrate deploy` runs in the
      `app` container's entrypoint over `DIRECT_DATABASE_URL`, falling back
      to `DATABASE_URL` (PgBouncer) when it is unset (`prisma.config.ts`);
      both live in `/opt/inflect/.env.prod`, which the repository does not
      hold. The only login role the canonical Compose file configures is
      `postgres`, the image's superuser (`POSTGRES_USER`, PgBouncer's
      `DB_USER`), and `init-roles.sh` creates `app_user` as `NOLOGIN`. So the
      repository points at a superuser, and **the VM's actual
      `DIRECT_DATABASE_URL` role is still to be read off the VM** (`VM check`)
      before the first apply that carries the migration.
- [x] 1.4 **The models**, in a new `prisma/schema/knowledge.prisma`:
      `KnowledgeChunk` (tenantId, sourceModel, sourceId, chunkIndex, `text` in
      the encryption manifest, contentHash, `chunkerRevision`) and
      `KnowledgeChunkEmbedding` (tenantId, chunkId with `ON DELETE CASCADE`,
      embeddingModel, dimensions, contentHash, `embedding
      Unsupported("vector")`). RLS policies and `FORCE ROW LEVEL SECURITY` in
      the migration; `tenantId`-leading indexes; both classified in
      `docs/data-retention.md` as business records purged with their source
      and with the tenant, before the migration lands
      (`retention-policy-coverage.test.ts`).
- [x] 1.5 **The seam.** `src/app-layer/repositories/VectorRepository.ts` is the
      only module that reads or writes `KnowledgeChunkEmbedding.embedding`:
      Prisma cannot read an `Unsupported` column, so every access is
      parameterised `$queryRaw` (never `$queryRawUnsafe`) inside
      `runInTenantContext`, and every method takes `ctx: RequestContext` and
      also filters on `ctx.tenantId`. No method takes a tenant id as a plain
      argument. A rule refuses SQL naming the embedding table anywhere else
      (G10: a structural rule is an ESLint rule where the shape allows it).
- [x] 1.6 **The index.** One HNSW expression index per embedding model, partial
      on that model: `USING hnsw ((embedding::vector(<dims>))
      vector_cosine_ops) WHERE "embeddingModel" = '<id>'`. The `vector` type
      indexes at most 2,000 dimensions (`halfvec` at most 4,000), so a model
      emitting 2,048 (Nemotron embed's default) is either truncated to a
      supported Matryoshka size or stored as `halfvec`. D-L4-3's choice
      (2026-11-13), `multilingual-e5-small`, emits 384, so it is `vector`. `CREATE INDEX` runs in the migration's transaction, so not
      `CONCURRENTLY` (the `pg_trgm` migration's note says why). **The CI
      fresh-DB schema-drift gate sees each of these indexes.** Prisma cannot
      declare a partial expression index with an operator class, so
      `prisma migrate diff` proposes `DROP INDEX "<name>";` for every one, and
      "Gate: fresh-DB schema drift" fails on any statement not in
      `prisma/fresh-db-schema-drift.expected.sql`. The same pull request adds
      each statement there, verbatim, and signs it off in `SIGNED_OFF` in
      `tests/guardrails/schema-drift-gate-runs-in-ci.test.ts`, which holds the
      file to set equality. The `pg_trgm` indexes are the precedent (group 2,
      PERMANENT): the new members join that group, renamed to cover indexes
      Prisma cannot declare, because the header-count check counts every
      `DROP INDEX` statement as group 2; the header's group-2 count and the
      CURRENT STATE row move in the same commit. Each further embedding model
      that gets an index adds a member, so the D-L4-3 benchmark's candidates
      are measured against exact search without an index, and only the
      adopted model's index lands in a migration. Any other residue the new
      tables produce (the `Unsupported("vector")` column, the extension) is
      measured with `npm run db:check-schema-drift` and reconciled or signed
      off the same way, never pasted in unsigned. *Measured 2026-11-15, and it
      corrects the paragraph above:* with Prisma 7.10.1, a database built from
      the migrations (extension, both tables, the e5 index) diffs against the
      schema with exactly the 90 statements the file already held. Prisma's
      diff does not see an EXPRESSION index at all (the `pg_trgm` indexes are
      on plain columns with an operator class, which it does see), and it
      ignores the extension and the `Unsupported("vector")` column's type. So
      there is nothing to sign off, and adding a `DROP INDEX` line would fail
      the gate in the other direction, because the file is held to equality.
      What keeps the index from being dropped is
      `tests/integration/vector-tenant-isolation.test.ts`, which reads it from
      `pg_indexes` and reads the plan of the backend's own search query.
- [x] 1.7 **The two-tenant behavioural test** (G7, checklist §2), in the
      integration project as `app_user` with RLS live: A inserts chunks and
      embeddings; a nearest-neighbour query under B returns nothing; B asking
      for A's chunk id returns nothing; purging tenant A leaves no row of
      either table.
- [x] 1.8 **Signals.** `/api/readyz` does not gate on the index; an outcome
      metric `vector_index.requests` with an `outcome` label and a latency
      histogram (checklist §4) carry the alerting.

**Prompt.**
```text
Context (main 3.365.0): decisions D-L4-1 (pgvector first, in the existing Postgres under
RLS) and D-L4-2 (vectors-only: chunk text only in Postgres, encrypted) are taken. Every
Postgres in the repo is postgres:16-alpine, whose official build carries no pgvector; the
production Compose file is repo-canonical (deploy/docker-compose.prod.yml, applied by
deploy/apply.sh); runtime images are pinned by digest EXCEPT the Docker Official Images in
tests/guardrails/runtime-image-pinning.test.ts's BASELINE, where postgres is baselined by tag
by owner decision (2026-10-10) so the alpine tag keeps delivering security patches. pgvector's vector.control is not
trusted, so CREATE EXTENSION vector needs a superuser. Repositories take RequestContext and
filter by tenantId; tenant tables carry RLS (tests/guardrails/rls-coverage.test.ts).

Task: (1) deploy/postgres/Dockerfile FROM postgres:16-alpine (by tag, keeping the
2026-10-10 decision) building pgvector at a pinned tag, toolchain removed in the same layer; a
workflow publishing it to GHCR weekly and whenever the upstream 16-alpine digest changes, as a
moving line tag plus an immutable per-build tag; a BASELINE entry for the new repository in
runtime-image-pinning.test.ts; every Postgres reference (prod Compose, root Compose files,
workflow service containers) moved to that line tag, with a guard pinning it. Do NOT pin the
base or the references by digest unless the owner has decided to (weaviate.md § Owner
decisions). (2) A migration creating the extension, and the note
on which role runs migrations in production. (3) prisma/schema/knowledge.prisma with
KnowledgeChunk (text in the encryption manifest) and KnowledgeChunkEmbedding (embedding
Unsupported("vector"), cascade from the chunk), RLS policies, tenantId-leading indexes,
data-retention rows. (4) VectorRepository.ts as the only module touching the embedding
column: parameterised $queryRaw inside runInTenantContext, ctx-first methods, plus a lint
rule refusing SQL on that table elsewhere. (5) One partial HNSW index per embedding model,
and for each the DROP INDEX statement prisma migrate diff will propose added verbatim to
prisma/fresh-db-schema-drift.expected.sql and signed off in SIGNED_OFF in
tests/guardrails/schema-drift-gate-runs-in-ci.test.ts (join group 2, the pg_trgm precedent,
and update the header counts); run npm run db:check-schema-drift to see the residue rather
than guessing it.

Constraints: no text column on the embedding table; no $queryRawUnsafe; readyz does not gate
on the index. Integration test (tests/integration/vector-tenant-isolation.test.ts): A
inserts, B's nearest-neighbour query returns nothing, A's chunk id under B returns nothing,
purging tenant A leaves no rows. Name tests for the invariant. Write an implementation note,
with the rollback plan and risk assessment a SIGNIFICANT change carries (schema migration,
image change).

Done when: typecheck, lint, the new integration test and the existing ratchets (rls-coverage,
schema-index-coverage, retention-policy-coverage, docs-accuracy, schema-drift-gate-runs-in-ci)
are green; CI's fresh-DB migration gate and its schema-drift gate pass on the new image; deploy/check-drift.sh reports no drift after apply.
```

**Hardening.** G5 (an image the repository builds, on a patch-delivering
rebuild schedule rather than a frozen digest, by the 2026-10-10 decision), G7 (RLS
inherited, the two-tenant test at the repository layer, no plain-tenant-id
method), G9 (no embedding provider configured = nothing indexed, nothing
offered), checklist §4 (outcome metric). The lint rule is the structural guard
and the integration test the conduct guard — both, per the checklist's "shape
and conduct". The image move is a SIGNIFICANT change under
`docs/change-management-policy.md`: a rollback plan (the previous per-build tag, and
for the Debian fallback the reindex) and a risk assessment go in the pull
request.

**Done when.** The new image runs on the VM with the extension created, the
two-tenant test is green in the integration shards, and `VectorRepository.ts`
is the only module the lint rule admits.

### Phase 2 — The index pipeline (write side)

**Goal.** Chunks and their embeddings are written by the worker only, and the
whole index can be rebuilt from `KnowledgeChunk` rows.

**Sub-phases.**
- [x] 2.1 A BullMQ job `knowledge-index` (G8) that takes `(tenantId, sourceModel,
      sourceId)`, reads the source row under `runInTenantContext`, chunks it
      (a plain paragraph chunker now; the parsing service later), embeds
      through the retriever seam, and upserts `KnowledgeChunk` and
      `KnowledgeChunkEmbedding` rows keyed by `contentHash`, so a re-run is a
      no-op. *Landed 2026-11-16:* on demand, worker only, wrapped in `runJob`;
      `paragraph@1` chunks of at most 1,200 characters; 8 passages per call;
      deletes positions the source no longer has, and every chunk of a row
      that is gone, unapproved or soft-deleted; a named outcome on every path
      (`src/lib/knowledge/index-outcome.ts`), metric
      `knowledge_index.runs{source_model, outcome}`. Tests: the two-tenant and
      idempotence cases against the real tables
      (`tests/integration/knowledge-index-job.test.ts`), the batching case
      (17 chunks are 3 calls of at most 8) and every outcome
      (`tests/unit/knowledge-index-job.test.ts`).
- [x] 2.2 Triggers: the audit emitters for the source models enqueue the job
      after create and update; the `data-lifecycle` purge deletes a source's
      chunks when it hard-deletes the source (the reference is polymorphic, so
      no foreign key does it); the tenant purge removes both tables with
      everything else tenant-scoped. *Landed 2026-11-16 for the policy source,*
      from the usecases rather than the audit emitters: `logEvent` writes
      inside the transaction, and a job queued there could run before the
      commit. `decidePolicyApproval` queues the approved version after it
      commits; `deletePolicy`, `bulkDeletePolicy` and `restorePolicy` queue the
      policy's approved versions. The `data-lifecycle` purge and `purgeEntity`
      delete a row's chunks first (`services/knowledge-purge.ts`, which knows a
      policy's chunks are its versions'). Each later source wires its own
      trigger in the pull request that adds its reader.
- [x] 2.3 `scripts/knowledge-reindex.ts`: re-embed a tenant's chunks from
      `KnowledgeChunk` text and rebuild its embedding rows. A test proves the
      rebuild reproduces the same `contentHash` set and, under the same model
      revision, vectors within a stated cosine tolerance. That test is what
      "rebuildable from Postgres" means, and it is also the migration path to
      a new embedding model. *Landed 2026-11-16:* the body is
      `reindexTenantKnowledge` (`services/knowledge-reindex.ts`), pages of 200
      chunks, embedded 8 at a time, through `VectorRepository.rebuildRevision`.
      `tests/integration/knowledge-reindex.test.ts` deletes a tenant's vectors
      and rebuilds them with the stub embedder: the same (chunk,
      `contentHash`) set exactly, and every vector within
      `RECOMPUTE_COSINE_TOLERANCE` (`1 - cosine` ≤ 1e-6) of the original. The
      stub is exact; for a real model the tolerance is floating-point noise
      on the same revision and hardware, and a larger gap means a different
      model behind the same id, which is a new revision needing its own
      evaluation record (G11), not a rebuild. A rebuild over a healthy index
      keeps every vector, and one that fails part-way deletes nothing.
- [x] 2.4 `docs/encryption-data-protection.md` gains the embedding column: a
      plaintext derivative of encrypted text, classified business content,
      held only in Postgres and its backups. *Landed 2026-11-16* as the
      classification table's "Business (derivative)" row and the section
      under it.
- [ ] 2.5 First sources, in this order: `PolicyVersion.contentText` (approved
      versions only), evidence file text (post-ClamAV, via the parser seam),
      control descriptions, the questionnaire answer library. *2026-11-16:*
      `PolicyVersion` is indexed (`services/knowledge-sources.ts`; HTML
      flattened to text, Markdown kept). Evidence file text waits on
      [`ragflow.md`](./ragflow.md): the parser seam's code is on `main` (1.1,
      1.2, 1.4, 1.7), but its service (1.3) is a nightly window that a queued
      document must WAIT for rather than be indexed from the stub, and the
      evidence wiring with its chunk metadata migration is that roadmap's own
      Phase 2. Control descriptions and the answer library come after it in
      this order.

**Decisions.**

| Decision | Owner, date | Basis |
| --- | --- | --- |
| The job embeds **8 passages per `embed` call** (`INDEX_EMBED_BATCH` in `src/lib/ai/embeddings/types.ts`, under the seam's `MAX_EMBED_BATCH` of 64) and **keeps the seam's 15 s deadline** (`TEI_DEADLINE_MS`). A source with more chunks than that is embedded in several calls | owner, 2026-11-15 | `tei-embed` timed on the production VM (`VM check` `tei-embed-timing`, run 43757070861; [`nemotron-retriever.md`](./nemotron-retriever.md) 0.5a): 512-token passages cost about 0.7 s each whatever the batch size, so a batch buys no throughput. 8 took 5.20 / 5.71 / 6.03 s (min / median / max), 16 took 10.76 / 11.40 / 11.79 s, and 32 and 64 were over 15 s in every run (21.30 s and 41.81 s at best). 8 leaves the deadline about 2.5 times the slowest run, headroom for the request path's query embeddings, which share the container's one CPU with the job |

**Prompt.**
```text
Context (main 3.365.0 + Phase 1): KnowledgeChunk (text encrypted) and KnowledgeChunkEmbedding
(pgvector, RLS) exist; VectorRepository.ts is the only seam to the embedding column. Background
jobs live in src/app-layer/jobs/ and wrap in runJob(); the executor registry is
executor-registry.ts. Soft-deletes and hard-deleted sources are purged by data-lifecycle; the
tenant purge removes tenant-scoped tables.

Task: (1) Job `knowledge-index` keyed (tenantId, sourceModel, sourceId): read under
runInTenantContext, chunk, embed via the EmbeddingProvider seam (nemotron-retriever Phase 1;
use its stub if it has not landed) in calls of INDEX_EMBED_BATCH passages (8, owner,
2026-11-15), upsert chunks and embeddings by contentHash. (2) Enqueue
from the audit emitters of PolicyVersion (approved only) and evidence file text; delete a
source's chunks in the data-lifecycle purge. (3) scripts/knowledge-reindex.ts rebuilding a
tenant's embeddings from KnowledgeChunk, exercised by a test. (4) The embedding column's row
in docs/encryption-data-protection.md.

Constraints: the job never runs on the web tier; a chunk of an encrypted source is itself an
encrypted column; every findMany bounded (take:) or carrying the guardrail-allow comment.
Two-tenant test for the job: indexing A's policy creates nothing B can query.

Done when: the reindex test proves rebuild, the index-coverage, query-shape and
sanitize-rich-text-coverage ratchets are green, and a policy approved in a seeded tenant is
chunked and embedded within one job run.
```

**Hardening.** G7 (RLS on both tables), G8 (worker only, `runJob`, resumable).
G4 is not yet in play: nothing reads from the index into a model in this phase,
by design. The encryption-manifest entry for `KnowledgeChunk.text` is the most
important line in the diff, and the data-protection row for the embedding is
the most important sentence: one is the protection, the other is the honest
account of what it does not cover.

**Done when.** A policy approved in a tenant appears as chunks and embeddings
within one job run; purging the tenant leaves no row; the reindex test is
green.

### Phase 3 — The query path (read side), guarded, and the floors measured

**Goal.** Nearest-neighbour search is a read tool like any other: offered
through the allowlist and ceiling, executed through the funnel, its results
scanned on the way into model context, and evaluated before it is offered at
all. The same record measures the floors that decide whether Phase 4 ever runs.

**Sub-phases.**
- [x] 3.1 `VectorRepository.search(ctx, query, { k })` — cosine over the
      current model's partial index, tenant rows only, returns chunk
      references and scores; text is hydrated through the normal repositories
      under RLS (decrypting via the manifest). *Landed 2026-11-16:* the
      search existed since Phase 1; the hydration is the read usecase
      `searchKnowledge` (`KnowledgeChunkRepository.findByKeys` for the text,
      `KNOWLEDGE_CITATIONS` for the policy it cites), which drops a hit whose
      chunk text no longer hashes to the vector's `contentHash`.
- [x] 3.2 **Filtered search must not lose recall.** HNSW returns its
      `ef_search` nearest candidates across the whole table and RLS then
      removes other tenants' rows, so a small tenant in a large table can get
      fewer than `k` results or none. The search sets `hnsw.iterative_scan =
      relaxed_order` (pgvector 0.8) with a bounded `hnsw.max_scan_tuples`, and
      below a per-tenant row count it takes an exact scan instead of the
      index. The recall measurement in 3.6 is what proves this works.
      *Landed 2026-11-16:* exact at or below `EXACT_SCAN_MAX_ROWS` (2,000);
      `relaxed_order` with `max_scan_tuples` 20,000 above it; an exact
      fallback when the index returns fewer than `k` for a tenant of at most
      50,000 vectors. The threshold is a tuning value, not a decision, and 3.6's
      figures are what will move it. `tests/integration/vector-filtered-search-recall.test.ts`
      is the small-tenant case: it first shows the index starving a 24-vector
      tenant beside a 2,400-vector one with iterative scans off, then `k`
      results on the default path, through the index with them on, and for
      the large tenant.
- [x] 3.3 An MCP read tool `search_knowledge` in `src/lib/mcp/tools/`, so Flue,
      the Tool Runner and external MCP clients all reach it through
      `runGuardedTool → runReadTool` (G3), subject to the agent's allowlist and
      ceiling, with `resourceScope` set and `k` bounded (at most 20).
      *Landed 2026-11-16* as `knowledge-tools.ts` over the read usecase
      `searchKnowledge` (the house rule for read tools, which
      `tests/guardrails/mcp-read-suite-coverage.test.ts` holds: the tool calls
      one usecase, imports no repository and holds no permission check; the
      usecase applies the source's own read policy). `policies:read` and
      `policies.view`, because approved policy text is the only source; a
      row rule drops a hit from any source the tool cannot authorise.
      `tests/integration/knowledge-search-tool.test.ts` runs it through the
      real `/api/mcp` route: two tenants whose policies say the same thing in
      different numbers, and each sees only its own passages.
- [x] 3.4 The assistant offers the same tool from `assistant/tools.ts`; result
      text passes `guardUntrustedInput` before entering context and
      `guardEgress` before leaving to an external provider (G4) — the existing
      three-slice sandwich in `tools-adapter.ts` applies unchanged because the
      tool is a read tool. *Landed 2026-11-16* with no change to
      `assistant/tools.ts`: it offers what `loadableReadTools` offers, which
      now includes the tool while the gate is open.
      `tests/unit/knowledge-search-tool.test.ts` shows it offered to a reader
      and not to a role without `policies.view`, and a poisoned passage
      tripping the review latch so the next call on either surface is
      refused before the funnel.
- [x] 3.5 The mount gate: `search_knowledge` is offered only when a RAG
      evaluation record ([`ragas.md`](./ragas.md), G11) exists for the current
      retriever revision `{embeddingModel, dimensions, rerankModel, chunker, k,
      indexParams}` and passes its floors — the same shape as the skills mount
      gate in `flue/skills/mount-gate.ts`. Reranking
      ([`nemotron-retriever.md`](./nemotron-retriever.md) Phase 2) changes the
      revision key and so forces a new record. *Landed 2026-11-16* as
      `services/knowledge-search-mount.ts`, the PII gate's shape
      (`src/lib/ai/pii/mount.ts`): ABSENT while the store or the embedding
      route is off; otherwise the NEWEST record under `evals/rag/records/`
      whose `retrieverRevision` keys equal to `knowledgeRetrieverRevision(route)`
      decides, checked by Ragas Phase 0's own `checkRagEvaluationRecord`
      against the AUTHORED set it hashes to and the cost meter's price table
      and share, refused when a budget stopped it, and held to D-L4-9's two
      floors (recall@10 at least 0.95 of exact, p95 at most 300 ms). The owner
      decided on 2026-11-16 that the Weaviate trigger's values also gate the
      tool; they are written once, in `src/lib/ai/evals/rag-retrieval-floors.ts`,
      and the gate reads a record's figures through `readRetrievalFloors`, as
      the Ragas nightly does (`tests/unit/rag-eval-gate-agreement.test.ts`
      holds the two verdicts equal). Ragas Phase 2.1's answer-quality floors
      join the gate when Phase 2 defines them; until then the retrieval floors
      are the only ones it checks. Closed, the tool is in no catalogue (`src/lib/mcp/mount-gated-tools.ts`)
      and a call to it is an unknown tool; while the store and route are on, a
      run that would have been offered it records `RETRIEVER_NOT_EVALUATED`,
      and its empty-catalogue message says so
      (`src/lib/agentic/knowledge-search-not-evaluated.ts`). The runtime image
      copies the three directories the gate reads. The retriever revision key
      (`src/lib/ai/embeddings/revision.ts`) is now the record's own
      `{embeddingModel, dimensions, rerankModel, chunker, k, indexParams}`,
      with no `alpha`.
- [ ] 3.6 **The Weaviate trigger, measured.** The nightly record also carries
      two retrieval figures, computed by the harness on the seed corpus scaled
      to a stated multiple of the largest tenant's chunk count: recall@10 of the
      indexed, RLS-filtered query against an exact scan of the same tenant, and
      p95 latency of `search` at `k = 10`. Floors (D-L4-9, decided 2026-11-12):
      recall@10 at least 0.95 of exact, p95 at most 300 ms on the VM. A miss on
      two consecutive nightly records, after the tuning in 3.2, is the trigger
      for Phase 4; one miss is a tuning task. *Partly done 2026-11-16, and
      what is true today:* **the figures are produced** — the Ragas nightly
      (`rag-eval.yml`) measures both every night it runs, on a probe tenant of
      5,000 chunks in an index of 4 times that (the scale the owner decided
      on 2026-11-16, re-sized once production's largest tenant is indexed),
      on the product's own call — the 20-deep, source-filtered query
      `searchKnowledge` issues (`knowledgeVectorQuery`), through
      `VectorRepository.search` pinned to the index path (`strategy: 'index'`,
      `HNSW_SEARCH`); recall over its first 10 against the exact top 10 the
      stage computes under the same filter, latency the p95 of the whole
      20-deep call (D-L4-9 as amended 2026-11-16). Recall is tie-aware
      (amendment (f)): an indexed hit counts when its distance is at most
      the exact 10th-best distance plus 1e-6, recall = hits / min(10, exact
      count), and a question whose exact search is empty is unscored, never 1; **the record/gate path is wired** — its output is keyed by
      `knowledgeRetrieverRevision`, the revision this gate compares, and read
      against the same floors; **the answers are produced** (2026-11-16) —
      the nightly's answer stage asks the real assistant in process, with
      `search_knowledge` mounted for its answer tenant alone by the
      evaluation's scoped decision, which nothing under `src/` can open and a
      production process refuses (Ragas 1.2). **No record exists yet**: no
      keyed night has run, so the gate stays closed until a record from one is
      committed by a reviewed pull request. The latency a CI runner measures is
      not the VM's, which D-L4-9 states its ceiling for.

**Prompt.**
```text
Context (main 3.365.0 + Phases 1–2): every engine's tool call goes through runGuardedTool →
runReadTool / runProposeTool (src/lib/agentic/engine-tools/); MCP read tools live in
src/lib/mcp/tools/ with name, description, inputSchema, resourceScope; the assistant's tools
are in src/app-layer/ai/assistant/tools.ts; tool results are scanned by guardUntrustedInput
and guardEgress in flue/tools-adapter.ts. Skills are mounted only with an evaluation record
(flue/skills/mount-gate.ts). KnowledgeChunk + KnowledgeChunkEmbedding (pgvector, RLS) exist.

Task: (1) VectorRepository.search(ctx, query, {k}) — cosine over the current model's partial
HNSW index with hnsw.iterative_scan = relaxed_order and a bounded max_scan_tuples, an exact
scan below a per-tenant row threshold, tenant rows only; returns {chunkId, sourceModel,
sourceId, chunkIndex, score}; text hydrated via the existing repositories under RLS. (2) A
read tool `search_knowledge` in src/lib/mcp/tools/ (resourceScope set, argsSchema validated,
k ≤ 20). (3) Offer it from the assistant's tool list. (4) A mount gate: offered only when a
RAG evaluation record for the current retriever revision exists and passes floors; without
one the tool is absent and the run message says so (see flue/empty-toolset-message.ts).
(5) The record carries recall@10 (indexed vs exact, under RLS) and p95 latency at k = 10.

Constraints: no permission check, usecase or Prisma call inside the tool module — the funnel
decides. Results are untrusted input. Tests: B's chunks never appear in A's results through
the tool; a small tenant beside a large one still gets k results; a flagged result halts the
step (reuse the review latch); the tool module imports nothing from repositories except
VectorRepository. Update docs/sub-processors.md's Anthropic/OpenRouter rows' "data shared" to
include retrieved chunk text when the tenant's residency is EXTERNAL.

Done when: the tool appears on /agents/[agentId] Tools tab for an agent granted it, the
two-tenant, small-tenant and halt tests are green, and the mount gate refuses with no record.
```

**Hardening.** G3 (funnel only), G4 (three slices, unchanged), G2 (the
sub-processor rows gain a data category: retrieved chunk text leaves to the
model vendor for EXTERNAL tenants), G11 (no record, no tool), G7 (the
two-tenant test at the tool layer, not only the repository layer). Bound `k`;
an unbounded retrieval is the N+1 of RAG. The small-tenant test is the one that
catches the filtered-search failure, which no two-tenant test of equal-sized
tenants can see.

**Done when.** A seeded tenant's agent, granted `search_knowledge`, answers a
posture question with cited chunks; the same question under a second tenant
cites none of them; the nightly Ragas job has produced the record the gate
consumed, with the two floor figures in it.

### Phase 4 — Weaviate, only if a floor is missed (conditional)

**Trigger.** Phase 3.6's floor missed on two consecutive nightly records after
tuning. Without the trigger this phase does not start, and the roadmap is
complete at Phase 3.

**Goal.** A second backend behind the same `VectorRepository` interface,
serving the queries pgvector could not, with Postgres still the system of
record and every rule above unchanged.

**Sub-phases.**
- [ ] 4.1 A measured memo (implementation note): the two missed records, the
      tuning tried, Weaviate's figures on the same harness, the capacity line
      and D-CAP-1's answer. The owner initials adoption in the master's
      decision table before any code lands.
- [ ] 4.2 A `weaviate` service, digest-pinned, no modules (`ENABLE_MODULES`
      empty, `vectorizer: none`), API-key auth, a named volume, no published
      port; `WEAVIATE_URL` / `WEAVIATE_API_KEY` optional in `src/env.ts`
      (absent = the pgvector backend serves). Native multi-tenancy, one shard
      per tenant, `autoTenantCreation: false`.
- [ ] 4.3 Vectors only, still: objects carry the chunk reference, the model id,
      the `contentHash` and the vector, no text property — so no BM25 there
      either. The shard is rebuilt from `KnowledgeChunkEmbedding` rows (no
      re-embedding), which keeps "losing Weaviate loses nothing" true by
      construction.
- [ ] 4.4 Tenant lifecycle: the shard is created on first index and deleted by
      the tenant purge, both idempotent and audited, because Weaviate is
      outside the purge's reach otherwise.
- [ ] 4.5 The two-tenant test again, at the shard: A inserts, B sees nothing,
      A's object id under B returns nothing, purging A removes the shard.
      Here isolation is application code alone, so this test carries the
      whole argument.

**Hardening.** G5, G6 (operator-set URL only; the client is the only socket),
G7 (the shard test), G9 (absent config = pgvector). The memo comes first
because adopting a second store is a decision, not a tuning step.

**Done when.** The memo is initialled, the shard two-tenant test is green, and
the mount gate's record for the Weaviate-backed revision meets the floor that
pgvector missed.

## Evals for this framework

| What | How | Record |
| --- | --- | --- |
| Isolation | two-tenant behavioural tests at repository, job and tool layers (Phases 1–3), plus the small-tenant recall test | CI integration and `test` shards |
| Retrieval quality | context precision / recall over the seed corpus — [`ragas.md`](./ragas.md); calibrated judges later — [`ares.md`](./ares.md) | evaluation record in the house shape (G11), consumed by the Phase 3 mount gate |
| The Weaviate trigger | recall@10 indexed vs exact under RLS, p95 latency at `k = 10` (Phase 3.6) | the same nightly record |
| Rebuildability | `knowledge-reindex` reproduces the embeddings (Phase 2.3) | CI |
| Operational | `vector_index.requests{outcome}` metric; latency histogram | alerts, not readyz |

## Updating the master

When a phase lands: flip this framework's row in the master
[Status board](../ai-architecture-roadmap.md#status-board), link the PR, and
move any fact that changed in **Current state** above into the present tense in
the same pull request. The row's name follows the decision: "Vector store
(pgvector; Weaviate conditional)". The capacity budget's "Vectors" line moves
inside `postgres` (no new container) until Phase 4 is triggered. A phase that
changes a decision (D-L4-1, D-L4-2) is recorded in the master's decision table
before the code merges.
