# 2026-11-15 — Retriever 1.1: the `tei-embed` service

**Commit:** see the `claude/retriever-phase-1` branch (`feat(deploy): tei-embed …`).

## Design

Retriever Phase 1's seam (1.2–1.5: `src/lib/ai/embeddings/`, the
`AI_EMBED_LOCAL_*` variables, the residency routing, the in-deployment dial,
the metric) was already on `main`. The one open item was 1.1, the service
behind it, so this change is a Compose service and nothing in the app:

```
app / worker ──(only while .env.prod sets AI_EMBED_LOCAL_*)──► http://tei-embed:8080/v1/embeddings
                                                                 │
                         TEI cpu-1.9.4 (ONNX Runtime, 1.0 CPU, 2,560 MiB, read-only root)
                                                                 │
                                       tei-embed-data volume ◄── huggingface.co, first start only
                                       (onnx/model.onnx + tokenizer, 465 MiB, commit 614241f6)
```

The app-side switch is the existing one: the factory refuses by name while
`AI_EMBED_LOCAL_BASE_URL` / `_MODEL` / `_DIMENSIONS` are unset (G9), so no new
variable, client module or sub-processor triage entry was needed. The five
variables are already classified in `tests/guardrails/sub-processor-coverage.test.ts`
as the deployment's own service.

## The pins

