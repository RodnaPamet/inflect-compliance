# syntax=docker/dockerfile:1
#
# The Laya System One server, built by us from the first-party package.
#
# WHY WE BUILD THIS OURSELVES. Owner decision, 2026-10-10. Step 6d asks for an
# image pinned by DIGEST and a checkpoint pinned by REVISION, and neither
# candidate off the shelf gives both:
#
#   - the first-party `laya` package ships `laya-serve` but documents no
#     checkpoint-revision pinning, and publishes no image we could pin;
#   - `enlotec/laya-serve` pins the revision and publishes to GHCR, but has 0
#     stars, 0 forks and 9 commits, and would sit in the path of personal data
#     for exactly the tenants who chose LOCAL_ONLY for residency reasons.
#
# Building it ourselves buys a digest we control, a revision we set explicitly,
# and a provenance chain ending at the model's own publisher. It costs this
# file and a workflow.
#
# EVERY LINK IN THE CHAIN IS PINNED:
#   base image  -> digest below, resolved from the registry on 2026-10-10
#   package     -> laya[serve]==0.4.2 (Apache-2.0, requires_python >=3.10)
#   checkpoint  -> the revision below, resolved from the Hub on 2026-10-10
#
# The checkpoint is baked IN at build time rather than fetched at start-up. A
# container that downloads a model on boot is a container whose behaviour
# depends on the network and on whatever the Hub serves that morning — which is
# the drift the canary exists to catch, arriving one layer lower where the
# canary cannot see it.

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

# The checkpoint and its revision. Build args so a bump is a reviewed diff with
# the old value visible in it, rather than an edit inside a RUN line.
ARG LAYA_PACKAGE_VERSION=0.4.2
ARG LAYA_MODEL_REPO=convaiinnovations/laya-multilingual
ARG LAYA_MODEL_REVISION=1720e3e3357cfe1e281542e223f8273b0890ca34

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/opt/laya/hf \
    HF_HUB_OFFLINE=1 \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000

# `--no-install-recommends`, and the list is deliberately short: this image
# serves one HTTP endpoint and needs no shell tooling to do it. `curl` is here
# for the health check and nothing else.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Non-root. The server reads a baked checkpoint and writes nothing.
RUN useradd --system --create-home --uid 10001 laya \
 && mkdir -p /opt/laya/hf \
 && chown -R laya:laya /opt/laya

RUN pip install --no-cache-dir "laya[serve]==${LAYA_PACKAGE_VERSION}"

# THE CHECKPOINT, AT AN EXPLICIT REVISION.
#
# `snapshot_download(revision=...)` rather than letting the package resolve the
# model on first use: the package documents no revision pinning, so this is
# where the pin has to live. A bare repo id resolves to whatever `main` points
# at, and "this revision scored this on this corpus" is the whole claim an
# evaluation record makes — a floating checkpoint makes the record a statement
# about nothing.
RUN python -c "\
from huggingface_hub import snapshot_download; \
snapshot_download('${LAYA_MODEL_REPO}', revision='${LAYA_MODEL_REVISION}')" \
 && chown -R laya:laya /opt/laya/hf

USER laya
WORKDIR /opt/laya

# NO `EXPOSE`, and no published port in the Compose service either. The app and
# worker reach this over the Compose network only; 6d's hardening list requires
# that it is unreachable from outside.
#
# The health path is `/v1/models` per the design's wire table. The first-party
# package's own documentation lists `/models`, and that discrepancy is NOT
# resolved yet — see README.md. It is settled by the first real build, which is
# also the first moment anything can observe it.
ARG LAYA_HEALTH_PATH=/v1/models
ENV LAYA_HEALTH_PATH=${LAYA_HEALTH_PATH}
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${LAYA_PORT}${LAYA_HEALTH_PATH}" > /dev/null || exit 1

# `LAYA_PRELOAD=1` would load all three checkpoints; only the multilingual one
# is baked in, so preloading would reach the network and fail closed under
# `HF_HUB_OFFLINE`. One checkpoint, loaded on demand.
CMD ["laya-serve"]
