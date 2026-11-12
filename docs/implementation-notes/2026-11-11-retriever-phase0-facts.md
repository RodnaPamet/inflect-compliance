# 2026-11-11 — Retriever Phase 0: models, licences, engine, benchmark protocol

Research slice of [`nemotron-retriever.md`](../ai-architecture/nemotron-retriever.md)
Phase 0 (sub-phases 0.1, 0.2 and the protocol half of 0.3/0.4). Nothing was run,
deployed or added as a dependency. The decisions it is written against, taken by
the owner on 2026-11-11:

- **D-L4-1** — pgvector first, in the existing Postgres, under RLS; Weaviate only
  if a measured recall or latency floor is not met.
- **D-L4-2** — vectors-only rule: no chunk text outside Postgres.
- **D-L4-3** — benchmark the Nemotron 1B embed and rerank models against a small
  open model (BGE / E5 class) on CPU, and keep the smaller unless recall@10 drops
  by more than an agreed margin. The margin is proposed below; it is not agreed.

## How the facts were gathered, and what could not be reached

This session's proxy refused `huggingface.co`, `build.nvidia.com`,
`docs.nvidia.com`, `docs.api.nvidia.com`, `www.nvidia.com`, `arxiv.org` and
`gigazine.net`. **No Hugging Face model card was read**, so no fact below is
quoted from one. What was read is the primary source code and documentation the
publishers keep on GitHub, fetched raw at the commits in the table. Where a figure
comes only from a web-search index summary it is labelled **unverified**: those
summaries paraphrase, and two of them contradicted each other on a licence.

| # | Source (read in full or in the quoted part) | Commit / version |
| --- | --- | --- |
| S1 | TEI README — https://github.com/huggingface/text-embeddings-inference/blob/main/README.md | `HEAD da9a9ce1`, release `v1.9.4` (`e80ef225`), `Cargo.toml` version 1.9.4 |
| S2 | TEI candle backend — https://github.com/huggingface/text-embeddings-inference/blob/main/backends/candle/src/lib.rs | same |
| S3 | TEI ORT backend — https://github.com/huggingface/text-embeddings-inference/blob/main/backends/ort/src/lib.rs, `backends/src/lib.rs`, `Dockerfile` | same |
| S4 | NVIDIA NeMo Retriever library README — https://github.com/NVIDIA/nv-ingest/blob/main/README.md | `ca5b3116` |
| S5 | NVIDIA Nemotron recipes — https://github.com/NVIDIA-NeMo/Nemotron/blob/main/docs/nemotron/embed/index.md, `embed/text.md`, `rerank/index.md`, `rerank/text.md` | `a121b64f` |
| S6 | OpenMDW-1.1 licence text — https://github.com/OpenMDW/OpenMDW/blob/main/1.1/LICENSE.OpenMDW-1.1 | `b26b32b3` |
| S7 | Llama 3.2 Community License and Acceptable Use Policy — https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE, `USE_POLICY.md` | `0e0b8c51` |
| S8 | FlagEmbedding (BGE) README, licence, BGE-M3 README — https://github.com/FlagOpen/FlagEmbedding | `897baa67` |
| S9 | E5 README and unilm licence — https://github.com/microsoft/unilm/tree/master/e5 | `31c5b904` |
| S10 | Arctic Embed README — https://github.com/Snowflake-Labs/arctic-embed | `8e79950c` |
| S11 | Qwen3 Embedding README — https://github.com/QwenLM/Qwen3-Embedding | `44548aa5` |
| S12 | pgvector README — https://github.com/pgvector/pgvector | `66accb3a` |
| S13 | vLLM CPU installation page — https://github.com/vllm-project/vllm/blob/main/docs/getting_started/installation/cpu.md | main, 2026-11-11 |

## 0.1 — The current open-weight Nemotron retriever models

NVIDIA's own recipe tables (S5) name the current models:

