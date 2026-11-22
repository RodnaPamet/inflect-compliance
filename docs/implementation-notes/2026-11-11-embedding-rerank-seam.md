# 2026-11-11 — The embedding and rerank seam (Layer 4, retriever Phases 1–2, seams only)

**Commits:** `feat(ai): embedding and rerank seam, residency-routed, behind safeFetch`;
`fix(ai): the embedding seam dials inside the perimeter and checks the served model`

## Design

`docs/ai-architecture/nemotron-retriever.md` Phases 1 and 2, without the
Compose service: the capacity rule (master § Capacity budget, G5) holds every
new container until C1 lands. So this adds the contracts, the routing, a real
client and a stub, and nothing deployable.

```
caller ──► select.ts ── residency ──► inflect-local/<model>  (operator env only)
             │  LOCAL_ONLY returns first          │
             │  unconfigured → named refusal,     ▼
             │  nothing constructed         tei-provider.ts  ── specifier re-check
             │                                    │             bounds, schema, dims,
             │                                    │             SERVED model = configured
             ▼                                    ▼
      (no external route exists)            http.ts ── perimeter.ts: every resolved
                                                       address inside, pinned, no
                                                       redirects; one deadline over
                                                       DNS + head + body, byte cap
```

- `types.ts`: `EmbeddingProvider.embed(texts, { inputType })` and
  `RerankProvider.rerank(query, passages, { topN })`. Every failure is a named
  `EmbeddingFailure`; nothing throws.
- `select.ts`: the only route is `inflect-local/<model>`, built from
  `AI_EMBED_LOCAL_*` / `AI_RERANK_LOCAL_*`. `LOCAL_ONLY` returns first; EXTERNAL
  reaches the same route because no external embedding provider exists (one
  would be a sub-processor, G2). The perimeter rule's structural half
  (`checkPerimeterUrl`) is asked when the route is chosen.
- `tei-provider.ts`: `POST /v1/embeddings`, and `GET /info` then `POST /rerank`.
  Exactly one vector per text at the configured dimension, every passage scored
  once, from the configured model, or the whole answer is refused.
- `perimeter.ts`: what counts as inside the deployment (RFC 1918, loopback,
  IPv6 ULA), structurally and over every resolved address.
- `http.ts`: the directory's only network call, pinned to the checked
  addresses.
- `stub-provider.ts`: feature-hashed vectors and word-overlap rerank, for tests
  and eval harnesses. Never chosen by the factory.
- `revision.ts`: `{ embeddingModel, rerankModel, chunker, k, alpha }` as a
  fixed-order JSON array.
- `rerank-fallback.ts`: bounds the pool to 50 and returns the hybrid order with
  the reason when the reranker cannot answer.
- `metrics.ts`: `embeddings.requests` and `embeddings.request.duration`,
  `{ provider, operation, outcome }`.

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/embeddings/*.ts` | The seam (above) |
| `src/env.ts` | Seven optional operator variables |
| `tests/unit/ai/embedding-*.test.ts` | Routing, provider/transport, perimeter, stub and revision |
| `tests/guards/ai-residency-enforcement.test.ts` | Pins the factory's constructor set and the `LOCAL_ONLY` return; refuses a direct import of the provider or transport outside the directory |
| `tests/guards/ssrf-egress-coverage.test.ts` | Not a `SINKS` entry (the local gateway's reason); holds that `http.ts` is the directory's only fetch, dials only through `perimeterFetch` after the perimeter resolution, pins it and refuses redirects; no `fetchImpl` seam |

## Decisions

- **Refuse, never stub.** A stub vector written into an index is a passage no
  real model can find again, and the row would not say so. An unconfigured
  route is a named refusal for every residency.
- **The perimeter, not `safeFetch`** (review fix, same branch). The first
  commit put the transport behind `safeFetch`, as G6's wording asks. But
  `safeFetch` admits only PUBLIC https addresses (the self-hosted CIDR
  allowlist is inert on hosted Inflect), so the only base URL that resolved
  `ok` was an off-perimeter one, and a `LOCAL_ONLY` tenant's passages would
  have left under the id `inflect-local` while the sub-processor guardrail
  triaged the variable as in-perimeter. That is the local AI gateway's case,
  already recorded in the SSRF guard: behind the public-address check the
  feature is deleted, not hardened. So the address test is inverted
  (`perimeter.ts`): inside means RFC 1918, loopback or IPv6 ULA; link-local
  (metadata), CGNAT and `0/8` are outside; metadata names are refused by name.
  Everything else `safeFetch` does is kept: checked again at use time over
  EVERY resolved address, the connection pinned to them, redirects refused,
  undici's own fetch and `Agent` together. `http:` is admitted because the
  Compose network is plaintext and the scheme was never the residency
  question. The base URL stays operator config, so this answers a residency
  question, not a tenant SSRF one.
- **The served model is checked, not assumed** (review fix). TEI serves one
  model per process and ignores (embeddings) or does not take (rerank) a
  `model` in the request, so a container swapped to another model of the same
  dimension answered `ok` under the configured id — and that id is what the
  retriever revision key, and so the evaluation record, are keyed on. Now an
  embeddings answer must name the configured model in its `model` field, and a
  rerank reads `/info` first and sends no passage unless `model_id` is the
  configured one. Absent counts as different (`SERVED_MODEL_MISMATCH`). The
  comparison is exact, so `AI_EMBED_LOCAL_MODEL` / `AI_RERANK_LOCAL_MODEL` must
  be the container's `--model-id`. The `/info` read is per call, not cached: a
  cache would be a window in which a swap goes unseen, and the call is local.
  `model_sha` is not compared yet; a re-pushed revision under one id is the
  residue, and Phase 2.4's evaluation record is the place to bind it.
- **No fetch seam.** Tests mock `undici` and `node:dns` at their modules, so
  the perimeter resolution and the pin run for real in them. A `fetchImpl`
  option would be a path around the address check that reads as dependency
  injection, and the guard refuses one.
- **One deadline over the whole call.** DNS resolution cannot be aborted by a
  signal, so every await is raced against one abort promise. A caller's own
  abort reports `ABORTED`, kept apart from `TIMEOUT`.
- **Prefixes are configuration, and absent means none.** The model is open until
  the Phase 0 benchmark (D-L4-3), so its query/passage prefixes cannot be a code
  default. An operator who configures an asymmetric model must set them; the
  Phase 1 recall check is what catches a wrong one. The prefixes are not part of
  the revision key the roadmap defines. Whether they should be is an open
  question for Phase 2.4.
- **The revision key names models, not routes**, so the Phase 3 CPU and GPU arms
  share one revision, as 3.4 requires.
- **No per-tenant override.** If one is ever added, it follows
  `aiLocalBaseUrl`'s rule (#4545).
