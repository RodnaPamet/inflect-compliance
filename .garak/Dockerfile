# The garak scanner image for .github/workflows/garak.yml.
#
# Python lives here and nowhere in the app (G5). The base image is pinned BY
# DIGEST (python:3.12-slim, the multi-arch index digest read from the
# registry on 2026-11-11) and garak by exact version; the workflow builds
# this image and runs garak inside it on the host network, so it reaches the
# target proxy on 127.0.0.1 and nothing else of the app.
#
# Residual, stated rather than hidden: garak's transitive dependencies are
# resolved at build time. Pinning them is a lock file with hashes, which is
# Phase 2 work beside the evaluation record (the record names the garak
# version and this file's digest so two nights stay comparable).
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

# garak 0.17.1 (PyPI, 2026-10-16). Wheel sha256:
# cef78a79291e73e90e7f89522f363ec9344bfb1e0ede68362d7a2379ba5cfda8
ARG GARAK_VERSION=0.17.1

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN pip install "garak==${GARAK_VERSION}"

# Not root: the scanner reads its config and writes its report, nothing else.
RUN useradd --create-home --uid 10001 garak
USER garak
WORKDIR /work

ENTRYPOINT ["python", "-m", "garak"]