| What | Pin | Read |
| --- | --- | --- |
| Image | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4@sha256:2538ea1c9640d3763b15af668039d24172d063b42337b0c27796fc2be180c78d` | GHCR, 2026-11-15: `cpu-1.9.4` and `cpu-1.9` both resolve to this index digest, the one the 2026-11-13 benchmark ran (`TEI_CPU_IMAGE`); no later release tag exists. amd64 manifest `sha256:8419f533…5726`, 13 layers, 228 MiB compressed |
| Model | `intfloat/multilingual-e5-small` at `614241f622f53c4eeff9890bdc4f31cfecc418b3` | the Hub's `main` on 2026-11-15, last modified 2026-04-02, before the benchmark resolved `main` on 2026-11-13, so the commit it measured. Pinned in `scripts/retriever-benchmark/candidates.ts` too, and the compose guard holds the two equal |
| Reranker (for Phase 2) | `BAAI/bge-reranker-base` at `2cfc18c9415c912f9d8155881c133215df768a70` | the Hub's `main`, last modified 2024-06-24; pinned in the benchmark candidates only |

**Licence (0.1b).** Neither model's Hub repository carries a licence file:
`LICENSE`, `LICENSE.txt` and `LICENSE.md` are 404 at each pinned commit. Each
model card's front matter declares `license: mit` (README at the pinned
commits: SHA-256 `0038de97…9c1c` for the embedder, `b4223c8c…366d` for the
reranker, whose card also says "The released models can be used for
commercial purposes free of charge"). The MIT text is the publishers' code
repositories' `LICENSE`, read on 2026-11-11 (sources S8 and S9 of the
[Phase 0 note](2026-11-11-retriever-phase0-facts.md)).

**Weights (0.6).** TEI's CPU build serves through ONNX Runtime, so what it
fetches and reads is `onnx/model.onnx`, not `model.safetensors`. The volume
after a first start holds 465 MiB:

| File (Hub path at the pinned commit) | Bytes | SHA-256 (LFS) or git blob id |
| --- | ---: | --- |
| `onnx/model.onnx` | 470,268,510 | `ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665` |
| `tokenizer.json` | 17,082,730 | `0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39` |
| `config.json` | 655 | git `60a2a84020f1d74cc53ea9e8c4e91cf4af6c2b68` |
| `1_Pooling/config.json` | 200 | git `acbd4014202bf4dbc6c03229bcbeef7c4feafb58` |
| `sentence_bert_config.json` | 57 | git `4eca68d85ecd3034cf4174d8a4033a75344ea62d` |
| `tokenizer_config.json` | 443 | git `059214673d9d6d2ee319411e2ffec8c024b816d5` |

The two large files' SHA-256 were recomputed from the volume and match the
Hub's LFS ids.

## The measurement

This session's network reached neither the Hub nor a container registry's blob
store, so the facts were read by a temporary, read-only workflow on a scratch
branch that was never merged (`zz-tei-embed-facts-tmp.yml`, runs 43701146074,
43701610106, 43701762359 and 43702239517, on `claude/retriever-tei-facts-tmp`, which carries that one file and runs only on a push to itself). Each variant ran the
service's exact flags at `--cpus 1.0 --cpu-shares 512` on a GitHub-hosted
runner, then a one-query embed 50 times and five 64-passage batches of
512-token passages (English and Bulgarian text).

| Variant | Healthy after | Start peak | Peak after load | Anon / file | 64 × 512 batch, p50 |
| --- | ---: | ---: | ---: | --- | ---: |
| 1g, no hardening | **OOM-killed (137) while loading** | — | — | — | — |
| 4g | 10 s | 1,590 | 1,655 | 1,171 / 465 | 16.6 s |
| 4g, read-only + tmpfs | 9 s | 1,589 | 1,600 | 1,118 / 465 | 23.1 s |
| 4g, capabilities dropped | 12 s | 1,590 | 1,664 | 1,180 / 465 | 10.3 s |
| 4g, pids limit 256 | 12 s | 1,590 | 1,661 | 1,177 / 465 | 19.6 s |
| 4g, all of it (as shipped) | 12 s | 1,592 | 1,659 | 1,165 / 465 | 23.3 s |
| 4g, heavier load (30 × 32 and 10 × 64 passages) | 14 s | 1,590 | 1,627 | — | 22.8 s (32: 11.4 s) |

MiB; "healthy after" includes the 465 MiB fetch. A one-query embed was 8–12 ms
at p50. The batch times vary with the runner's CPU (one was an AMD EPYC 7763
with AVX2 and no AVX-512), not the flags. TEI's ONNX backend serves at most 8
requests at once (`max_batch_requests=8`, its own warning at start); one
request still carries up to 64 inputs.

**A recreate does not reach the Hub.** With the volume filled, the service
recreated at its shipped limit (2,560m) and hardening with `--network none` was
healthy in 7 s and answered `/v1/embeddings` (run 43702239517).

## The Trivy result

`aquasecurity/trivy-action@v0.36.0` on the pinned image, CRITICAL and HIGH:

| | fixed upstream | fix deferred / will not fix / affected |
| --- | ---: | ---: |
| CRITICAL | 4 | 2 |
| HIGH | 13 | 111 |

At the repository's own gate settings (`ignore-unfixed: true`) that is **17
findings, every one a Debian 12.15 package of the base layer**: `perl-base`
(CVE-2026-13221, -42496, -8376 CRITICAL; -42497, -48962, -57432, -57433 HIGH),
`libbrotli1` (CVE-2026-111497 CRITICAL), `apt` / `libapt-pkg6.0`
(CVE-2026-109518), `libpcre2-8-0` (four), and `openssl` / `libssl3` /
`libssl-dev` (CVE-2026-84782, DTLS). Trivy found no language-package finding:
TEI is one Rust binary plus ONNX Runtime. The repository's Trivy gate covers the
images this repository builds (the application and the scanner); no
third-party runtime image has been Trivy-gated, and G5 asks a digest of it.

## Files

| File | Role |
| --- | --- |
| `deploy/docker-compose.prod.yml` | the `tei-embed` service and its volume |
| `tests/guards/deploy-compose-canonical.test.ts` | nine services, `tei-embed` batch-shaped and in the budget, and its own block: digest and revision equal to the benchmark's, batch size at least the seam's, no port, no Caddy site, no secrets, not Watchtower's, named volume, hardening, healthcheck, nothing depends on it |
| `scripts/retriever-benchmark/candidates.ts` | the chosen embedder's and reranker's revisions pinned |
| `docs/ai-architecture/nemotron-retriever.md` | 0.1b, 0.6 and 1.1 ticked; current state |
| `docs/ai-architecture-roadmap.md` | the Embeddings capacity line measured, the arithmetic recomputed, current state and board rows |
| `docs/deployment.md` | the service, how it reaches the VM, how the app is pointed at it, how to remove it |

## Decisions

- **The limit is 2,560 MiB, not the 1 GB estimate.** 1.5 times the highest
  measured `memory.peak` (1,664), rounded up to a multiple of 256, as C1b set
  `app` and `worker`. Under 1g TEI is killed while ONNX Runtime loads the
  model, before it serves anything. The figure is a runner's; the capacity
  recorder measures the VM once the service is applied, and that is what a
  re-size reads.
- **The plan no longer fits, though the file does.** With the measured line,
  the planned standing additions total 15,053 MiB, about 205 MiB over the
  14.5 GB line, and the reranker's 1.5 GB estimate is likely low by the same
  ratio. The canonical file plus `tei-embed` is 11,776 MiB. D-CAP-1 as decided
  applies at the first addition that would take the file over the line.
- **Weights from the Hub on first start, into a named volume.** Baking them
  into a repo-built image would add a build pipeline and 470 MB to every pull;
  a host-staged directory would be host state outside the canonical set. The
  volume fetches once at a pinned commit, and the guard refuses a service
  without `--revision`.
- **The default network, not a network of its own** (the roadmap said
  `app`/`worker` network only). A second network on `app` and `worker` changes
  the two containers Watchtower recreates, on the request path, for a service
  that is off; and an `internal` network would refuse the first start's fetch.
  Like `postgres`, `redis` and `clamav`, it publishes no port.
- **Hardened as the scanner overlay is**, because each setting was measured to
  change nothing: read-only root with `/tmp` on tmpfs (TEI writes only there
  and to `/data`), every capability dropped, `no-new-privileges`, a pids limit.
- **The seam's deadline was not changed.** A 64-passage batch of 512-token
  passages took 10.3–23.7 s on one runner core against `TEI_DEADLINE_MS`
  (15 s). Nothing calls the seam yet; the indexing job (weaviate Phase 2) sets
  its batch size or the deadline against the VM's own figures.
