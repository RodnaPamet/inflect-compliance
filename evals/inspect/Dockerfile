# The Inspect harness image for .github/workflows/agent-evals.yml.
#
# Never the app image (G5). The base is pinned BY DIGEST (python:3.12-slim,
# the same multi-arch index digest as .garak/Dockerfile) and inspect-ai by
# exact version (pyproject.toml). The workflow runs it on the host network so
# it reaches the CI test deployment on 127.0.0.1 and nothing else of the app.
#
# Residual, stated rather than hidden: inspect-ai's transitive dependencies are
# resolved at build time. The record names this image's digest, so two nights
# built from different resolutions are distinguishable.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

ARG INSPECT_AI_VERSION=0.3.280

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN pip install "inspect-ai==${INSPECT_AI_VERSION}"

RUN useradd --create-home --uid 10001 inspect
WORKDIR /harness
COPY --chown=inspect:inspect task-set.json ./task-set.json
COPY --chown=inspect:inspect inflect_inspect ./inflect_inspect
USER inspect

ENTRYPOINT ["inspect"]
