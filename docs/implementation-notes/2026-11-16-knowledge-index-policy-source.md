# 2026-11-16 — Approved policy versions enter and leave the knowledge index (vector store 2.2, 2.5)

**Commit:** `feat(knowledge): approved policy versions are indexed, and leave the index with their policy (vector store 2.2, 2.5)`

Roadmap: [`docs/ai-architecture/weaviate.md`](../ai-architecture/weaviate.md)
Phase 2. Stacks on the job
([`2026-11-16-knowledge-index-job.md`](2026-11-16-knowledge-index-job.md)).

## Design

```
decidePolicyApproval(APPROVED) ── commit ──▶ enqueueKnowledgeIndex(PolicyVersion, version)
deletePolicy / bulkDeletePolicy ── commit ──▶ enqueueKnowledgeIndexForPolicies → each approved version
restorePolicy                   ── commit ──▶ enqueueKnowledgeIndexForPolicies   (job: PARENT_DELETED
                                                                                   removes / re-indexes)
data-lifecycle soft-delete purge ┐
purgeEntity (admin purge)        ┴─ deleteKnowledgeOfPurgedRow(model, tenant, id) ─▶ DELETE chunks
                                     (Policy → its versions' chunks)                    then DELETE row
tenant purge ── KnowledgeChunk, KnowledgeChunkEmbedding with every tenant table
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/policy.ts` | Queue after approval, soft delete, bulk soft delete, restore |
| `src/app-layer/jobs/knowledge-index-enqueue.ts` | `enqueueKnowledgeIndexForPolicies`: a policy's approved versions, read only while the index is on |
| `src/app-layer/services/knowledge-purge.ts` | Which chunks a hard delete orphans, per model, and the DELETE |
| `src/app-layer/jobs/data-lifecycle.ts`, `usecases/soft-delete-operations.ts` | Call it before the row's own DELETE |
| `docs/data-retention.md` | `KnowledgeChunk`'s retention row in the present tense |
| `tests/integration/knowledge-index-policy-source.test.ts` | Approval to index in one run, soft delete and restore, both purges, the tenant purge |

## Decisions

- **Queued from the usecase after the commit, not from the audit emitter.**
  The roadmap names the audit emitters; `logEvent` writes inside the
  transaction, so a job queued there could run before the commit (and read
  the unapproved version) or after a rollback. The usecase's own post-commit
  tail is where `bumpTenantCacheVersion` already runs.
- **A soft delete re-indexes rather than deleting chunks directly.** The job
  already removes the chunks of a version whose policy is soft-deleted
  (`PARENT_DELETED`), and a restore needs the job anyway. One path for both
  directions; the write never touches the index itself.
- **The purges delete chunks BEFORE the row.** A policy's versions cascade
  away with it, so after its DELETE nothing names them. Deleting first is
  harmless if the row's DELETE is then refused by a RESTRICT child: only
  soft-deleted rows are purged, and those are not indexable.
- **Raw SQL in the purge helper.** Both purge paths delete with
  `$executeRawUnsafe` to step around the soft-delete extension, and the
  data-lifecycle purge is handed an injectable client that carries only that
  method. Every value is a bound parameter; the SQL names the chunk table, and
  the vectors leave by cascade.
- **Evidence is left for the parser roadmap.** The `DocumentParser` seam's
  code is on `main`, but its service runs in a nightly window (ragflow 1.3,
  owner 2026-11-13) and a queued document must wait for it rather than be
  indexed from the stub; that wiring and its chunk-metadata migration are
  ragflow Phase 2. Control descriptions and the answer library follow evidence
  in the roadmap's order, so they wait too.
- **Failure to queue never fails the write.** Both enqueue helpers log and
  return; `scripts/knowledge-reindex.ts` rebuilds embeddings from stored
  chunks, and a re-approval or a manual run re-chunks a source.