| Role | Model (S5) | Size | Note |
| --- | --- | --- | --- |
| Embed | Nemotron 3.5 Embed 1B (`nvidia/Nemotron-3.5-Embed-1B-BF16`) | 1B class | multimodal ("Text-only, image-only, or paired documents"); "deploys directly through vLLM" |
| Embed | Nemotron 3 Embed 1B (`nvidia/Nemotron-3-Embed-1B-BF16`) | ≈1.1B, derived below | text; NVIDIA's current **default** embedding model (S4) |
| Embed | Llama Nemotron Embed 1B v2 (`nvidia/llama-nemotron-embed-1b-v2`) | 1B class | text; the model this roadmap originally named |
| Rerank | Llama Nemotron Rerank 1B v2 (`nvidia/llama-nemotron-rerank-1b-v2`) | 1B class | text cross-encoder; the **only current 1B Nemotron reranker** |
| Rerank | Nemotron 3.5 Rerank 8B | 8B | out of scope: an 8B cross-encoder on a 2-vCPU host is not a candidate |

So the roadmap's "Llama-Nemotron Embed 1B v2 … or their current successors" now
means **Nemotron 3 Embed 1B** for embedding (3.5 is the multimodal successor) and
still **Llama Nemotron Rerank 1B v2** for reranking.

**Nemotron 3 Embed 1B, what is known from primary sources.** S5's profile table:
"Embedding dimension | 2048", "Recipe sequence length | 512" (the fine-tuning
recipe's, not the model's maximum), "Serving input artifact | Hugging Face
PyTorch/safetensors checkpoint", and the checkpoint fingerprint "hidden size
2,048; 16 layers; 24 attention heads; 8 key/value heads; intermediate size 6,144;
and vocabulary size 131,072". It takes `input_type` (`query` or `document`)
"without adding text prefixes". From the fingerprint, assuming 128-dimensional
heads, the parameter count is ≈ 0.27B (embeddings) + 16 × ≈ 54.5M ≈ **1.14B**,
which matches the search index's "~1.14B". Maximum sequence length is
**unverified**: the search index reports 32,768 on the model card and 4,096 as
NIM's validated limit; we never use NIM, and Phase 1 chunks are ≤ 512 tokens, so
it does not decide anything. Base model is **unverified** (search index:
Ministral-3-3B, pruned; a community GGUF repack labels the architecture
`mistral3`).

**Licences.**

- *Nemotron 3 Embed 1B* — S4, quoted: "The model is governed by the OpenMDW
  License Agreement, version 1.1 and identifies the Apache License, Version 2.0,
  as additional information." OpenMDW-1.1 (S6), quoted:
  > "Subject to your compliance with this agreement, permission is hereby
  > granted, free of charge, to deal in the Model Materials without restriction,
  > including under all copyright, patent, database, and trade secret rights
  > included or embodied therein."

  > "If you distribute any portion of the Model Materials, you shall retain in
  > your distribution (1) a copy of this agreement, and (2) all copyright notices
  > and other notices of origin included in the Model Materials that are
  > applicable to your distribution."

  > "If you file, maintain, or voluntarily participate in a lawsuit against any
  > person or entity asserting that the Model Materials directly or indirectly
  > infringe any patent or copyright, then all rights and grants made to you
  > hereunder are terminated, unless that lawsuit was in response to a
  > corresponding lawsuit first brought against you."

  > "This agreement does not impose any restrictions or obligations with respect
  > to any use, modification, or sharing of any outputs generated by using the
  > Model Materials."

  **Multi-tenant SaaS use is permitted**: there is no field-of-use, user-count
  or hosting restriction; the obligations attach to *distributing* the weights,
  which serving them from our own container does not do; embeddings are outputs
  and carry no obligation. The one live term is the patent/copyright litigation
  termination. The Phase 0 gate ("if the terms do not permit SaaS use, stop")
  passes for this model. The licence file in the model repository itself was not
  read (Hugging Face unreachable); the obligation to read it before the weights
  enter `deploy/` stands (G5).

