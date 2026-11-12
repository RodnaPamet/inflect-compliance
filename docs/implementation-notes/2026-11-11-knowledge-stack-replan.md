# 2026-11-11 — Knowledge stack re-planned for the owner's Layer 4 and eval decisions

**Branch:** `wf/knowledge-replan` (documentation only; no code, no dependency)

## Design

The owner took six decisions on 2026-11-11 that move four child roadmaps of
`docs/ai-architecture-roadmap.md`:

| Id | Decision | Child rewritten |
| --- | --- | --- |
| D-L4-1 | pgvector first, in the existing Postgres under RLS; Weaviate only later, on a measured recall/latency floor | `docs/ai-architecture/weaviate.md` |
| D-L4-2 | Vectors-only: no chunk text outside Postgres | `weaviate.md`, `ragflow.md` |
| D-L4-4 | A parsing-only service of the Docling class (MIT) is the default parser; RAGFlow measured only, adopted only if Docling fails the fidelity eval | `docs/ai-architecture/ragflow.md` |
| D-EV-1 | Garak's probes are answered by a Haiku-class external model, dedicated CI key, USD 5 a night hard cap, seed/fixture data only | `docs/ai-architecture/garak.md` |
| D-EV-2 | Ragas's judge: the same model class, key rule, cap and data rule | `docs/ai-architecture/ragas.md` |

Both Layer 4 files keep their filenames for link stability (the `langflow.md`
precedent) and are retitled for what they now plan. The vector-store roadmap is
complete at Phase 3 (pgvector: image and extension, models and seam with RLS
and a two-tenant test, the index job rebuildable from Postgres, the guarded
`search_knowledge` tool behind the Ragas mount gate). Weaviate is Phase 4,
slate-dashed, and starts only when Phase 3's own nightly record misses a floor
twice after tuning.

## Facts checked against the repository and upstream

- **The Postgres image cannot load pgvector.** Every Postgres the repository
  runs is `postgres:16-alpine` (the production Compose file, four root Compose
  files, five workflows' service containers). The official `16/alpine3.23`
  Dockerfile builds the server and `contrib` only. `CREATE EXTENSION vector`
  therefore fails in production, in CI and locally today.
- **pgvector is not a trusted extension.** Its `vector.control` (0.8.7) has no
  `trusted = true`, unlike `pg_trgm`, the one extension a migration creates
  today. The role running `prisma migrate deploy` must be a superuser, or the
  operator creates the extension once beforehand.
- **The ready-made images are Debian.** `pgvector/pgvector:0.8.7-pg16`
  (`-bookworm`, `-trixie`) is `FROM postgres:16-<debian>`. Pointing the
  existing Alpine-initialised volume at it changes the C library that orders
  text (musl to glibc), so text indexes need a rebuild. The plan builds
  pgvector onto the same Alpine base instead (`deploy/postgres/Dockerfile`),
  and keeps the Debian image as a fallback that carries a reindex window in
  its rollback plan. Docker Hub sizes, read the same day: about 156 MB
  compressed for the pgvector Debian tag against about 116 MB for
  `postgres:16-alpine`.
- **Capacity.** pgvector adds no container. Its cost is inside `postgres`:
  heap and index pages (roughly 4 bytes per dimension per chunk for the
  vector, about the same again for the HNSW index), and
  `maintenance_work_mem` during an index build. The master's "Vectors · 1.5 GB
  · weaviate" capacity line becomes an in-`postgres` line, measured in C0 with
  the rest of `postgres`; the 1.5 GB line returns only if Phase 4 is
  triggered.
- **`docling-serve`** (MIT) ships a CPU image of about 4.4 GB with the model
  weights inside, listens on 5001, takes `DOCLING_SERVE_API_KEY`, and has
  single-use results with a removal delay, a configurable scratch path, and
  remote services off by default — the settings the "holds nothing" property
  is built on.
- **Haiku prices.** `claude-haiku-5-5` lists at USD 0.10 / 0.50 per million
  input / output tokens (prompts up to 100K tokens), `claude-haiku-4-5` (the
  product's `ANTHROPIC_MODEL` default) at USD 1 / 5.

## Decisions

- **The lexical arm is gone, and that is a finding, not a simplification.**
  The old plan promised hybrid BM25 + vector in Weaviate while keeping chunk
  text out of Weaviate; Weaviate's BM25 indexes text properties, so the two
  were never compatible. In Postgres the text is ciphertext, so `tsvector`
  over it is impossible without a plaintext derivative. Phase 3 is dense-only
  and the retriever revision key drops `alpha`. Whether to add a lexical arm
  (none, a keyed blind-token index, or a plaintext `tsvector`) is put to the
  owner in `weaviate.md` § Fit.
- **The embedding column is a plaintext derivative of encrypted text.** ANN
  needs plaintext floats. The plan says so and adds a row to
  `docs/encryption-data-protection.md` in Phase 2 rather than leaving the gap
  for an auditor to find.
- **Filtered ANN under RLS is the real pgvector risk.** HNSW returns its
  candidates across tenants and RLS filters afterwards, so a small tenant beside
  a large one can lose recall. Phase 3 uses pgvector 0.8's iterative scan, an
  exact scan below a per-tenant size, and a small-tenant test; the Weaviate
  trigger measures exactly this (recall@10 against exact search under RLS, and
  p95 latency). The floor values (0.95, 300 ms) are proposals for the owner to
  confirm.
- **Floors before measurements for the parser.** "RAGFlow only if Docling
  fails the fidelity eval" is only checkable if the floors are committed before
  either backend runs; the Phase 0 done-when requires that commit order.
- **"Hard-capped" is enforced before the call.** The shared cost meter refuses
  a call whose counted input plus `max_tokens`, at list price, would pass the
  job's share; a stopped run is `BUDGET_EXHAUSTED` and never a pass. The
  vendor's workspace spend limit is monthly and is only a backstop.
- **One cap for both jobs, until the owner says otherwise.** D-EV-1 and D-EV-2
  name the same key class and the same USD 5. The conservative reading — USD 5
  a night in total, USD 2.50 per job by default — cannot exceed the owner's
  intent under either reading; it is flagged as an open question in both
  children.
- **The cap rules out `claude-haiku-4-5` for the full Ragas set.** Estimated
  at about 2,800 judge calls a night, the 200-case set costs about USD 1.30 on
  `claude-haiku-5-5` and about USD 13 on `claude-haiku-4-5`. The CI key runs
  the current Haiku, or the set is sampled.
- **Not edited here:** the master roadmap (the coordinator's), and
  `nemotron-retriever.md`, `ares.md` and `langfuse.md`, which still mention
  Weaviate as the store; their lines follow in their own passes.
