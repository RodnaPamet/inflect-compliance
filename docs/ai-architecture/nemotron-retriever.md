inflect · ai architecture · nemotron retriever · roadmap v1 · 2026-10-29

# NVIDIA Nemotron Retriever — embeddings and reranking, Layer 4

> **Status: living design** — the integration roadmap for the Nemotron
> retriever models (embedding + reranking), named by the target architecture
> for Layer 4 as "NIM embeddings & reranking". The **Current state** section
> is true today (main 3.338.0, `a1c2f05c`). The **Roadmap** section is the
> plan. This is a child of
> [`docs/ai-architecture-roadmap.md`](../ai-architecture-roadmap.md): read that
> first for the target map, the global rules **G1–G13** every phase here
> inherits, and the sequencing. If the code contradicts a fact here, the code
> wins and the pull request that finds it corrects this document.

## Where it sits in the master roadmap

| | |
| --- | --- |
| Layer · box | 4 — Knowledge & deep RAG · "NVIDIA Nemotron Retriever (NIM embeddings & reranking)" |
| Wave | 1 for the CPU embedding and rerank arms (Phases 0–2, zero-GPU). The GPU arm (Phase 3) is optional Layer 5 work, after every other roadmap is complete |
| Depends on | nothing for Phases 0–2; Layer 5 ([`modal-inference.md`](./modal-inference.md)), optional and last, for Phase 3 |
| Unblocks | [`weaviate.md`](./weaviate.md) Phase 2 (nothing to index without a vector), [`ragas.md`](./ragas.md) |
| Owner decisions | **D-L4-3** (**decided 2026-11-11, amended and decided 2026-11-13**, owner: the pipeline is `intfloat/multilingual-e5-small` + `BAAI/bge-reranker-base`, chosen by the benchmark of 2026-11-13; the rule: Layer 4 compares small open models only, English and multilingual, on CPU, and keeps the smallest unless recall@10 drops by more than the margin overall or on the Bulgarian slice; Nemotron is not a Layer 4 candidate and stays only in Phase 3, optional Layer 5; open weights on an open engine, never the NIM container), **D-L4-1** (**decided 2026-11-11**, owner: pgvector first, in the existing Postgres under RLS), **D-L5-1** (decided 2026-10-31: no self-hosting now; Layer 5 optional and last), **D-L4-10** (decided 2026-11-12: the margin is 0.05 absolute recall@10; the latency budgets are open) |
| Complete at | Phase 2: embeddings and rerank on CPU, in the deployment. Phase 3 is optional Layer 5 work |

## At a glance

Purple hexagon: the Phase 0 decision. Blue: a phase not yet on `main`; it turns green (`done`) in the pull request that meets its "done when". Slate dashed: optional Layer 5 work, which starts only after every other roadmap is complete. Dashed white: another roadmap this one waits on or unblocks. Pink: the evaluation record.

```mermaid
flowchart LR
  P0{{"Phase 0 · verify<br/>weights, licence, engine<br/>seed recall, then CPU latency<br/>D-L4-3 small models, EN and BG"}}:::gate
  P1["Phase 1 · embedding seam, CPU<br/>tei-embed service<br/>EmbeddingProvider by residency<br/>builds nothing external"]:::todo
  P2["Phase 2 · reranker<br/>RerankProvider on TEI<br/>hydrate under RLS, then rerank<br/>new revision key"]:::todo
  P3["Phase 3 · GPU arm<br/>on the Layer 5 VM<br/>CPU and GPU parity"]:::optional
  SEED["Seed set, 250 cases<br/>200 EN, 50 BG, recall at 10"]:::eval
  MOD["Layer 5<br/>optional, after completion"]:::optional
  WV["weaviate P2<br/>index pipeline"]:::ext
  P0 --> P1 --> P2
  P2 -.-> P3
  SEED -.-> P1
  SEED -.-> P2
  MOD -.-> P3
  P1 -.->|unblocks| WV

  classDef done fill:#d1fae5,stroke:#047857,color:#064e3b
  classDef todo fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a
  classDef gate fill:#ede9fe,stroke:#6d28d9,color:#3b0764
  classDef ext fill:#ffffff,stroke:#64748b,color:#334155,stroke-dasharray:3 3
  classDef eval fill:#fce7f3,stroke:#be185d,color:#831843
  classDef optional fill:#f1f5f9,stroke:#475569,color:#334155,stroke-dasharray:6 3
```