- *Llama Nemotron Embed 1B v2 / Rerank 1B v2* — **unverified**. The search index
  gave two contradicting answers (OpenMDW-1.1 with the Llama 3.2 Community
  License as "additional information"; or the NVIDIA Open Model License). Both
  answers carry the Llama 3.2 terms, because the models are built on Llama 3.2.
  Those terms (S7), quoted:
  > "If, on the Llama 3.2 version release date, the monthly active users of the
  > products or services made available by or for Licensee, or Licensee's
  > affiliates, is greater than 700 million monthly active users in the
  > preceding calendar month, you must request a license from Meta …"

  > "If you distribute or make available the Llama Materials (or any derivative
  > works thereof), or a product or service (including another AI model) that
  > contains any of them, you shall (A) provide a copy of this Agreement with any
  > such Llama Materials; and (B) prominently display "Built with Llama" on a
  > related website, user interface, blogpost, about page, or product
  > documentation."

  SaaS use is permitted (we are far below 700M MAU), **but shipping either Llama
  Nemotron model creates a "Built with Llama" display obligation** and binds us to
  the Acceptable Use Policy. The AUP's EU clause (S7, "With respect to any
  multimodal models included in Llama 3.2, the rights granted … are not being
  granted to you if you are … a company with a principal place of business in,
  the European Union") applies to multimodal models only, so not to these two
  text models; it would bear on the `-vl-` variants.

## 0.2 — Does TEI serve them on CPU?

**TEI on CPU does not serve any current Nemotron retriever model through its
native backend.** The candle backend (S2) refuses Llama and Mistral on CPU at
start-up, in code:

```rust
(Config::Llama(_), Device::Cpu | Device::Metal(_)) => Err(BackendError::Start(
    "Llama is only supported on Cuda devices in fp16 with flash attention enabled"
```

and the same sentence for `Mistral` and `Qwen2`. (TEI's config enum carries
`#[serde(alias = "llama_bidirec")]` on `Llama`, i.e. it knows the bidirectional
Llama embedding config — on CUDA only.) A `mistral3` model type, if that is what
Nemotron 3 Embed's config declares (unverified), is not in the enum at all and
fails as "Model is not supported". The README's supported list (S1) is "Nomic,
BERT, CamemBERT, XLM-RoBERTa … JinaBERT … Mistral, Alibaba GTE, Qwen2 … MPNet,
ModernBERT, Qwen3, and Gemma3" for embeddings, and for `/rerank` "CamemBERT, and
XLM-RoBERTa Sequence Classification models" (its examples add GTE and
ModernBERT rerankers). No Llama sequence classifier is listed.

