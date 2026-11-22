# 2026-11-16 — Retriever 0.5a and 1.1c: `tei-embed` on the VM, timed, and the indexing batch

**Commit:** see the `claude/retriever-0-5-figures` branch (`docs(retriever): …`).

## Design

1.1b put the `tei-embed` service in the canonical Compose file on 2026-11-15
([`2026-11-15-retriever-tei-embed.md`](2026-11-15-retriever-tei-embed.md)). The
owner's `VM apply` put it on the VM the same day, and `VM check` `containers`
showed it healthy. That closes 1.1c. The service was then timed on the VM
with `VM check` `tei-embed-timing`, the embedder half of Phase 0.5. The
reranker half waits for its service (Phase 2).

The timing check (`deploy/vm-check/remote.sh`) `docker exec`s the image's own
curl inside the running container against its loopback port, and sends only
text the script generates, one request at a time. So the figures are the
service's own, at its real limits, sharing the VM with production.

This change records the figures and the two decisions the owner took from
them. It changes no runtime behaviour: `INDEX_EMBED_BATCH` has no caller until
the indexing job ([`weaviate.md`](../ai-architecture/weaviate.md) Phase 2.1)
is written.

## The figures

`VM check` `tei-embed-timing`, run 43757070861, 2026-11-15 23:33–23:38 UTC.

| What | Value |
| --- | --- |
| Host CPU | Intel Xeon @ 2.20 GHz, 2 vCPUs, AVX2 yes, AVX-512F no |
| `tei-embed` limits | 1.0 CPU (half weight), 2,560 MiB |
| Passage | 714 synthetic tokens, so the model reads 512 (`--auto-truncate`) |
| Query, 20 tokens, 20 calls | min 26.8 ms, p50 29.2, p95 37.5, max 37.8 |
| 8 × 512, 3 runs | 5.20 / 5.71 / 6.03 s (min / median / max) |
| 16 × 512, 3 runs | 10.76 / 11.40 / 11.79 s |
| 32 × 512, 3 runs | 21.30 / 22.48 / 58.08 s |
| 64 × 512, 3 runs | 41.81 / 42.91 / 44.17 s |
| Against `TEI_DEADLINE_MS` (15 s) | 8 and 16 within, 32 and 64 over |
| `memory.current` | 880 → 1,269 MiB (anonymous 858 → 1,240, file 7 → 13) |
| `memory.peak` | 1,601 MiB before and after: set earlier, not by this load |
| OOM kills | 0 |
| CPU | 293 s wall, 256.9 core-seconds used, 473 of 2,928 periods throttled, 3.0 s throttled |

Reading them:

- **A passage costs about 0.7 s whatever the batch size** (0.71, 0.71, 0.70
  and 0.67 s at the four medians). A larger batch buys no throughput. It only
  makes one call longer, and so closer to the deadline.
- **The 58.08 s run at 32 is contention, not the service.** It overlapped the
  `VM apply` preflight of run 43761627105 (23:33:57–23:37:07 UTC) on the same
  VM. That preflight ran `docker compose config` and `up -d --dry-run`, the ops
  agent's config validation, the capacity recorder's trial pass and caddy's
  validation. Its dry run resolved images at their registries but downloaded
  none (the dry run's own behaviour). The other two runs at 32, 21.30 and
  22.48 s, are over the deadline anyway, so the outlier changes no conclusion.
- **This VM is two to four times slower than the CI runners for this load.**
  The runners took 10.3–23.7 s for 64 passages; the VM took 41.8–44.2 s. The
  VM's CPU has no AVX-512F, which ONNX Runtime's kernels use where present.
- **The query path is fast.** p95 37.5 ms is inside the proposed, not agreed,
  250 ms budget (D-L4-10 leaves the latency budgets open).
- **Memory has room.** The load added about 390 MiB of anonymous memory and
  stayed under the earlier peak of 1,601 MiB, 63% of the limit.

## Decisions

Both are the owner's, 2026-11-15.

- **The indexing pipeline embeds 8 passages per call and keeps the 15 s
  deadline.** Recorded as a decision row in `weaviate.md` Phase 2 and as
  `INDEX_EMBED_BATCH = 8` in `src/lib/ai/embeddings/types.ts`, beside the
  seam's bound `MAX_EMBED_BATCH` (64), which is unchanged: the seam still takes
  up to 64, and the indexing caller sends 8. What the figures say about it: 8
  took at most 6.03 s, so the deadline is about 2.5 times its slowest run; 16
  fits, at 11.79 s, with little room; 32 and 64 do not fit. The room matters
  once the app's query embeddings, which will share the container's one CPU
  with the job, are switched on (`AI_EMBED_LOCAL_*` is unset today).
- **`tei-embed`'s `mem_limit` stays 2,560 MiB until a full day of the capacity
  recorder's data is read, on 2026-11-16 at 17:30 UTC.** 2,048 is the likely
  target. The figures above come from one serial load; the recorder's day
  covers the service's start and everything else the VM did that day.

## Files

| File | Role |
| --- | --- |
| `docs/ai-architecture/nemotron-retriever.md` | 0.5 split into 0.5a (done, with the figures) and 0.5b (the reranker, waiting); 1.1c and 1.1 ticked; Current state and the Phase 0 "done when" line brought up to date |
| `docs/ai-architecture/weaviate.md` | Phase 2 gains a Decisions table with the batch row, and its prompt names `INDEX_EMBED_BATCH` |
| `docs/ai-architecture-roadmap.md` | Layer 4's paragraph, the capacity row for `tei-embed` and the retriever's status row no longer say the service waits for an apply |
| `src/lib/ai/embeddings/types.ts` | `INDEX_EMBED_BATCH = 8`, documented with the run it came from |
| `tests/unit/ai/embedding-tei-provider.test.ts` | the indexing batch is 8, under the seam's bound, and a call of that size is sent whole |
