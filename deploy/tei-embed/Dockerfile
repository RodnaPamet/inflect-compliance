# tei-embed — Hugging Face Text Embeddings Inference (CPU), with its Debian
# packages brought up to date. Retriever Phase 1.1; owner decision 2026-11-15
# (option B on #5687).
#
# WHY THIS FILE EXISTS. The upstream image, pinned below, carries Debian 12
# packages with fixes available (4 CRITICAL and 13 HIGH on 2026-11-15, all in
# the base layer: perl-base, apt, pcre2, openssl, brotli; none in TEI itself).
# The repository's Trivy gate blocks on exactly that class, so the image the
# production VM runs is this one: the same TEI binary and ONNX Runtime, with
# `apt-get upgrade` applied, scanned before it is published
# (.github/workflows/tei-embed-image.yml) and pinned by digest in the
# canonical Compose file.
#
# NOTHING ELSE CHANGES. No ENTRYPOINT, CMD, ENV, USER or file of ours: the
# router's arguments live in deploy/docker-compose.prod.yml, and the model is
# fetched into a volume at a pinned Hub commit, never baked in.
# `tests/guards/tei-embed-image.test.ts` holds the instruction set.
#
# The FROM digest is the one the D-L4-3 benchmark ran (TEI_CPU_IMAGE in
# scripts/retriever-benchmark/candidates.ts); the guard holds the two equal.
# Moving it is a reviewed change to both, after a TEI release.
FROM ghcr.io/huggingface/text-embeddings-inference:cpu-1.10.0@sha256:f0a4bb206b9d4877746b5b9f638e138fe683eeb9787c14d541a12c993b562d86

# One layer: update, upgrade, and leave no package lists behind.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