The one remaining TEI CPU route is the **ORT backend** (S3): the CPU image is
built `--features ort,candle,mkl`, and the router tries ORT first when the
repository carries `onnx/model.onnx` or `model.onnx`. ORT accepts only
`float32` ("Dtype {dtype} is not supported for `ort`, only float32."). NVIDIA's
own recipe exports the Llama profiles to ONNX ("Export (Llama only)", S5), so an
ONNX graph of Llama Nemotron Embed/Rerank 1B v2 can be produced; whether TEI's ORT
backend accepts that graph's inputs and pooling is **unverified** and can only be
established by running it. Nemotron 3 Embed has no ONNX export step ("Stage 4 is
an intentional no-op for this profile"); NVIDIA serves it with NIM or vLLM
(S5). vLLM documents a CPU backend for x86 (S13); serving these checkpoints on it
is unverified.

**Precision on TEI CPU is fp32.** ORT asserts float32; candle's CPU paths run
float32. No int8 option exists in TEI on CPU; int8 would need a pre-quantised
ONNX graph, untested. The int8 column below is therefore arithmetic for D-CAP-1,
not a TEI configuration.

**Small open candidates that TEI serves on CPU.** Multilingual is required: the
product ships `messages/bg.json`, and D-L1-1 names EN + BG. Sizes are weights
only (params × 4 B fp32, × 1 B int8), before runtime overhead.

| Candidate | Role | Licence (source) | Params | Dim / max len | TEI CPU arch | fp32 / int8 weights |
| --- | --- | --- | --- | --- | --- | --- |
| `intfloat/multilingual-e5-small` | embed | MIT — unilm `LICENSE` (S9); card unverified | ≈118M, unverified | 384 (S9) / 512, unverified | XLM-RoBERTa ✓ | ≈0.47 GB / ≈0.12 GB |
| `Snowflake/snowflake-arctic-embed-m-v2.0` | embed | Apache-2.0: "The released models can be used for commercial purposes free of charge." (S10) | 305M (S1) | 768, unverified / 8192, unverified | Alibaba GTE ✓ (S1) | ≈1.22 GB / ≈0.31 GB |
| `BAAI/bge-m3` | embed | MIT — FlagEmbedding `LICENSE` (S8); card unverified | ≈568M, unverified | 1024 / 8192 (S8) | XLM-RoBERTa ✓ | ≈2.27 GB / ≈0.57 GB |
| `BAAI/bge-reranker-v2-m3` | rerank | MIT repo (S8); card unverified | ≈568M, unverified | — / unverified | XLM-RoBERTa classifier ✓ | ≈2.27 GB / ≈0.57 GB |
| `Alibaba-NLP/gte-multilingual-reranker-base` | rerank | unverified (card unreachable) | ≈306M, unverified | — / unverified | GTE classifier ✓ (listed in S1) | ≈1.22 GB / ≈0.31 GB |
| Nemotron 3 Embed 1B | embed | OpenMDW-1.1 (S4, S6) | ≈1.14B (derived) | 2048 (S5) / unverified | **refused** (Mistral-family) | ≈4.6 GB / ≈1.1 GB |
| Llama Nemotron Embed 1B v2 | embed | unverified (+ Llama 3.2 terms) | 1B class | unverified | **refused** (Llama), ORT/ONNX untested | ≈5 GB / ≈1.2 GB at 1.24B, unverified |
| Llama Nemotron Rerank 1B v2 | rerank | unverified (+ Llama 3.2 terms) | 1B class | — / 512 in NVIDIA's recipe (S5) | **refused** (Llama), ORT/ONNX untested | as above |

Excluded and why: `BAAI/bge-reranker-base` ("Chinese and English", S8 — no
Bulgarian); `google/embeddinggemma-300m` (gated, Gemma terms are not MIT/Apache);
`Qwen/Qwen3-Embedding-0.6B` (TEI CPU serves Qwen3, 509M, 1024 dim, 32K — S1, S11
— but its licence was not readable here) and `Qwen3-Reranker-0.6B` (a causal-LM
yes/no scorer, `AutoModelForCausalLM` in S11, not a sequence classifier TEI's
`/rerank` lists). Either Qwen model returns to the list if the owner wants it and
its card's licence reads Apache-2.0.

**A D-L4-1 consequence.** pgvector indexes `vector` "up to 2,000 dimensions" and
`halfvec` "up to 4,000 dimensions" (S12). Nemotron 3 Embed's 2048 dimensions do
not fit an HNSW index on `vector`; it needs `halfvec` (or truncation, which NVIDIA's
own sources contradict each other on, unverified). Every small candidate above
(384–1024) fits `vector`. Separately, production runs `postgres:16-alpine`
(`deploy/docker-compose.prod.yml`), which does not ship the pgvector extension;
that is [`weaviate.md`](../ai-architecture/weaviate.md)'s Phase 1 to settle.

## 0.3 / 0.4 — The benchmark protocol (defined, not run)

Two questions, in this order, because the second is only worth asking for a
model that wins the first.

**Q1 — quality (engine-independent, in CI, no VM).**

- *Seed set: 200 pairs, seed content only, committed under `tests/fixtures/rag/`
  with a SHA-256 of its canonical JSON.* Passages: every chunk of the content the
  product ships — `src/data/policy-templates.ts` (10 templates), control and
  clause texts in `src/data/` and the framework catalogues in `prisma/catalogs/` —
  chunked by the chunker Phase 1 will use, so the distractor corpus is real (its
  size is recorded with the result). Queries: the seeded questionnaire questions
  (`prisma/seed-vendor-questionnaire.ts`, `prisma/aisvs-vendor-questionnaire.ts`)
  plus authored questions. Composition: **150 EN → EN, 25 BG → BG** (Bulgarian
  passages authored for them), **25 BG → EN** (cross-lingual, which a Bulgarian
  tenant reading English templates does). Each pair names 1–3 relevant chunk ids;
  no customer content.
- *Metrics.* recall@10 per query = |relevant ∩ top-10| / |relevant|, averaged;
  nDCG@10 reported beside it. Embedders are compared alone (dense top-10).
  Rerankers are compared on a **fixed candidate pool**: the winning embedder's
  top-50 per query, reranked to 10, so the reranker is the only variable.
- *Inputs as the model was trained.* Each model gets its documented query/passage
  treatment (E5's prefixes, Nemotron's `input_type`); the harness records it,
  because a wrong prefix silently costs recall.
- *Engine.* The reference implementation in a pinned CI image (Python stays in
  CI, never the app image — G5), the same weights revision the VM would pull. The
  quality numbers do not depend on TEI vs ORT vs vLLM beyond float noise.
- *Uncertainty.* A paired bootstrap over the queries (10,000 resamples, fixed
  seed) gives a 95% interval on each difference Δ = recall@10(Nemotron) −
  recall@10(small), overall and on the Bulgarian slice. Near 0.85 one model's
  recall@10 has a standard error of about 2.5 points at 200 queries and about 5
  at 50. The paired interval depends on how strongly the two models agree query
  by query; for a per-query correlation between 0.8 and 0.5 its half-width is
  about 0.03–0.05 overall and 0.06–0.10 on the 50-query Bulgarian slice
  (derived estimates, not measured). Both are as wide as the margins below or
  wider, so the rule must say what an undecided interval means rather than wait
  for one that is not.

**Proposed margin (owner to agree): 0.03 absolute recall@10 overall, and 0.05 on
the 50-query Bulgarian slice.** The rule puts the burden of proof on the larger
model, as D-L4-3 does ("keep the smaller unless recall@10 drops by more than the
margin"), and always ends in a verdict:

1. **Nemotron displaces a small candidate only on shown evidence**: the lower
   bound of the paired 95% interval of Δ exceeds the margin overall (> 0.03)
   **or** on the Bulgarian slice (> 0.05).
2. **Otherwise the small candidate stands.** A point Δ within the margin keeps
   it at once, however wide the interval.
3. **One growth step, and only one.** When a point Δ exceeds the margin on a
   slice but the interval's lower bound does not, the set grows once to 400
   pairs at the same composition (300 EN → EN, 50 BG → BG, 50 BG → EN; the
   Bulgarian slice becomes 100) and rule 1 is applied to the 400. That verdict
   is final: if the lower bound still does not clear the margin, the small
   candidate stands, and the record says the drop was not shown to exceed it.
4. **The pick.** Keep the smallest candidate (by parameters) that Nemotron does
   not displace; on a tie, the higher overall recall@10. Nemotron is chosen
   only if it displaces every small candidate, and only then does Q2 need a
   Nemotron engine.
5. **The record states the smallest drop the set could have shown**: the margin
   plus the interval's half-width, per slice. At 200 pairs that is about
   0.06–0.08 overall and 0.11–0.15 on the Bulgarian slice; at 400 about
   0.05–0.07 and 0.09–0.12 (derived estimates).

Rule 5 is the cost of a decision rule that always terminates: **a Bulgarian drop
between 0.05 and roughly 0.1 can go unseen and the small model kept.** If the
owner wants the Bulgarian margin closer to enforceable, the Bulgarian slice
needs about 200 queries of its own (a 350-pair set at the same EN size), which
brings the smallest drop it can show to about 0.08–0.10; that size is the
owner's call alongside the margin. The same rule applies,
separately, to the reranker on the fixed pool.

**Q2 — CPU latency and memory on the production VM (only for the candidates Q1
keeps, plus the Nemotron model only if it won Q1).**

- *How.* A dispatch-only workflow modelled on `VM capacity`
  (`.github/workflows/vm-capacity.yml`): `production` environment with its
  required reviewer, Workload Identity Federation, no key, logs holding model
  names and numbers only. It starts one temporary TEI CPU container at a pinned
  image digest, `--cpus 1.0` (the capacity budget's cap for a batch-shaped
  service) and a memory limit, on a private network with no published port,
  weights pulled at a pinned revision into a scratch volume whose checksum is
  printed; it removes the container and the volume afterwards. It refuses to
  start inside the nightly window (02:00–05:30 UTC) or when free memory is below
  the model's fp32 weights plus 1.5 GB. It is not a Compose change and leaves the
  stack as it found it.
- *Workloads* (20 warm-up, then 200 timed requests each, concurrency 1, client
  timing): **Q** one 20-token query (the interactive path; plus one run at
  concurrency 4); **P** 32 × 512-token passages in one request (indexing);
  **R** one query × 50 passages of 512 tokens on `/rerank` (Phase 2 bounds the
  reranker at 50). Reported: p50, p95, max, throughput, the container's
  `memory.peak`, and the host's CPU model and AVX2/AVX-512 flags — the CPU image
  sets `MKL_ENABLE_INSTRUCTIONS=AVX512_E4` (S3), and an E2 host's CPU platform
  is not fixed, so the record must say which CPU the numbers came from.
- *Proposed budgets (owner to agree):* Q p95 ≤ 250 ms and R p95 ≤ 2 s at 1.0
  CPU. P has no budget; its throughput sizes the nightly indexing window.
- *The Nemotron arm's engine.* If a Nemotron model wins Q1 by more than the
  margin, Q2 for it needs an engine TEI's CPU build does not provide (see 0.2):
  TEI's ORT backend with an NVIDIA ONNX export (Llama models only), or vLLM's
  CPU backend. That choice is deferred until Q1 says it matters.

## Decisions

- **The comparison runs quality first and latency second.** Under D-L4-3's rule
  the Nemotron engine question is moot unless Nemotron wins on recall, so the
  protocol does not pay for a CPU engine it may never ship.
- **The decision rule always terminates.** The first draft kept the small model
  on a point difference within the margin and also called any interval that
  straddled the margin inconclusive, growing the set to 400 with no step after
  that; at these set sizes nearly every outcome would have been both. Now the
  larger model must show its drop exceeds the margin, the set grows at most
  once, and the record states what size of drop it could have seen.
- **The candidates are multilingual.** An English-only small model would win the
  EN slice and fail the product's Bulgarian tenants; the BG slice has its own
  margin because it is a quarter of the set and noisier.
- **Unverified stays labelled.** With every model card unreachable, the
  temptation was to fill the table from memory. Each such cell says
  "unverified", and the facts that decide anything (TEI's CPU refusals,
  OpenMDW's grant, Llama's attribution term, pgvector's 2,000-dimension index
  limit) are quoted from code or licence text.
- **The roadmap's TEI-on-CPU premise holds only for the small candidates.** It
  does not hold for any current Nemotron model on TEI's native CPU backend; this
  note changes Phase 1's target from "Nemotron on TEI CPU" to "the D-L4-3 winner
  on TEI CPU", which is what D-L4-3 already implies.

## Master roadmap cells this note leaves stale

The master roadmap is edited by the coordinating change, not by this one, so
four of its cells still read as they did before the owner's decisions of
2026-11-11. Until that change lands they contradict the child document:

| Master cell | Reads | Should read |
| --- | --- | --- |
| Decision table, D-L4-1 | Weaviate (the target) | **decided 2026-11-11** (owner): pgvector first, in the existing Postgres under RLS; Weaviate only if a measured recall or latency floor is not met |
| Decision table, D-L4-2 | adopt | **decided 2026-11-11** (owner): vectors-only, no chunk text outside Postgres |
| Decision table, D-L4-3 | De-NIM retriever: open weights on CPU TEI … adopt | **decided 2026-11-11** (owner): benchmark Nemotron 1B embed/rerank against a small open model on CPU, keep the smaller unless recall@10 drops by more than the agreed margin; open weights on an open engine, never NIM. No current Nemotron model runs on TEI's CPU build (0.2) |
| Status board, Nemotron Retriever, completeness | 2, CPU TEI | 2, the D-L4-3 winner on CPU |

[`weaviate.md`](../ai-architecture/weaviate.md)'s Phase 0 boxes and its later
prompt ("decision D-L4-1 chose Weaviate") are rewritten by the knowledge-stack
re-plan of the same day, which owns that document.
