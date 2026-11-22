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
# GOSU IS REBUILT (2026-11-15). The upstream image's /usr/local/bin/gosu is a
# static Go binary built with Go 1.24.6, and Trivy reports 26 Go standard
# library findings in it with fixes available (1 CRITICAL, CVE-2025-68121, and
# 25 HIGH), which the repository's gate blocks on; the Alpine packages had
# none. gosu is not optional: docker-entrypoint.sh drops from root to the
# postgres user with `exec gosu postgres …` (and su-exec is a symlink to it),
# so it cannot simply be removed. The first stage compiles the same gosu
# release from source with a current Go, verified by commit, CGO off (as
# upstream builds it), and the second stage copies it over the upstream one.
# The Go toolchain never reaches the published image.
#
# The builder is pinned by tag AND digest, as every new image here is
# (tests/guardrails/runtime-image-pinning.test.ts). Go 1.27.4 (2026-11-10) is
# the current security release; 1.27.3 lacks its net/http fix, which the gate
# would report. Moving it is a reviewed diff; a weekly rebuild whose gate
# finds a newer Go fix fails, visibly, until it moves.
#
# ALPINE PACKAGES ARE UPGRADED AT BUILD (2026-11-22, #5790). The upstream
# 16-alpine image is rebuilt on Docker Hub's schedule, not Alpine's, so it can
# carry a package Alpine has already fixed: on 2026-11-22 it shipped libxml2
# 2.13.9-r2 while 3.24 had r3 for CVE-2026-86144 (HIGH), and the gate failed.
# `apk upgrade` in the final stage's one RUN takes every fix Alpine publishes
# on each build, the weekly rebuild included. The PostgreSQL server is not an
# apk (the upstream image compiles it into /usr/local), so it does not move.
#
# NOTHING ELSE CHANGES. No ENTRYPOINT, CMD, ENV, USER or config file of ours:
# the upstream entrypoint, its environment variables and the data directory
# behave exactly as they do in postgres:16-alpine.
# `tests/guards/postgres-pgvector-image.test.ts` holds the instruction set.
FROM golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf AS gosu-build

# gosu 1.19 (2025-09-23), the release the upstream image ships.
ARG GOSU_VERSION=1.19
ARG GOSU_COMMIT=6456aaa0f3c854d199d0f037f068eb97515b7513

RUN set -eux \
 && apk add --no-cache git \
 && git clone --quiet --depth 1 --branch "${GOSU_VERSION}" https://github.com/tianon/gosu.git /src/gosu \
 && test "$(git -C /src/gosu rev-parse HEAD)" = "${GOSU_COMMIT}" \
 && cd /src/gosu \
 && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "-d -w" -o /out/gosu . \
 && /out/gosu --version \
 && /out/gosu nobody true

FROM postgres:16-alpine

COPY --from=gosu-build /out/gosu /usr/local/bin/gosu

# v0.8.7 was released 2026-10-01. Iterative index scans (0.8.0+) are what the
# backend's filtered search relies on; its probe refuses anything older.
ARG PGVECTOR_VERSION=v0.8.7
ARG PGVECTOR_COMMIT=f37c13f68b57d2c3472b2214fbcff699d6d34876

RUN set -eux \
 && apk upgrade --no-cache \
 && apk add --no-cache --virtual .pgvector-build build-base git \
 && git clone --quiet --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && test "$(git -C /tmp/pgvector rev-parse HEAD)" = "${PGVECTOR_COMMIT}" \
 && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no \
 && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no install \
 && rm -rf /tmp/pgvector \
 && apk del --no-network .pgvector-build
