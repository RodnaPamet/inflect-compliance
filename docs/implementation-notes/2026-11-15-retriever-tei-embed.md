# 2026-11-15 — Retriever 1.1a: the `tei-embed` image, and the service it serves

**Commit:** see the `claude/retriever-phase-1` branch (`feat(deploy): tei-embed …`).

## Design

Retriever Phase 1's seam (1.2–1.5: `src/lib/ai/embeddings/`, the
`AI_EMBED_LOCAL_*` variables, the residency routing, the in-deployment dial,
the metric) was already on `main`. The one open item was 1.1, the service
behind it. The upstream image fails the repository's Trivy bar (below), so the
owner decided (2026-11-15, option B on #5687) that the VM runs a patched copy
built here, and 1.1 became two steps, the two the harness scanner's image
took (#3790, #3793) before #5684 retired it:

- **1.1a, this change:** `deploy/tei-embed/Dockerfile` (the upstream digest
  plus `apt-get upgrade`), ci.yml's `TEI image` job (build, smoke, Trivy gate
  on every change to that directory) and `tei-embed-image.yml` (the same,
  then a push to `ghcr.io/rodnapamet/tei-embed`, weekly and on dispatch from
  `main`). No Compose file changes.
- **1.1b, the pin:** the `tei-embed` service enters the canonical Compose file
  pinned to a digest that workflow published, as the scanner overlay did in
  #3793 after #3790's workflow had published (and re-pinned in #5493). A
  dispatch needs the workflow on `main`, so the digest cannot exist in the
  pull request that adds the workflow.

The service 1.1b adds, as measured here:

```
app / worker ──(only while .env.prod sets AI_EMBED_LOCAL_*)──► http://tei-embed:8080/v1/embeddings
                                                                 │
          ghcr.io/rodnapamet/tei-embed (TEI cpu-1.9.4, upgraded; ONNX Runtime, 1.0 CPU, 2,560 MiB, read-only root)
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
| Upstream image (the Dockerfile's FROM) | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4@sha256:2538ea1c9640d3763b15af668039d24172d063b42337b0c27796fc2be180c78d` | GHCR, 2026-11-15: `cpu-1.9.4` and `cpu-1.9` both resolve to this index digest, the one the 2026-11-13 benchmark ran (`TEI_CPU_IMAGE`); no later release tag exists. amd64 manifest `sha256:8419f533…5726`, 13 layers, 228 MiB compressed |
| Model | `intfloat/multilingual-e5-small` at `614241f622f53c4eeff9890bdc4f31cfecc418b3` | the Hub's `main` on 2026-11-15, last modified 2026-04-02, before the benchmark resolved `main` on 2026-11-13, so the commit it measured. Pinned in `scripts/retriever-benchmark/candidates.ts` too; `tests/guards/tei-embed-image.test.ts` holds the smoke test's pin equal to it, and 1.1b's compose guard will hold the service's |
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

`aquasecurity/trivy-action@v0.36.0` on the upstream image, CRITICAL and HIGH:

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
images this repository builds (the application and, until #5684, the
scanner); no
third-party runtime image has been Trivy-gated, and G5 asks a digest of it.

## Files

| File | Role |
| --- | --- |
| `deploy/tei-embed/Dockerfile` | the upstream digest plus `apt-get upgrade`, and nothing else |
| `deploy/tei-embed/smoke.sh` | starts an image as production runs it (limits, hardening, pinned model) and requires a healthy container and a 384-dimension answer |
| `.github/workflows/tei-embed-image.yml` | build, smoke, gate, push by digest; weekly and on dispatch, `main` only; reports a newer upstream release and the pinned image's findings |
| `.github/workflows/ci.yml` | the `TEI image` job and its `tei_embed` path filter |
| `.github/dependabot.yml` | the `FROM` line watched weekly, on Mondays |
| `tests/guards/tei-embed-image.test.ts` | the Dockerfile's instruction set and FROM, the smoke test's model and hardening, the publish workflow's triggers, permissions and order, one gate in both places, and no upstream TEI image in any deploy Compose file |
| `tests/guardrails/security-gate-strictness.test.ts`, `publish-scans-before-push.test.ts`, `ci-check-requiredness-is-declared.test.ts`, `merge-queue-trigger-coverage.test.ts`, `ci-checks-unreachable-before-merge.json` (+ its key-order pin) | the new gate, push site and job registered where every image gate and CI job is |
| `scripts/retriever-benchmark/candidates.ts` | the chosen embedder's and reranker's revisions pinned |
| `docs/ai-architecture-roadmap.md` | D-L4-11 (the image's source and cadence); the Embeddings capacity line measured, the arithmetic recomputed, current state and board rows |
| `docs/ai-architecture/nemotron-retriever.md` | 0.1b and 0.6 ticked; 1.1 split into 1.1a (done) and 1.1b (the pin) |
| `docs/deployment.md` | the image, its two workflows, the service 1.1b adds, how the app is pointed at it, how to remove it |

## Decisions

- **The VM runs our image, never the upstream one** (owner, 2026-11-15). The
  upstream digest stays the FROM, so the engine is the one the benchmark ran;
  only Debian's packages move.
- **Two pull requests, the scanner's way.** A digest exists only after the
  workflow on `main` publishes, so the service cannot be in the change that
  adds the workflow without naming the unpatched image or none. The guard
  refuses the first everywhere; the second waits for 1.1b.
- **The CI job is path-filtered, unlike the scanner's was.** The scanner image held
  application modules, so its job runs on every pull request; this image's
  build context is `deploy/tei-embed/` alone, which is the retired Laya
  image's argument for its filter. New Debian fixes are the weekly
  rebuild's to find.
- **Weekly, and published.** A weekly build that only scanned would find fixes
  and leave nothing to pin. Each build is tagged
  `<upstream>-<date>-<commit>`, and the pin moves by pull request when a new
  build clears a finding the pinned one has (the run reports both) or after
  an upstream release.

- **The limit is 2,560 MiB, not the 1 GB estimate.** 1.5 times the highest
  measured `memory.peak` (1,664), rounded up to a multiple of 256, as C1b set
  `app` and `worker`. Under 1g TEI is killed while ONNX Runtime loads the
  model, before it serves anything. The figure is a runner's; the capacity
  recorder measures the VM once the service is applied, and that is what a
  re-size reads.
- **The plan no longer fits, though the file does.** With the measured line,
  the planned standing additions total 15,053 MiB, about 205 MiB over the
  14.5 GB line, and the reranker's 1.5 GB estimate is likely low by the same
  ratio. The canonical file plus `tei-embed`, at 1.1b, is 11,776 MiB. D-CAP-1 as decided
  applies at the first addition that would take the file over the line.
- **Weights from the Hub on first start, into a named volume, even now that
  the image is ours.** Baking them into the image would add 470 MB to every
  weekly build and pull and tie a model change to an engine rebuild; a
  host-staged directory would be host state outside the canonical set. The
  volume fetches once at a pinned commit, and the smoke test runs that commit.
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
