# The PII detector's image source (docs/ai-architecture/presidio.md).
#
# Phase 0: the analyzer configuration, the custom recognisers and their tests.
# The HTTP service (Phase 1.1) is not built yet, so this image has no
# entrypoint and is not in any Compose file. Python lives here and nowhere in
# the app (G5).
#
# Built from the repository ROOT, because the test stage reads the committed
# fixture corpus:
#
#     docker build -f guards/presidio/Dockerfile --target test .
#
# The base image is pinned by digest; the Python dependencies by version and
# the two spaCy model wheels by sha256 (requirements.txt).

FROM python:3.11-slim-bookworm@sha256:a83ba18aef0f865b1a4a611c2cf460fe446f2795673bbb9fe43be570439e3b39 AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY guards/presidio/requirements.txt ./requirements.txt
RUN pip install -r requirements.txt
COPY guards/presidio/inflect_pii ./inflect_pii
RUN useradd --system --uid 10001 --no-create-home presidio
USER presidio

FROM base AS test
USER root
COPY guards/presidio/requirements-test.txt ./requirements-test.txt
RUN pip install -r requirements-test.txt
COPY guards/presidio/tests ./tests
COPY tests/fixtures/pii/corpus.json tests/fixtures/pii/corpus.sha256 ./fixtures/
ENV PII_CORPUS_DIR=/app/fixtures
USER presidio
RUN python -m pytest -q -p no:cacheprovider tests