## Current state (true today)

- **The embedding and rerank seam exists; no service behind it is deployed,
  and no vector exists.** `src/lib/ai/embeddings/` holds the
  `EmbeddingProvider` / `RerankProvider` contracts, the residency routing
  (`select.ts`, `inflect-local/<model>` only), a TEI client for
  `/v1/embeddings` and `/rerank` that refuses an answer from any model but the
  configured one (the embeddings response's `model`, the reranker's `/info`),
  one transport that dials only addresses inside the deployment's perimeter
  (`http.ts` over the shared in-deployment dial, `src/lib/ai/in-deployment-service.ts`,
  which the Docling parser and the NeMo guard provider use too: every resolved
  address, pinned, no redirects,
  deadline over the whole call, byte-capped body), a
  deterministic stub the factory never chooses, the retriever revision key
  and the `embeddings.requests` metric. With `AI_EMBED_LOCAL_*` /
  `AI_RERANK_LOCAL_*` unset — every deployment today — the factory refuses
  by name and constructs nothing. Nothing calls it yet; see
  [`weaviate.md`](./weaviate.md) § Current state for the store.
- **The models are chosen (D-L4-3, owner, 2026-11-13): `intfloat/multilingual-e5-small`
  embeds and `BAAI/bge-reranker-base` reranks.** The retriever benchmark
  (`.github/workflows/retriever-benchmark.yml`, run 43413063708 on `main`
  `32d3038`) scored nine pipelines on the seed set
  (`sha256:297f425a247bb6f6800528187765f404fee8e9f879c41f2727897fe11573e92f`,
  250 cases, 50 of them Bulgarian, BG → EN); its summary job recomputed every
  figure from each record's raw answers. The configuration that would point
  the seam at them (`AI_EMBED_LOCAL_MODEL`, `AI_RERANK_LOCAL_MODEL`) is unset
  until a service is deployed (1.1). The 50 Bulgarian translations are
  accepted unreviewed (owner, 2026-11-13).
