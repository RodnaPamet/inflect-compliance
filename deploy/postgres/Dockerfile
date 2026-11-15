# postgres-pgvector — the official PostgreSQL 16 Alpine image plus the pgvector
# extension, compiled against the image's own server headers. Vector store
# Phase 1.1 (docs/ai-architecture/weaviate.md); owner decisions D-L4-1
# (pgvector first, 2026-11-11) and D-L4-8 (patch cadence, 2026-11-12).
#
# WHY THIS FILE EXISTS. The official postgres:16-alpine build ships the core
# server and contrib, not pgvector, so `CREATE EXTENSION vector` fails on every
# Postgres the repository runs. The images that do carry pgvector
# (pgvector/pgvector) are Debian: moving the production data volume from musl
# to glibc changes how text sorts, and every text index would need a rebuild.
# This image keeps the same base, the same musl and the same collation, so the
# existing `pgdata` volume mounts unchanged.
#
# THE BASE STAYS ON THE TAG, NOT A DIGEST (owner decision 2026-10-10, kept by
# D-L4-8): a digest pin would freeze the security patches the alpine tag
# delivers. A built image freezes them anyway unless it is rebuilt, so
# .github/workflows/postgres-pgvector-image.yml rebuilds it weekly and whenever
# the upstream 16-alpine digest moves, and republishes a moving line tag
# (ghcr.io/rodnapamet/postgres-pgvector:16-alpine) plus an immutable per-build
# tag for rollback.
#
# PGVECTOR IS PINNED BY TAG AND COMMIT. The clone is refused unless the tag
# resolves to the commit named here, so a moved tag cannot change what is
# compiled. OPTFLAGS="" builds for the generic x86-64 target instead of the
# build runner's CPU (pgvector's default is -march=native, which can SIGILL on
# another machine); with_llvm=no skips the JIT bitcode, which would need the
# image's clang and LLVM. The toolchain is removed in the same layer, so no
# compiler or git reaches the published image.
#
# NOTHING ELSE CHANGES. No ENTRYPOINT, CMD, ENV, USER or config file of ours:
# the upstream entrypoint, its environment variables and the data directory
# behave exactly as they do in postgres:16-alpine.
# `tests/guards/postgres-pgvector-image.test.ts` holds the instruction set.
FROM postgres:16-alpine

# v0.8.7 was released 2026-10-01. Iterative index scans (0.8.0+) are what the
# backend's filtered search relies on; its probe refuses anything older.
ARG PGVECTOR_VERSION=v0.8.7
ARG PGVECTOR_COMMIT=f37c13f68b57d2c3472b2214fbcff699d6d34876

RUN set -eux \
 && apk add --no-cache --virtual .pgvector-build build-base git \
 && git clone --quiet --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && test "$(git -C /tmp/pgvector rev-parse HEAD)" = "${PGVECTOR_COMMIT}" \
 && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no \
 && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no install \
 && rm -rf /tmp/pgvector \
 && apk del --no-network .pgvector-build
