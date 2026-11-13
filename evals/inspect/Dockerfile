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
#
# One transitive dependency is pinned because the float broke the harness:
# inspect-ai 0.3.280 asks for agent-client-protocol>=0.12.0 with no upper bound,
# 1.0.0 removed `acp.helpers`, and every pass then died on import before a
# task ran (run 43348285803, 2026-11-13). 0.12.1 is the newest release that
# still ships it.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

ARG INSPECT_AI_VERSION=0.3.280
ARG AGENT_CLIENT_PROTOCOL_VERSION=0.12.1

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN pip install "inspect-ai==${INSPECT_AI_VERSION}" \
        "agent-client-protocol==${AGENT_CLIENT_PROTOCOL_VERSION}"

RUN useradd --create-home --uid 10001 inspect
WORKDIR /harness
COPY --chown=inspect:inspect task-set.json ./task-set.json
COPY --chown=inspect:inspect inflect_inspect ./inflect_inspect
# Inspect loads tasks.py by path, outside any package: the harness root must be
# importable for its absolute `inflect_inspect.*` imports.
ENV PYTHONPATH=/harness
USER inspect

ENTRYPOINT ["inspect"]