- **The model-provider seam already routes by residency, and that is the seam
  an embedding provider must copy.** `src/lib/agentic/flue/model-selection.ts`
  owns the decision: provider ids name a residency (`inflect-external`,
  `inflect-local`), never a vendor; `resolveFlueModel` never builds an external
  route for a `LOCAL_ONLY` tenant; a deployment with no external credential
  registers no external provider at all; the socket boundary re-checks the
  specifier (`assistant/turn-provider.ts`). The local route is
  `AI_LOCAL_BASE_URL` / `AI_LOCAL_MODEL` / `AI_LOCAL_API_KEY` — an
  OpenAI-compatible endpoint "(Ollama / vLLM / …)" inside the operator's
  perimeter. A tenant's stored `aiLocalBaseUrl` is honoured only when it is
  that same address, and refused otherwise (#4545).
- **The sub-processor register lists two model vendors** (OpenRouter, Anthropic)
  and no embedding vendor (`docs/sub-processors.md`). Adding one is the
  four-step process (G2) — which is why the pilot arm below is CPU-local.
- **No NVIDIA software or model is a dependency.** `@flue/runtime`,
  `@earendil-works/pi-ai`, `@anthropic-ai/sdk` are the AI-adjacent packages
  (`package.json`). The OpenShell gateway integration
  (`src/lib/agentic/openshell/`) is a sandbox transport, not a model.

## Fit, and what is deliberately not adopted

**Adopted (D-L4-3, decided 2026-11-11, amended 2026-11-13).** Open-weight
retriever models served by an open engine on CPU in the deployment — Hugging
Face **Text Embeddings Inference** (TEI, Apache-2.0) — and a GPU arm only as
optional Layer 5 work. Which models is a measurement, not a preference: small
open models (BGE / E5 class, MIT or Apache-2.0), English-only and multilingual,
are benchmarked against each other, and **the smallest is kept unless its
recall@10 is lower by more than the margin (0.05, D-L4-10), overall or on the
Bulgarian slice**. The candidates are `bge-small-en-v1.5`, `e5-small-v2` and
`multilingual-e5-small` for embedding, and `bge-reranker-base` and
`bge-reranker-v2-m3` for reranking (`scripts/retriever-benchmark/candidates.ts`).
**The rule chose `multilingual-e5-small` + `bge-reranker-base` (2026-11-13)**;
the figures are under Phase 0, 0.3.

The amendment (owner, 2026-11-13) took the Nemotron 1B models out of Layer 4.
They run on no CPU engine the deployment has, a 1B model costs about ten times
a small one's memory and CPU on the VM, and the per-tenant corpora are small
and reranked, which is where a small model is usually enough. Nemotron stays
only in Phase 3, the optional Layer 5 GPU arm. The same amendment found that
both small candidates the benchmark carried were English-only, while D-L4-3
asked for a multilingual one and the product serves Bulgarian; the candidate
list and the seed set were corrected in the same pull request. Vectors go to **pgvector** in the existing Postgres, under RLS
(D-L4-1). A single `EmbeddingProvider` seam in `src/lib/ai/embeddings/` that is
residency-routed exactly like `model-selection.ts`.

Phase 0's desk research
([`2026-11-11-retriever-phase0-facts.md`](../implementation-notes/2026-11-11-retriever-phase0-facts.md))
found that TEI's native CPU backend refuses Llama- and Mistral-family models at
start-up, so no current Nemotron retriever model runs on TEI's CPU build without
an ONNX export (untested); the small candidates run on it natively. That finding
is one of the reasons for the 2026-11-13 amendment.

**Not adopted, with the reason.**

- *The NIM container.* Production use is NVIDIA AI Enterprise licensing
  (blueprint §3). The weights are open; the container is not free. D-L4-3.
- *Cloud embedding APIs for the pilot* (OpenAI / Cohere / Voyage), which the
  blueprint's pilot phase suggests. Each is a sub-processor receiving business
  content, so each is a 30-day notice before the first vector; a 1B embedding
  model runs on the VM's CPU today with no notice at all. The pilot is
  sovereign because it is cheaper to be.
- *Dense-only.* Hybrid search (full-text + vector) is the store's — Postgres
  full-text beside pgvector under D-L4-1, Weaviate's BM25 only if the store
  moves; the reranker is the second stage over hybrid hits. A dense-only
  pipeline would re-derive what the store already does.

## Roadmap (future direction)

### Phase 0 — Verify the models, the licence and the engine

**Goal.** Facts, not assumptions: which weights, under which licence, on which
engine, how well they retrieve against a small open model (D-L4-3), and at what
latency on this VM's CPU.

**Sub-phases.** The desk research is recorded in
[`2026-11-11-retriever-phase0-facts.md`](../implementation-notes/2026-11-11-retriever-phase0-facts.md);
the measurements are still to run.
- [x] 0.1 Identify the current open-weight Nemotron embed + rerank models and
      their licence; record whether the terms permit multi-tenant SaaS use.
      Done 2026-11-11: Nemotron 3 Embed 1B (OpenMDW-1.1, quoted: SaaS use
      permitted) and Llama Nemotron Rerank 1B v2, the only current 1B Nemotron
      reranker. The Llama-based models carry the Llama 3.2 terms, including a
      "Built with Llama" display obligation.
- [ ] 0.1b Read the licence files in the kept models' repositories before any
      weights enter `deploy/` (G5). Since the 2026-11-13 amendment these are the
      small candidates' (MIT or Apache-2.0 on their model cards); the Nemotron
      licences matter only if Phase 3 is taken up.
- [x] 0.2 Which engine serves which model on CPU. Done 2026-11-11 from TEI's
      source: TEI's native CPU backend refuses Llama- and Mistral-family models,
      so no current Nemotron retriever model runs on TEI's CPU build without an
      ONNX export (untested); the small multilingual candidates (E5, Arctic
      Embed v2 / GTE, BGE-M3, BGE and GTE rerankers) run on it natively, fp32.
- [x] 0.3 Quality (Q1, engine-independent, in CI): recall@10 for each
      embedder alone, then each reranker on a fixed top-50 pool, against the
      seed set, overall and on its Bulgarian slice
      (`.github/workflows/retriever-benchmark.yml`, dispatch-only). The rule is
      D-L4-3's as amended: the smallest pipeline within 0.05 recall@10 of the
      best (D-L4-10), overall AND on the Bulgarian slice, so an English-only
      model that falls behind on Bulgarian questions is not kept. On 50
      Bulgarian cases that margin is about one standard error; growing the
      slice is open under D-L4-10.
      **Done 2026-11-13** (run 43413063708 on `main` `32d3038`, seed set
      `sha256:297f425a…3e92f`, figures recomputed from each record's raw
      answers by the workflow's summary job). Recall@10 / recall@10 (bg) /
      MRR@10 / embed p50 / embed p95 ms:

      | Pipeline | R@10 | R@10 (bg) | MRR@10 | p50 | p95 |
      | --- | --- | --- | --- | --- | --- |
      | `bge-small-en-v1.5` + `bge-reranker-base` | 0.801 | 0.080 | 0.739 | 20.4 | 34.7 |
      | `bge-small-en-v1.5` + `bge-reranker-v2-m3` | 0.808 | 0.080 | 0.787 | 20.4 | 34.7 |
      | `bge-small-en-v1.5` alone | 0.781 | 0.060 | 0.686 | 20.4 | 34.7 |
      | `e5-small-v2` + `bge-reranker-base` | 0.797 | 0.060 | 0.742 | 7.6 | 17.1 |
      | `e5-small-v2` + `bge-reranker-v2-m3` | 0.804 | 0.060 | 0.783 | 7.6 | 17.1 |
      | `e5-small-v2` alone | 0.762 | 0.000 | 0.680 | 7.6 | 17.1 |
      | `multilingual-e5-small` + `bge-reranker-base` | 0.946 | 0.840 | 0.863 | 9.6 | 13.5 |
      | `multilingual-e5-small` + `bge-reranker-v2-m3` | 0.960 | 0.880 | 0.936 | 9.6 | 13.5 |
      | `multilingual-e5-small` alone | 0.899 | 0.733 | 0.774 | 9.6 | 13.5 |

      The summary's per-reranker-group rule chose `multilingual-e5-small` in
      every group. Across all nine pipelines, D-L4-3's rule gives: the best is
      `multilingual-e5-small` + `bge-reranker-v2-m3` (0.960 / 0.880);
      `multilingual-e5-small` + `bge-reranker-base` is within the margin
      (0.014 behind overall, 0.040 on the Bulgarian slice) and smaller;
      `multilingual-e5-small` alone is outside it (0.061 behind overall). The
      English-only embedders reach 0.080 at most on the Bulgarian slice.
      **Decided (owner, 2026-11-13): `multilingual-e5-small` +
      `bge-reranker-base`**, accepting the lower first-place ranking (MRR@10
      0.863 against 0.936) as the price of not resizing the VM.
      `bge-reranker-v2-m3` is the better-ranking alternative if the VM is ever
      resized for another reason; that is not a commitment. The latencies are
      the CI runner's, not the VM's. Reranker latency was in the summary's
      columns but was not captured with these figures, and the benchmark
      measured no per-pipeline memory: the capacity lines stay estimates from
      the weights until 0.5.
- [x] 0.4 The seed set, `tests/fixtures/rag/retriever-seed-set.json` with a
      content hash: 200 English questions over 372 chunks of the seed's policy
      text, and since 2026-11-13 a 50-case Bulgarian slice. Each Bulgarian case
      translates one English case and keeps its labels, so the slice measures
      Bulgarian questions over English text (BG → EN). The planned BG → BG
      cases are not possible while the seed carries no Bulgarian policy text.
      The translations are the assistant's; the owner accepted them
      unreviewed on 2026-11-13, and the fixture is unchanged (editing it
      changes its content hash).
- [ ] 0.5 CPU latency and memory (Q2) on the production VM for the chosen
      pipeline (`multilingual-e5-small` + `bge-reranker-base`), through a dispatch-only
      workflow modelled on `VM capacity`: a temporary TEI container at 1.0 CPU,
      p50/p95 for a 20-token query, 32 × 512-token passages and a 1 × 50
      rerank, plus `memory.peak` and the host CPU's flags. Proposed budgets
      (not agreed): query p95 ≤ 250 ms, rerank p95 ≤ 2 s.
- [ ] 0.6 Dependency governance: TEI is a runtime image (digest), the model
      weights are a volume (`deploy/` volume + a checksum of the snapshot
      recorded in the note); no Python enters the app image.
- [x] 0.7 The vector's shape suits pgvector (D-L4-1): `vector` indexes up to
      2,000 dimensions and `halfvec` up to 4,000, so a 2048-dimension winner
      needs `halfvec`; every small candidate (384–1024) fits `vector`. The
      chosen `multilingual-e5-small` emits 384 dimensions, so it is `vector`.

**Prompt.**
```text
Context: no embedding model exists. Model routing is residency-based in
src/lib/agentic/flue/model-selection.ts (inflect-external / inflect-local; LOCAL_ONLY
tenants never reach an external route). Runtime images are digest-pinned
(docs/dependency-governance.md). D-L4-3 (decided 2026-11-11, amended 2026-11-13):
compare small open models, English and multilingual, on CPU, and keep the smallest
unless recall@10 drops by more than 0.05 (D-L4-10) overall or on the Bulgarian slice;
Nemotron is optional Layer 5 only. D-L4-1: pgvector first.
docs/implementation-notes/2026-11-11-retriever-phase0-facts.md holds the models,
licences, engine facts and the protocol.

Task: (1) Author the 200-pair seed set described in that note and commit it under
tests/fixtures/rag/ with a SHA-256 of its canonical JSON. (2) Run Q1 in a pinned CI image
(reference implementations, each model's documented query/passage treatment):
recall@10 and nDCG@10 per embedder, then per reranker on the winner's fixed top-50,
with a paired bootstrap 95% interval. (3) Run Q2 on the production VM through a
dispatch-only workflow modelled on vm-capacity.yml, for the candidates Q1 keeps.
(4) Record every number, digest and weights checksum in a new implementation note.

Constraints: no production change beyond the temporary benchmark container, no
dependency added to the app. Apply the note's decision rule as written: the larger
model wins only when its paired interval's lower bound clears the margin; grow the set
at most once, to 400 pairs, and treat that verdict as final; record the smallest drop
each slice could have shown. Read each kept model's licence file in its repository before recording it.

Done when: the record answers 0.3-0.5 with numbers and the seed set is in the repo with
a content hash.
```

**Hardening.** G5 (digests and licence recorded before adoption), G11 (the
seed set is authored now, tied by content hash, so Phase 1 ships with its
evaluation set rather than promising one).

**Done when.** The measurements are on `main` with numbers and the D-L4-3 rule
has picked the embedder and the reranker. D-L4-3 was initialled on 2026-11-11
and amended on 2026-11-13; the margin was agreed under D-L4-10 on 2026-11-12.
The pick is made (2026-11-13, 0.3); the VM measurements (0.5), the licence
read (0.1b) and the dependency record (0.6) remain.

### Phase 1 — The embedding seam, CPU-local

**Goal.** One `EmbeddingProvider` interface, residency-routed, with a TEI-on-CPU
backend inside the perimeter and a stub for tests; no sub-processor touched.

**Sub-phases.**
- [ ] 1.1 `deploy/docker-compose.prod.yml`: `tei-embed` service (TEI CPU image,
      digest-pinned, model volume, no published port, `app`/`worker` network
      only). Applied with `deploy/apply.sh`. Held by the capacity budget's C1
      (G5). The client already admits the Compose-network address
      (`http://tei-embed:8080`): `inflect-local` dials only addresses INSIDE
      the perimeter (RFC 1918, loopback, IPv6 ULA, every resolved address,
      pinned), and refuses a public one by name
      (`EMBED_ENDPOINT_OUTSIDE_PERIMETER`, `ENDPOINT_OUTSIDE_PERIMETER`).
      `safeFetch` is the wrong test here: it admits only public addresses,
      which are exactly the ones that make the residency claim false. The rule
      is the one every in-deployment service is held to (G6 as amended by the
      owner on 2026-11-12, `src/lib/ai/in-deployment-service.ts`, shared with
      the Docling parser and the NeMo guard provider): one operator variable
      read by one module, every resolved address inside, pinned, no redirect,
      deadline, a byte cap that aborts (`tests/guards/ssrf-egress-coverage.test.ts`,
      "THE IN-DEPLOYMENT SERVICES").
      `AI_EMBED_LOCAL_MODEL` must equal the container's `--model-id`.
- [x] 1.2 `src/env.ts`: `AI_EMBED_LOCAL_BASE_URL`, `AI_EMBED_LOCAL_MODEL`
      (optional; absent = no local embedding provider constructed), plus
      `AI_EMBED_LOCAL_DIMENSIONS` (required with them) and
      `AI_EMBED_LOCAL_QUERY_PREFIX` / `_PASSAGE_PREFIX` (absent = no prefix).
      The model is configuration; D-L4-3 chose `intfloat/multilingual-e5-small`
      (2026-11-13), set here when 1.1 deploys it.
- [x] 1.3 `src/lib/ai/embeddings/`: `types.ts` (`EmbeddingProvider.embed(texts,
      { inputType: 'query' | 'passage' })` returning vectors + `model` +
      `dimensions`), `select.ts` (residency routing copied from
      `model-selection.ts`: `inflect-local/<model>` only for now; a
      `LOCAL_ONLY` tenant with no local embed route is **refused**, never
      routed elsewhere), `tei-provider.ts` (OpenAI-compatible `/v1/embeddings`;
      the served model must be the configured one), `stub-provider.ts`
      (deterministic hashed vectors for tests). The transport is `http.ts`,
      the directory's JSON adapter over the shared in-deployment dial
      (`src/lib/ai/in-deployment-service.ts`), not `safeFetch`; no file in
      the directory makes a fetch call of its own.
- [x] 1.4 The factory returns before constructing anything external
      (residency is structural — the `identity-match/index.ts` pattern); the
      residency guard's constructor pin gains the new set.
- [x] 1.5 Outcome metric `embeddings.requests{provider,outcome}` and a duration
      histogram (`embeddings.request.duration`), both also labelled
      `operation` (`embed` / `rerank`).

**Prompt.**
```text
Context (main 3.338.0): routing is residency-based (flue/model-selection.ts); the
identity-match provider factory returns BEFORE constructing an external provider and
tests/guards/ai-residency-enforcement.test.ts pins the constructor set; outbound calls to
hosts outside the deployment go through safeFetch, calls to a service run inside it go
through src/lib/ai/in-deployment-service.ts (G6 as amended 2026-11-12), and new hosts join
tests/guards/ssrf-egress-coverage.test.ts's population; the Compose file is repo-canonical and images are digest-pinned. Phase 0
recorded the model, digest and benchmark.

Task: add the embedding seam. (1) A `tei-embed` service (TEI CPU, digest-pinned, model
volume, no published port). (2) AI_EMBED_LOCAL_BASE_URL / AI_EMBED_LOCAL_MODEL in
src/env.ts, optional. (3) src/lib/ai/embeddings/: types.ts, select.ts (residency routing
— inflect-local only; a LOCAL_ONLY tenant with no local route is refused with a named
reason), tei-provider.ts (POST /v1/embeddings via the in-deployment dial, inputType mapped to the
model's query/passage prefixes, batch ≤ 64, abort on timeout, degrade rather than throw),
stub-provider.ts (deterministic). (4) Factory that returns before constructing anything
external; extend the residency guard's pinned constructor set in the same diff. (5)
Metric embeddings.requests{provider,outcome} + duration histogram.

Constraints: no cloud embedding API. The base URL is operator config, never tenant-
writable. A per-tenant override, if added, follows aiLocalBaseUrl's rule: honoured only
when it is the deployment's own address (#4545). Name tests for invariants: "a LOCAL_ONLY tenant with no local embed route is
refused", "embed() never sends a specifier addressed to another provider", "the factory
constructs nothing external for LOCAL_ONLY".

Done when: typecheck/lint green, the residency guard green with the new set, the SSRF
egress guard sees the new sink, and the two-tenant job test in weaviate.md Phase 2 passes
against the real provider in the integration project.
```

**Hardening.** G1 (residency first, structural), G6 (hosts are config, reads
bounded, the SSRF guard's population; the address test is the in-deployment
rule's, not `safeFetch`'s — see 1.1), G5 (image + volume, no Python in the app image), G9 (absent
config = no provider), checklist §3/§4 (runtime wiring, outcome metric). The
`inputType` mapping is not cosmetic: asymmetric retrieval models score query
and passage differently, and mixing them silently degrades recall.

**Done when.** `knowledge-index` ([`weaviate.md`](./weaviate.md) Phase 2)
produces vectors from the CPU TEI service for a seeded tenant, and the
recall@10 on the Phase 0 seed set matches Phase 0's number within noise.

### Phase 2 — The reranker (second stage)

**Goal.** Top-k hybrid hits re-ordered by the cross-encoder; a revision change
the mount gate can see.

**Sub-phases.**
- [x] 2.1 `RerankProvider.rerank(query, passages, { topN })` beside the embedding
      seam, same residency routing, TEI `/rerank` backend on the same service
      (second model on the same container or a sibling `tei-rerank`). The
      route is `AI_RERANK_LOCAL_BASE_URL` / `AI_RERANK_LOCAL_MODEL`; the
      service itself waits with 1.1. Each call reads `/info` first and sends
      no passage to a reranker whose `model_id` is not the configured one.
      `rerankOrKeepHybridOrder` bounds the pool
      to 50 and returns the hybrid order, with the reason, on any failure.
- [ ] 2.2 `VectorRepository.search` gains `rerank: true` → hybrid top-50 then
      rerank to k; the revision key for the mount gate includes the rerank
      model id. The key exists (`revision.ts`:
      `{ embeddingModel, rerankModel, chunker, k, alpha }`, models never
      provider ids, so the CPU and GPU arms share one revision); the search
      waits on [`weaviate.md`](./weaviate.md) Phase 3.
- [ ] 2.3 Text hydration happens **before** rerank (the cross-encoder needs the
      passage) and **under RLS** — never from the vector store.
- [ ] 2.4 Seed-set eval re-run; the record is refreshed or the gate refuses.

**Prompt.**
```text
Context (main 3.338.0): the embedding seam (Phase 1) and VectorRepository.search (weaviate
Phase 3) exist; the search_knowledge mount gate consumes a RAG evaluation record keyed by
(embeddingModel, chunker, k, alpha). Chunk text is hydrated from Postgres under RLS, never
from any store outside Postgres (vectors-only rule D-L4-2, adopted 2026-11-11).

Task: add reranking. (1) RerankProvider in src/lib/ai/embeddings/ (TEI /rerank backend,
same residency routing and factory rules as the embedding provider, stub for tests). (2)
VectorRepository.search({ rerank: true }): hybrid top-50 → hydrate text under RLS →
rerank → top-k. (3) Extend the mount-gate revision key with rerankModel so the existing
record no longer satisfies it. (4) Re-run the seed-set eval and commit the new record.

Constraints: hydration before rerank, under RLS, through the repositories. Passage
count sent to the reranker is bounded (≤ 50). A reranker failure degrades to the hybrid
order with a WARN and an outcome label, never to an empty result. Tests: "rerank never
receives a passage the tenant cannot read", "a reranker outage returns hybrid order".

Done when: recall@10 with rerank meets or beats Phase 0's number, the gate refuses
until the new record lands, and the degradation test is green.
```

**Hardening.** G7 (hydration under RLS is the isolation boundary for the
cross-encoder), G11 (a new model in the chain is a new revision, and a new
revision has no record until one is produced), G4 unchanged (results are
scanned at the tool boundary, after rerank).

**Done when.** The nightly RAG eval shows the rerank gain and the gate is on.

### Phase 3 — The GPU arm (optional, Layer 5)

**Goal.** The same two providers served on the Layer 5 GPU VM, for a
deployment that takes Layer 5 up after every other roadmap is complete.

**Sub-phases.**
- [ ] 3.1 Depends on a production local route
      ([`modal-inference.md`](./modal-inference.md) Phase 2).
- [ ] 3.2 TEI's GPU image on the Layer 5 VM, exposing `/v1/embeddings` and
      `/rerank`, deployed from the Layer 5 scripts — Python and drivers stay
      on the VM, never in the app.
- [ ] 3.3 `select.ts` routes to the GPU arm through the local route for the
      tenants who may use it. A VM in the operator's own Google Cloud project
      is local, so `LOCAL_ONLY` tenants may use it too.
- [ ] 3.4 Same model, same dimensions, same revision key: a vector produced on
      CPU and on GPU must be interchangeable, proven by a test that embeds the
      seed set on both and compares cosine ≥ 0.999.
- [ ] 3.5 Only here, a Nemotron retriever (the 1B embed and rerank models,
      Llama-based, which TEI serves on GPU) may be measured against the Layer 4
      winner on the same seed set, by the same rule (D-L4-3 as amended
      2026-11-13). A different model is a new revision key and a re-embedding,
      never a silent swap.

**Prompt.**
```text
Context (main + Layer 5 taken up): the embedding + rerank seam (Phases 1–2) runs on CPU
in the deployment and routes by residency; a production local route exists on the
Layer 5 GPU VM (modal-inference.md Phase 2), reached through AI_LOCAL_* style operator
configuration.

Task: add the GPU arm. (1) TEI's GPU image for the pinned embed + rerank models on the
Layer 5 VM, weights on the VM's disk, behind the same operator-held token as the local
model route. (2) select.ts: route to the GPU arm through the local route when it is
configured; fall back to the CPU arm when it is not. (3) A parity test: the seed set
embedded on the CPU and the GPU arm agree (cosine ≥ 0.999) — the revision key must NOT
change between arms. (4) Metric label provider=local-gpu.

Constraints: the GPU arm's address is operator config, never tenant-writable; the token
is a secret in the environment file (never echoed). Nothing external is reached.

Done when: the parity test is green against the deployed GPU arm, the residency tests are
green, and the embeddings metric shows both arms.
```

**Hardening.** G1 (the arm is chosen by residency, re-checked at the socket),
G9 (an unconfigured GPU arm registers nothing and the CPU arm serves). Parity
is the eval: two arms that disagree are two models, and two models are two
revisions.

**Done when.** A deployment with the GPU arm configured embeds on it; one
without it is byte-identical to Phase 2.

## Evals for this framework

| What | How | Record |
| --- | --- | --- |
| Retrieval quality | recall@10 on the seed set (200 English cases, 50 Bulgarian), with and without rerank (Phase 0, re-run per revision) | evaluation record (G11) consumed by the `search_knowledge` mount gate |
| Cross-arm parity | CPU vs GPU cosine ≥ 0.999 on the seed set (Phase 3, optional) | CI, when the GPU arm is configured |
| Latency | p50/p95 per provider | `embeddings.requests` histogram |
| Residency | "LOCAL_ONLY never reaches an external provider" | unit + guard, every phase |

## Updating the master

Flip the row on the master [Status board](../ai-architecture-roadmap.md#status-board)
per phase; D-L4-3 and the model/revision in force are recorded in the master's
decision table and in the Phase 0 note. If Phase 3 lands, the master's
"Layer 5 is optional by construction" section lists the retriever's GPU arm.
