# 2026-11-11 — The embedding and rerank seam (Layer 4, retriever Phases 1–2, seams only)

**Commit:** `feat(ai): embedding and rerank seam, residency-routed, behind safeFetch`

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
             │                                    │             bounds, schema, dims
             ▼                                    ▼
      (no external route exists)            http.ts ── safeFetch, one deadline over
                                                       DNS + head + body, byte cap
```

- `types.ts`: `EmbeddingProvider.embed(texts, { inputType })` and
  `RerankProvider.rerank(query, passages, { topN })`. Every failure is a named
  `EmbeddingFailure`; nothing throws.
- `select.ts`: the only route is `inflect-local/<model>`, built from
  `AI_EMBED_LOCAL_*` / `AI_RERANK_LOCAL_*`. `LOCAL_ONLY` returns first; EXTERNAL
  reaches the same route because no external embedding provider exists (one
  would be a sub-processor, G2). The egress policy's structural half
  (`checkWebhookUrl`) is asked when the route is chosen.
- `tei-provider.ts`: `POST /v1/embeddings` and `POST /rerank`. Exactly one vector
  per text at the configured dimension, every passage scored once, or the whole
  answer is refused.
- `http.ts`: the directory's only network call.
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
| `tests/unit/ai/embedding-*.test.ts` | Routing, provider/transport, stub and revision |
| `tests/guards/ai-residency-enforcement.test.ts` | Pins the factory's constructor set and the `LOCAL_ONLY` return; refuses a direct import of the provider or transport outside the directory |
| `tests/guards/ssrf-egress-coverage.test.ts` | Registers `http.ts` as a sink; no other file in the directory fetches; no `fetchImpl` seam |

## Decisions

- **Refuse, never stub.** A stub vector written into an index is a passage no
  real model can find again, and the row would not say so. An unconfigured
  route is a named refusal for every residency.
- **`safeFetch`, as G6 and the step require — and it does not admit the planned
  topology.** `safeFetch` refuses `http:` and private addresses, so
  `http://tei-embed:80` on the Compose network is refused. It is refused at route
  selection, by name (`EMBED_ENDPOINT_REFUSED_BY_EGRESS_POLICY`), rather than at
  every call. The alternative, the bare operator-URL `fetch` that
  `ai/risk-assessment/local-provider.ts` uses for `AI_LOCAL_BASE_URL`, would
  have bypassed G6 without anyone deciding it. Phase 1.1 has to settle this:
  TLS plus the self-hosted CIDR allowlist, or an owner decision on a transport
  for operator-held in-network hosts.
- **No fetch seam.** Tests mock `safeFetch` at its module. A `fetchImpl` option
  would be a path around the SSRF defence that reads as dependency injection,
  and the guard refuses one.
- **One deadline over the whole call.** DNS resolution inside `safeFetch` cannot
  be aborted by a signal, so every await is raced against one abort promise. A
  caller's own abort reports `ABORTED`, kept apart from `TIMEOUT`.
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
