# 2026-11-15 — The postgres-pgvector image (vector store 1.1)

**Commit:** `feat(deploy): build, gate and publish the postgres-pgvector image (vector store 1.1)`

Owner decisions in force: **D-L4-1** (2026-11-11, pgvector first, in the
existing Postgres under RLS) and **D-L4-8** (2026-11-12, the self-built image
keeps the 2026-10-10 tag rule, rebuilt weekly and on every upstream digest
move, as a moving line tag plus an immutable per-build tag). Roadmap:
[`docs/ai-architecture/weaviate.md`](../ai-architecture/weaviate.md) Phase 1.1.

## Design

```
deploy/postgres/Dockerfile        FROM postgres:16-alpine (tag)
                                  + pgvector v0.8.7 @ f37c13f6 (clone, commit checked)
                                  make OPTFLAGS="" with_llvm=no; toolchain removed in the layer
deploy/postgres/smoke.sh          musl? no gcc/cc/make/git? CREATE EXTENSION vector = 0.8.7?
                                  cosine nearest by seq scan AND by HNSW with iterative scans?

ci.yml `Postgres image`           every PR/push touching deploy/postgres/, the workflow,
                                  .trivyignore or ci.yml: build → smoke → Trivy gate
postgres-pgvector-image.yml       main only
  decide                          upstream postgres:16-alpine digest vs the published line
                                  tag's org.opencontainers.image.base.digest label;
                                  build on dispatch, on Wednesdays, or when they differ;
                                  report a newer pgvector release
  build-scan-push                 build FROM exactly that digest → smoke → Trivy gate →
                                  push :16-alpine-pgvector0.8.7-<yyyymmdd>-<sha9>, then :16-alpine
```

This change publishes nothing by itself and moves no reference. The image
reaches anything only through the next two acts:

1. **The owner dispatches `Postgres pgvector image` from `main`** once this has
   merged. The run publishes the line tag and the first per-build tag. The
   GHCR package is created by that first push; the VM pulls without a registry
   login (as it does `tei-embed`), so the package is set public once.
2. **1.2's pull request** moves every Postgres reference (the canonical
   Compose file, the four root Compose files, the seven workflows' service
   containers) to `ghcr.io/rodnapamet/postgres-pgvector:16-alpine`, with a
   `BASELINE` entry in `tests/guardrails/runtime-image-pinning.test.ts` and a
   guard that every Postgres reference is that image. Its CI is the first run
   of every job against the published image.

## Files

| File | Role |
| --- | --- |
| `deploy/postgres/Dockerfile` | The image: the upstream tag plus pgvector, nothing else |
| `deploy/postgres/smoke.sh` | The smoke test both workflows run before a gate and a push |
| `.github/workflows/postgres-pgvector-image.yml` | `decide` then `build-scan-push`, main only |
| `.github/workflows/ci.yml` | `postgres_image` path filter and the `Postgres image` job |
| `tests/guards/postgres-pgvector-image.test.ts` | Holds the instruction set, the pins, the cadence, the step order and the gate |
| `tests/guardrails/publish-scans-before-push.test.ts` | Names the new push site |
| `tests/guardrails/security-gate-strictness.test.ts` | The CI gate blocks on CRITICAL,HIGH |
| `tests/guardrails/merge-queue-trigger-coverage.test.ts`, `tests/guards/ci-check-requiredness-is-declared.test.ts`, `tests/guardrails/ci-checks-unreachable-before-merge.json`, `tests/guardrails/contended-json-format.test.ts` | The new jobs' queue skip, requiredness and reachability, declared |
| `docs/ai-architecture/weaviate.md` | 1.1 ticked; Current state; D-L4-8 in the decision row |

## Decisions

- **Two steps, as tei-embed's image took (#5687, then #5702).** A CI service
  container is pulled before any step runs, so it cannot reference an image
  that has never been published, and the publishing workflow runs only from
  `main`. Moving the references in this pull request would turn every
  integration shard red until somebody published from an unmerged branch,
  which the workflow refuses to do. The image and its gates land first.
