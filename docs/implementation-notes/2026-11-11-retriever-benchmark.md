# 2026-11-11 — The retriever benchmark that decides D-L4-3

**Commit:** `wf/retriever-benchmark` — feat(ai): the D-L4-3 retriever benchmark (seed set, scoring, dispatch-only workflow)

Owner decision D-L4-3 (2026-11-11): benchmark the Nemotron embed model against
a small open model and keep the smaller unless recall@10 drops past a margin.
This is the instrument for that comparison — `nemotron-retriever.md` Phase 0.3
(latency) and 0.4 (recall@10 on a 200-pair seed set, with and without the
reranker). It has not been run; nothing here is a figure.

## Design

```
prisma/seed.ts ─┐                         tests/fixtures/rag/retriever-seed-set.json
ciso-toolkit ───┴─ corpus.ts (chunker) ──▶ corpus (372 chunks, derived)
                                           cases  (200, hand-written, SYNTHETIC)
                                           contentHash = sha256(canonical set)
                                                │
 .github/workflows/retriever-benchmark.yml      ▼
  bench (matrix: one job per embed candidate, GitHub runner)
    Hub API: main → commit, model_type, files ─ teiCpuRefusal? ─▶ failure file ENGINE_REFUSES_ON_CPU
    TEI CPU @digest --revision <commit> on 127.0.0.1 ─ embed corpus + 200 queries ─ top-50 ─▶ record (embed only)
    for each reranker: TEI @digest ─ rerank top-50 ──────────────────────▶ record (embed + rerank)
    probes: query-20 / passage-512 / rerank-32 at batch 32, 3 warm-up + 20 timed
    a stage TEI cannot serve ─▶ failure file (stage, reason, engine log tail), never a record
  summary: download records + failures ─ scoreRecord (recompute) ─ decideD_L4_3 ─▶ step summary + artifact
```

A record is the set's id, version and hash, the pipeline (each model's
commit as resolved from the Hub and passed to TEI as `--revision`, the declared size, the query and passage
prefixes), the image digest, the runner's CPU, the ranked chunk ids per case,
the per-case stage times and the probe samples. Its `aggregates` block is a
convenience for a reader: `scoreRecord` recomputes it and refuses the record if
the two differ.

## Files

| File | Role |
| --- | --- |
| `scripts/retriever-benchmark/corpus.ts` | Reads the seed's policy texts and chunks them (one chunk per heading section, one per numbered policy statement, title prefixed). Throws rather than return fewer documents when a seed regex stops matching. |
| `scripts/retriever-benchmark/build-seed-set.ts` | Rebuilds the set's corpus and hash from the seed, keeping the hand-written cases; `--write` rewrites, default checks. |
| `tests/fixtures/rag/retriever-seed-set.json` | The set: 372 chunks, 200 cases, `sha256:6c1f7d25…a8d4`. |
| `scripts/retriever-benchmark/scoring.ts` | Pure: record shape, `setContentHash`, recall@K, MRR@K, nearest-rank percentile, `scoreRecord` (sixteen named refusals), `decideD_L4_3`. |
| `scripts/retriever-benchmark/candidates.ts` | TEI image digest, `teiCpuRefusal` (the model types that image refuses on CPU), embed and rerank candidates, rerank depth, the proposed margin, probe sizes. |
| `scripts/retriever-benchmark/hub.ts` | Resolves `main` (or a pinned commit) to a commit, the model type and the file list through the Hub API, before any engine starts. |
| `scripts/retriever-benchmark/run.ts` | `bench` (drives Docker and TEI) and `summarize`. |
| `.github/workflows/retriever-benchmark.yml` | Dispatch-only; `bench` matrix + `summary`. |
| `tests/unit/retriever-benchmark.test.ts` | The set, the scoring, the runner's loopback rule and the workflow's shape. |
| `tests/guardrails/ci-checks-unreachable-before-merge.json` | Two entries, `retriever-benchmark.yml:bench` and `:summary`. |
| `tests/guardrails/contended-json-format.test.ts` | The registry's key-order digest re-pinned. |

## Decisions

- **The corpus is derived from the seed, not copied.** G11 allows seed data
  only. The test re-derives the corpus through the same chunker and compares
  the committed file byte for byte, so "seed data only" is checked rather than
  asserted, and a seed policy edit fails CI until the set is rebuilt — moving
  the hash and retiring every record made against the old text.
- **The questions are synthetic and say so.** The seed holds no questionnaire
  answer-library rows (`prisma/seed.ts` writes none), so the "questions from
  the answer library" the roadmap names do not exist to draw on. The 200
  questions were written for this set in questionnaire style, mostly
  paraphrased rather than lexically copied, and the set's `provenance` opens
  with `SYNTHETIC.`. Fifteen cases name two or three chunks where seed
  policies genuinely overlap (encryption at rest appears in two policies);
  recall for those is the share found.
- **Distractors are deliberate.** 184 of 372 chunks answer no case, including
  the near-identical "Evidence to Retain", "Exceptions" and "Document Control"
  blocks every toolkit policy carries. A corpus of answers only would make
  every candidate look perfect.
- **One case kind.** G11's four kinds (task, refusal, injection,
  missing-input) describe a model that answers; a ranker returns ids and has
  no answer to refuse with. Every case is `task`. Injection resistance of
  retrieved text belongs to the tool boundary (G4), not to this ranking.
