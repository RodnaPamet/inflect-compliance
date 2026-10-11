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

# NOTE: HF_HUB_OFFLINE is deliberately NOT here. See the checkpoint layer below.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/opt/laya/hf \
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
#
# AND THE SYMLINK IS NOT A CONVENIENCE — see #3421. `laya-serve` does not read
# the repo this baked, and nothing can tell it to. `laya/router.py` resolves
# `multilingual` to `("convaiinnovations/laya", "multilingual")` — the BUNDLE
# repo — and the `STANDALONE_MODELS` map that names
# `convaiinnovations/laya-multilingual` is only selected by
# `Router(standalone_repos=...)`, a keyword `serve.py`'s `build_router()` never
# passes. So the server asked the Hub for a different repo at revision `main`,
# got `OfflineModeIsEnabled`, and exited during `create_app()`. The image had
# never started; the one container that ever served anything here had
# `HF_HUB_OFFLINE=0` passed at `docker run`, so it worked DESPITE this file.
#
# `snapshot_download` RETURNS the resolved directory, so the symlink follows
# ${LAYA_MODEL_REPO} and ${LAYA_MODEL_REVISION} with no string surgery. That
# matters: the Hub cache directory name is a transformation of the repo id
# (`models--convaiinnovations--laya-multilingual`), which `ENV` cannot perform,
# and a hardcoded path would rot silently the day either ARG changed.
RUN python -c "\
import os; \
from huggingface_hub import snapshot_download; \
p = snapshot_download('${LAYA_MODEL_REPO}', revision='${LAYA_MODEL_REVISION}'); \
os.symlink(p, '/opt/laya/checkpoint'); \
print('baked:', p)" \
 && chown -R laya:laya /opt/laya/hf /opt/laya/checkpoint

# OFFLINE FROM HERE, AND THIS ORDERING IS LOAD-BEARING.
#
# The first version of this file set `HF_HUB_OFFLINE=1` in the `ENV` block above,
# which made the one layer whose job is to reach the Hub the one layer forbidden
# from doing so. The build failed at the layer directly above with
# `LocalEntryNotFoundError: ... outgoing traffic has been disabled`, and no
# `--build-arg` could rescue it, because this is an `ENV` and `--build-arg` only
# reaches a declared `ARG`.
#
# So: the checkpoint is fetched with the network available, and the network is
# closed afterwards. Both halves are wanted — a container that downloads a model
# on boot behaves according to whatever the Hub serves that morning, which is the
# drift the canary exists to catch arriving one layer below where it can see it.
#
# DO NOT merge this back into the ENV block above to tidy it. That is exactly the
# edit that broke it, and `tests/guardrails/dockerfile-offline-ordering.test.ts`
# now fails if anything disables the network above a layer that fetches.
ENV HF_HUB_OFFLINE=1

# POINT THE SERVER AT WHAT WAS ACTUALLY BAKED (#3421).
#
# `LAYA_EXTRA_MODELS` is documented at `laya/serve.py:519-531` for exactly this:
# a JSON map of checkpoint name to source, where a source may be a Hub repo id
# OR A LOCAL CHECKPOINT DIRECTORY, and "a name that matches a bundled checkpoint
# re-points it". The local directory is the right side of that choice — a repo
# id would still resolve `main`, and this bake writes `snapshots/<sha>/` and
# leaves `refs/` EMPTY, so there is no `main` to resolve without a network. The
# directory IS the pin.
#
# `LAYA_MODELS` bounds what is preloaded. `serve.py:942` reads
# `_env_bool("LAYA_PRELOAD", True)` — preload defaults to ON — and
# `preload_names` is `None` when `LAYA_MODELS` is unset, which preloads ALL
# THREE checkpoints. Only one is baked. The comment below about `LAYA_PRELOAD=1`
# had the mechanism right and the DEFAULT wrong: not setting it does not avoid
# this.
ENV LAYA_MODELS=multilingual \
    LAYA_EXTRA_MODELS='{"multilingual":"/opt/laya/checkpoint"}'

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
# `/health`, OBSERVED. This was `/v1/models` — a path `laya-serve` does not
# serve — so the probe 404'd on every interval and the container could never
# report healthy. A local container built from this file logged a failing streak
# of 352, every entry `curl: (22) ... returned error: 404`, while `/health`
# returned 200 the whole time (#3420).
#
# That matters more than a wrong status badge: `deploy/docker-compose.prod.yml`
# uses `condition: service_healthy` in four places, so a Laya service written the
# way every other service here is written would have waited forever for a probe
# that cannot pass — a deploy that HANGS rather than fails.
#
# The full route list of the pinned version, from its own OpenAPI schema:
#   GET  /health
#   POST /v1/systemone
#   POST /v1/systemone/batch
# Kept as an ARG/ENV pair so an operator can repoint it if a later version moves
# the route, with the default being what the pinned version actually serves.
ARG LAYA_HEALTH_PATH=/health
ENV LAYA_HEALTH_PATH=${LAYA_HEALTH_PATH}
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${LAYA_PORT}${LAYA_HEALTH_PATH}" > /dev/null || exit 1

# PRELOAD IS ON, DELIBERATELY, and bounded by `LAYA_MODELS` above.
#
# This comment used to read "`LAYA_PRELOAD=1` would load all three checkpoints
# ... one checkpoint, loaded on demand", which had the mechanism right and the
# default exactly backwards: `serve.py:942` is
# `_env_bool("LAYA_PRELOAD", True)`, so preload was ALREADY on and `LAYA_MODELS`
# being unset made `preload_names` `None`, which means all three. That is one of
# the three reasons the image could not start (#3421).
#
# Leaving preload on is the better of the two fixes. The alternative — switching
# it off and loading on demand — would move the failure from boot to the first
# real adjudication request, where it arrives as a timeout inside a background
# job rather than as a container that refuses to come up. A ~1 GB checkpoint
# loading at boot is also why `HEALTHCHECK` carries `--start-period=120s`:
# measured, it reports healthy in about 30 seconds.
CMD ["laya-serve"]