- **The base is the tag, the build is the digest.** The Dockerfile names
  `postgres:16-alpine` (the 2026-10-10 rule, which D-L4-8 kept), and the
  publishing build resolves that name to the exact digest `decide` read
  (`build-contexts`). So the `org.opencontainers.image.base.digest` label is
  true of the bytes, and the next day's comparison is against what was built,
  not against what the tag happened to resolve to a minute later.
- **Two crons rather than one clever one.** Wednesday's rebuild is
  unconditional, so Alpine fixes that do not move the upstream tag still get a
  fresh compile on a known day; the daily run rebuilds only on a moved digest.
  `decide` tells them apart by `github.event.schedule`, and the guard holds
  that the string it compares is the workflow's own weekly cron.
- **An unreadable upstream digest fails the run; an unreadable published
  label rebuilds.** The first is a registry problem somebody should see. The
  second is the state before the first publish (and after a label-less
  build), where rebuilding is the safe answer.
- **pgvector is pinned by tag AND commit.** A tag can be moved upstream; the
  build refuses unless `v0.8.7` resolves to `f37c13f6`. Moving to a new
  release is a reviewed diff of both lines; the weekly run reports a newer
  release, as tei-embed's reports a newer TEI.
- **`OPTFLAGS=""`.** pgvector defaults to `-march=native`, which compiles for
  the CPU of the GitHub runner that built it; on the VM's CPU that can be an
  illegal instruction at the first distance computation. `with_llvm=no` skips
  the JIT bitcode, which would need the image's clang and LLVM in the build.
- **gosu is rebuilt, not removed.** The first CI run built the image, found
  zero vulnerabilities in the Alpine packages, and failed the gate on
  `/usr/local/bin/gosu`: a static binary upstream builds with Go 1.24.6,
  carrying 26 Go standard-library findings with fixes (1 CRITICAL,
  CVE-2025-68121, 25 HIGH). The image's `docker-entrypoint.sh` drops from
  root to `postgres` with `exec gosu postgres …`, and `su-exec` is a symlink
  to `gosu`, so it is load-bearing and cannot be deleted. A first stage
  (`golang:1.27.4-alpine`, tag and digest, as every new image is pinned)
  compiles the same release, gosu 1.19, refused unless the tag resolves to
  commit `6456aaa0`, with `CGO_ENABLED=0` and upstream's `-ldflags "-d -w"`,
  and the final stage copies it over the upstream binary. Go 1.27.4 rather
  than the older 1.27.3 because 1.27.4 is a security release (an `net/http`
  fix) that the gate would otherwise report. No `.trivyignore` entry.
  The smoke test reads the builder's Go version from the Dockerfile and
  refuses a `gosu --version` that names another, so the upstream binary
  fails it, and checks that `su-exec` still links to `gosu` and that `gosu
  postgres id -un` answers `postgres`. Verified locally: the build compiles
  and reports `1.19 (go1.27.4 on linux/amd64; gc)`, and an image of
  `postgres:16-alpine` with that binary copied in starts through the
  upstream entrypoint and passes every gosu check.
- **No `apk upgrade`.** Unlike tei-embed, whose upstream carried unfixed
  Debian packages, `postgres:16-alpine` is rebuilt upstream as Alpine ships
  fixes, and the daily digest check follows it within a day. Upgrading
  packages here would make the image differ from upstream in ICU and libc
  versions the collation reasoning depends on.
- **The smoke test checks what the move to production depends on**: musl
  (the volume's collation), no toolchain (the layer discipline), the pinned
  extension version, and a cosine query through HNSW with
  `hnsw.iterative_scan` (0.8.0+, which the backend's filtered search sets).
  It was run locally against `postgres:16-alpine` and fails at `CREATE
  EXTENSION vector`, as it should; its SQL was run against a local Postgres 16
  with pgvector 0.8.7 and returns `east 0.994`, `east` through the HNSW index.
  The image itself could not be built in the authoring sandbox (the Alpine
  package CDN is refused there), so its first build is CI's.

## Rollback

Nothing runs the image until 1.2, so reverting this change removes a workflow
and a CI job and nothing else. After a publish, the package can be left in
place: a line tag nobody references is inert.
