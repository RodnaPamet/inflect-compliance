# Knowledge store

The knowledge store holds a tenant's indexable text as embedded paragraph
chunks, in Postgres with pgvector, and serves similarity search to agents and
the assistant through one read tool, `search_knowledge`. Today it indexes one
source: the text of **approved policy versions**. The phased design, and what
comes after it, is in `docs/ai-architecture/weaviate.md` and
`docs/ai-architecture/nemotron-retriever.md`; this page describes what is
built.

The store is **off by default** and does nothing until a deployment turns on
both of its switches: `VECTOR_STORE_BACKEND=pgvector`, and an embedding route,
`AI_EMBED_LOCAL_BASE_URL` with `AI_EMBED_LOCAL_MODEL` and
`AI_EMBED_LOCAL_DIMENSIONS`. Either missing is a named refusal that reads and
writes nothing; it is never an empty result.

## Tables

`prisma/schema/knowledge.prisma`, migration
`20261115190000_knowledge_vector_store`:

| Model | Holds |
|---|---|
| `KnowledgeChunk` | One paragraph of one source row: `(sourceModel, sourceId, chunkIndex)`, the chunk's text (encrypted at rest through the Epic B manifest), its content hash and the chunker revision |
| `KnowledgeChunkEmbedding` | One embedding model's vector of one chunk: the model, its dimensions, the chunk's content hash and the vector. Never text |

Both tables are tenant-scoped under row-level security, as every tenant table
is ([row-level security](./rls-tenant-isolation.md)), and every statement also
filters on `tenantId`. The `embedding` column is the untyped `vector`, so one
table holds every model; each model has a partial HNSW index over its own cast
(`vector_cosine_ops`). Only `src/app-layer/repositories/vector/pgvector-store.ts`
names the embedding table (ESLint `local/vector-store-single-seam`), and it
probes for the extension (0.8.0 or later) and the table before its first
statement, refusing `PGVECTOR_NOT_INSTALLED` when either is missing. Every
Postgres in the deployment runs the `postgres-pgvector` image.

## Indexing

The `knowledge-index` job indexes one source row
(`src/app-layer/services/knowledge-index.ts`); it is the only writer of chunks
and vectors outside tests. In one transaction under the tenant's RLS context it
reads the row through its source reader (`knowledge-sources.ts`), cuts it into
paragraphs (`paragraph@1`, `src/lib/knowledge/paragraph-chunker.ts`) and makes
the stored chunks exactly those. It then embeds only the chunks whose vector for
this model is missing or was computed from other text, eight at a time, and
upserts each batch as it returns.

- **Idempotent.** A second run over an unchanged source embeds and writes
  nothing (`UNCHANGED`); a run interrupted between batches leaves what it
  finished, and the next run embeds the rest.
- **Deletes follow the source.** A position the source no longer has is
  deleted, a changed position is replaced (its vectors go by cascade), and a row
  that is no longer indexable — gone, unapproved, soft-deleted — loses all its
  chunks.
- **Every run has one named outcome**, counted on `knowledge_index.runs`; none
  of the refusals reads as success.

Approving a policy version enqueues the job for it, and soft-deleting a policy
enqueues it for the policy's versions, so their chunks leave the index then
rather than at the 90-day purge. Because a chunk names its source
polymorphically, no foreign key removes it with the source: the `data-lifecycle`
purge and the admin's manual purge call `knowledge-purge.ts` before they
hard-delete a row, and the tenant purge removes both tables with everything
else.

`scripts/knowledge-reindex.ts --tenant=<slug-or-id>` rebuilds one tenant's
vectors from its stored chunk text (`reindexTenantKnowledge`). It is also how a
new embedding model is introduced: configure the model, run the script per
tenant, and the old model's rows are left as they are.

## Search: `search_knowledge`

`search_knowledge` is an MCP read tool (`src/lib/mcp/tools/knowledge-tools.ts`)
behind the usecase `searchKnowledge`. It embeds the question on the same route,
searches this tenant's vectors by cosine similarity, and returns up to `limit`
passages (default 5, at most 20), each with its score and the policy it cites.
It searches only the source models the caller may read under that source's own
read policy, so a source the caller cannot read never crowds out the hits it
can. A hit is dropped when its chunk no longer reads, when its text no longer
hashes to what its vector was computed from, or when its source has no citation.

The text it returns is tenant-authored and untrusted. Every engine reaches the
tool through `runGuardedTool`, which scans the result with the input and egress
guards before the model sees it, and a flagged result latches the run's review.

**The tool is offered only when an evaluation record vouches for the retriever**
(`src/app-layer/services/knowledge-search-mount.ts`):

| State | When | Effect |
|---|---|---|
| `ABSENT` | The store or the embedding route is off | Nothing is offered or read |
| `UNMOUNTED` | Both are on, and no committed RAG evaluation record for this retriever revision passes | The tool is absent from every catalogue, and a run that would have been offered it records `RETRIEVER_NOT_EVALUATED` |
| `MOUNTED` | The newest record for this revision passes | The tool is offered |

A record lives in `evals/rag/records/` and answers an authored set in
`evals/rag/sets/`. Its retrieval figures are recomputed from each case's raw
probe and held to the floors in `src/lib/ai/evals/rag-retrieval-floors.ts` —
recall@10 at least 0.95 of an exact scan, p95 latency at most 300 ms at k = 10
(owner decisions D-L4-9, 2026-11-12, and 2026-11-16) — the same floors the Ragas
nightly reads. The newest record decides, passing or not. The repository holds no record
today, so on a deployment with both switches on the tool is `UNMOUNTED`.
