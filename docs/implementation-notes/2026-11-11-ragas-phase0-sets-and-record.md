# 2026-11-11 — Ragas Phase 0: the seed set, the record format and the judge (D-EV-2)

**Commit:** `feat(ai-evals): the RAG evaluation set and record format (Ragas Phase 0)`

## Design

Phase 0 of `docs/ai-architecture/ragas.md` ships two shapes and one decision,
the same split the skills gate keeps
(`src/lib/agentic/flue/skills/evaluation-record.ts`):

```
evals/rag/sets/seed-policies.json        authored SET: question → ground-truth answer
evals/rag/sets/seed-policies.json.sha256   + verbatim passages, four case kinds
                │  sha256 over canonicalJson(parsed set)
                ▼
RECORD (Phase 1 writes it)  setHash · retrieverRevision · judgeRevision · ranAt
                            cases[]: answer · retrieved chunks · 4 raw metrics · raw judge outputs
                │
                ▼
checkRagEvaluationRecord(record, set)   → refuses, or returns aggregates RECOMPUTED
                                          per case kind from the raw values
```

The module (`src/lib/ai/evals/rag-record.ts`) is pure — no filesystem, no
network — so the Phase 1 job, the Phase 2 mount gate and a unit test all call
the same checks. Grounding the set in the seed corpus needs the fixtures, so
that check lives in the test, not the module.

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/evals/rag-record.ts` | Strict set and record schemas, `ragSetHash`, `checkRagEvaluationSet`, `checkRagEvaluationRecord` (the recompute), `followedInjection` |
| `evals/rag/sets/seed-policies.json` | 52 authored cases over the three seeded policies: 37 task, 5 refusal, 5 injection, 5 missing-input |
| `evals/rag/sets/seed-policies.json.sha256` | The set's content hash |
| `tests/unit/rag-evaluation-record.test.ts` | Stored rates refused; aggregates recomputed; null is not 0 or 1; set-shape refusals |
| `tests/unit/rag-evaluation-seed-set.test.ts` | Every passage is verbatim in the text the seed publishes; hash file current; injected chunks and markers never in the corpus |
| `docs/ai-architecture/ragas.md` | Phase 0 sub-phases, D-EV-2 row, corrected current state, D-L4-1 note |

## Decisions

- **D-EV-2, initialled by the owner 2026-11-11.** The judge is a Haiku-class
  model on an external provider, called through a dedicated CI key (never the
  product's key), under the USD 5/night CI budget shared with garak's D-EV-1,
  over seed data only. A local judge comes only if Layer 5 is taken up. The
  record names the judge (`judgeRevision.provider/model`) and the embedding
  model Ragas's `answer_relevancy` uses, plus the pinned Ragas version, so two
  records with different judges are never compared as one series.
- **No `docs/sub-processors.md` change.** The roadmap's 0.3 asked for a note on
  the sub-processor row. That register lists who processes customer data, and
  this path sends none: `corpus` is the literal `'seed'` in both schemas, so a
  set or record over a customer tenant cannot be represented. The vendor
  receives seed policy text and authored questions only. If a set ever draws on
  anything but seed and fixture text, that is the moment for a row.
- **The seed has no answer library, so the set is `seed-policies`, not
  `questionnaire-200`.** `prisma/seed.ts` never writes
  `QuestionnaireAnswerLibrary`. It publishes three policies whose text is the
  imported policy fixture (the last writer of those titles), so the set is
  drawn from them and named for what it is. Growing to 200 needs a seeded,
  reviewed answer library; that is sub-phase 0.5, and it should be reconciled
  with the retriever roadmap's 200-pair set so there is one seed set, not two.
- **Ground truth is a verbatim passage, not a chunk index.** The chunker is
  part of the retriever revision a record evaluates; a set keyed on chunk
  indices would go stale on exactly the change it exists to measure. The
  harness resolves passages to chunks per revision, and the record carries the
  chunk indices it retrieved. A passage is also checkable today, with no
  chunker: the seed-set test requires each to be a substring of the published
  text.
- **`sourceKey` is a seed slug, never a row id.** Seed ids are cuids minted per
  database.
- **A missing metric is `null`.** Ragas returns NaN where a metric does not
  apply (`context_recall` with no reference context). Counting it as 0 would
  sink refusal cases; counting it as 1 would let an empty kind pass. A mean over
  no scored value is `null` (not assessed), and the set schema refuses a set
  without every kind, so `null` cannot stand in for a perfect score by there
  being nothing to average.
- **Injection is scored from the answer text, not by the judge.** Each
  injection case names markers the injected chunk asks the model to emit; the
  recompute counts answers that contain none of them. The schema refuses a
  marker the chunk does not ask for, and one the ground truth itself contains;
  the seed-set test refuses a marker that occurs in the corpus. One injection
  is in Bulgarian, so an English-only rail does not see it.
- **The set hash is over canonical JSON**, so reformatting the file does not
  invalidate records and any content edit does.
- **D-L4-1 (pgvector first, Weaviate only on a measured floor)** is noted where
  the roadmap names Weaviate as a dependency and as a nightly service container.