- **A record never names a branch, and the commit is resolved BEFORE the
  engine starts.** TEI cannot be asked which commit it loaded: its `/info`
  `model_sha` is the `--revision` argument echoed back (router/src/lib.rs at
  v1.9.4, `model_sha: revision`), so with no `--revision` it is null. The
  first version of this branch assumed otherwise and would have refused every
  record of the first dispatch as `REVISION_NOT_A_COMMIT` (review finding).
  So `hub.ts` asks the Hub API what `main` (or a pinned commit) is, TEI is
  started with `--revision <commit>` (`teiArgs` refuses to start it without
  one), and `revisionOf` refuses an `/info` that does not echo that commit.
  `scoreRecord` still refuses anything that is not a 40-character commit.
  Pinning each commit in `candidates.ts` after the first run is what makes a
  second run comparable.
- **TEI's CPU image cannot serve the Nemotron candidates, and the benchmark
  says so before spending runner time.** The engine source answers what this
  note first left open as a Phase 0.2 question: the candle backend maps
  `llama`/`llama_bidirec` to `Config::Llama` and on a CPU device returns
  `"Llama is only supported on Cuda devices in fp16 with flash attention
  enabled"` (backends/candle/src/lib.rs at v1.9.4); the ORT backend is tried
  first only when the repository holds `model.onnx*` or `onnx/model.onnx*`.
  Both Nemotron candidates are Llama-based. `teiCpuRefusal` encodes that rule
  over the Hub's `config.model_type` and file list, so a refused candidate
  writes an `ENGINE_REFUSES_ON_CPU` failure file after one metadata request,
  with no container started, and the summary reports its comparison
  **BLOCKED**, naming the refused model — distinct from INCOMPLETE, which a
  rerun might fix. As committed, a dispatch therefore yields the small
  models' figures (and `bge-reranker-base`'s) and a BLOCKED D-L4-3 unless an
  ONNX export of the Nemotron models exists on the Hub; it cannot DECIDE
  D-L4-3. Choosing an engine that serves a Llama-based model on CPU (or a GPU
  runner) is the Phase 0.2 research running on its own branch, and is not
  guessed at here: an engine running the model repository's own code
  (`trust_remote_code`) on a runner that can hold `HF_TOKEN` is a decision
  with a security side, and nothing about it could be executed from this
  session (no Hub access).
- **A stage that cannot run writes a failure file, never a record.** Any
  other load or run failure is `STAGE_FAILED`: the failure file names the
  stage and carries the engine's last log lines; the other stages carry on;
  the job fails at the end. The summary reads the failure files to tell
  BLOCKED from INCOMPLETE — a decision that never saw the Nemotron model is
  not D-L4-3 either way.
- **The rule is "smallest within the margin of the best", per reranker.**
  That is "keep the smaller unless recall drops past a margin" generalised to
  three candidates. Between eligible models of the SAME declared size
  (`bge-small-en` and `e5-small` are both 33M) the higher recall wins, then
  the model id (`chooseSmallest`); the first version kept whichever came first
  in record-file order, which could propose the worse of the two. The margin, 0.05 absolute recall@10, is PROPOSED in
  `candidates.ts`: on 200 cases the standard error of a recall near 0.8 is
  about 0.028, so anything much smaller chooses on noise. The owner confirms it
  before the first dispatch; the summary says it proposes, not decides.
- **On a GitHub runner, never the VM.** The capacity rule holds new
  containers off the production VM until C1. So the latency is a runner's,
  each record names the CPU, and the figures compare candidates rather than
  promise VM numbers; Phase 0.3's "hardware comparable to the production VM"
  is approximated, and the note that reports numbers must say so.
- **No secret is required.** `HF_TOKEN` is passed to the engine by name when
  the repository holds one (a gated model) and is absent otherwise; nothing
  skips. The job holds `contents: read` and uploads artifacts; a record is
  committed through a pull request whose CI recomputes it (G11).
- **Plain `fetch` to loopback.** `safeFetch` refuses loopback by design, and
  the SSRF population is `src/`. Instead, `teiUrl` refuses any host but
  `127.0.0.1` over http, so the only text that leaves the runner is the
  engine's own model download.
- **Probe inputs come from the set.** The 20-token query batch is the first
  32 questions; the 512-token passages are ~400-word runs of corpus text. The
  engine's own token count (`/tokenize`) is recorded beside the samples rather
  than assumed.

## Candidates, as named today

Embed: `nvidia/llama-nemotron-embed-1b-v2`, `BAAI/bge-small-en-v1.5`,
`intfloat/e5-small-v2`. Rerank: `nvidia/llama-nemotron-rerank-1b-v2`,
`BAAI/bge-reranker-base`. Image: TEI `cpu-1.9.4` by index digest
`sha256:2538ea1c…c78d`. The model ids, prefixes and sizes are from the model
cards as remembered here and are reconciled with the Phase 0.1–0.2 research
(licence, exact current model names, TEI support) before the first dispatch.

## What remains

- An engine for the Nemotron candidates on CPU (or a GPU runner), from the
  Phase 0.2 research; until then D-L4-3 reads BLOCKED.
- Pin each model's commit in `candidates.ts` after the first dispatch names
  it, and confirm the proposed margin with the owner.
- The Hub resolution, the refusal and the `--revision` echo are unit-tested
  on the pure functions only; the workflow has never been dispatched.
