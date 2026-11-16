# The Ragas judge image for .github/workflows/rag-eval.yml (docs/ai-architecture/ragas.md 1.1).
#
# Never the app image (G5). The base is pinned BY DIGEST (python:3.12-slim, the
# same multi-arch index digest as .garak/Dockerfile and evals/inspect/Dockerfile)
# and EVERY Python dependency by exact version: requirements.lock is the whole
# resolved set, installed with --no-deps and checked with `pip check`, so the
# image cannot pick up a newer transitive release between two nights. (A
# floating resolution of ragas 0.4.3 broke on import in 2026: see the lock's
# header.)
#
# The judge holds no key: it reaches Anthropic only through the metering proxy
# on the runner's loopback (evals/cost-meter/anthropic-proxy.mjs), and TEI on
# loopback for answer_relevancy's embeddings. Ragas's usage analytics are off.
#
#   docker build --target test evals/rag     # the harness's own tests, a gate
#   docker build -t inflect-ragas:ci evals/rag
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS runtime

# ragas 0.4.3 (PyPI, 2026-01-13): the newest release more than two weeks old
# on 2026-11-16 (0.4.4 was published 2026-11-14).
ARG RAGAS_VERSION=0.4.3

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    RAGAS_DO_NOT_TRACK=true \
    DO_NOT_TRACK=1 \
    HF_HUB_DISABLE_TELEMETRY=1

WORKDIR /harness
COPY requirements.lock ./requirements.lock
RUN grep -qx "ragas==${RAGAS_VERSION}" requirements.lock \
    && pip install --no-deps -r requirements.lock \
    && pip check

COPY inflect_rag ./inflect_rag
RUN useradd --create-home --uid 10001 ragas
USER ragas
ENV PYTHONPATH=/harness
ENTRYPOINT ["python", "-m", "inflect_rag.run"]

FROM runtime AS test
USER root
RUN pip install "pytest==9.0.2"
COPY tests ./tests
COPY fixtures ./fixtures
USER ragas
RUN python -m pytest -q -p no:cacheprovider tests

FROM runtime
