# 2026-11-16 — Tie-aware recall@10 for the retrieval floor

**Commit:** `feat(evals): recall@10 counts ties at the exact 10th-best distance as hits`

Follows #5755 (`2026-11-16-rag-eval-gate-wiring.md`), whose "Ties at the 10th
place" decision recorded identity-matched recall reading 0.95 on exact-vs-exact
plans. The owner decided the same day that ties count as hits (D-L4-9 amended
(f)); this supersedes that bullet.

## Design

```
probe.ts ── each hit: { sourceModel, sourceKey, chunkIndex, distance = 1 - score }
              │  (ann: first 10 of the product's 20-deep call; exact: the exact top 10)
              ▼
rag-record.ts recallAgainstExact(ann, exact)
   exact empty                  → null (unscored; left out of the mean; never 1)
   every hit states a distance  → hits = |{ a in ann[0..10) : a.distance ≤ max(exact[0..10).distance) + 1e-6 }|
                                  recall = min(hits, n) / n,  n = min(10, |exact|)
   otherwise                    → identity: |ann ∩ exact| / n   (can only read lower)
```

The store's inner query orders by distance alone before its outer tie-break,
so chunks tied on distance across the 10th place can be different members of
the tie at depth 20 and at depth 10. Scoring by identity counted that as a
miss; scoring by distance does not, and a chunk farther than the exact
10th-best is still a miss wherever it ranks.

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/evals/rag-record.ts` | `ProbeRef` (optional `distance`, all or none per probe), tie-aware `recallAgainstExact`, `RECALL_TIE_EPSILON` |
| `scripts/rag-eval/probe.ts` | `toChunkRefs` states each hit's cosine distance |
| `scripts/rag-eval/check.ts` | The summary row says tie-aware |
| `src/lib/ai/evals/rag-retrieval-floors.ts` | The docblock states the rule |
| `tests/unit/rag-evaluation-record.test.ts` | A boundary tie is a hit; a farther chunk is a miss; hits / min(10, n); empty is unscored; mixed distances refused |
| `tests/integration/rag-eval-retrieval-probe.test.ts` | Exact-vs-exact reads recall 1 again, every hit carrying a distance |
| `docs/ai-architecture-roadmap.md`, `weaviate.md`, `ragas.md` | D-L4-9 (f), 3.6, the current state |

## Decisions

- **The distance is on the record, not decided by the probe.** The gate
  recomputes recall from a record's raw values; a probe that resolved ties
  itself would hand the gate a list it cannot check. So each probe hit states
  its distance, as raw as the lists, and the rule lives in
  `recallAgainstExact`, the function the nightly and the gate both read.
- **Optional, all or none.** No record is committed yet, but the Python
  harness's fixtures and any probe written before this carry no distance. A
  probe without distances is scored by identity, which can only read lower
  than tie-aware scoring, so a missing distance never passes a floor that a
  stated one would not. A probe stating distances for some hits only is
  refused by the schema.
- **The 10th-best distance is the largest in the exact top 10**, not the
  distance at index 9, so the rule does not depend on the list arriving
  sorted.
- **Epsilon 1e-6 on cosine distance.** The store reports a similarity computed
  as `1 - distance` in SQL; the probe recovers the distance as `1 - score`.
  Two computations of one float differ by about 1e-16; 1e-6 is float noise
  with room to spare, and far below any distance difference two different
  chunks show under the deployment's model.
- **Empty exact list: unchanged.** `recallAgainstExact` already returned null
  for it, `retrievalFloorFigures` leaves a null case out of the mean, and a run
  with no scored case has `recallAt10VsExact: null`, which the gate refuses as
  `RECALL_NOT_MEASURED`. Zero is never complete.
- **Hits are capped at n.** With the same tenant and filter the ANN arm cannot
  return more than the exact arm's count, but the cap keeps recall at most 1
  whatever a record states.
