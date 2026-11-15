# 2026-11-15 — Every Postgres moves to the postgres-pgvector image (vector store 1.2)

**Commit:** `feat(deploy): every Postgres runs the postgres-pgvector line tag (vector store 1.2)`

The second step of the image change whose first step is
[`2026-11-15-postgres-pgvector-image.md`](2026-11-15-postgres-pgvector-image.md).
It can only go green after the owner's first dispatch of `Postgres pgvector
image` has published `ghcr.io/rodnapamet/postgres-pgvector:16-alpine` and the
package is public: every CI job with a Postgres service pulls it before its
first step.

## Design

One line moves in each of fourteen places: five Compose services and nine
workflow service containers. The guard is on the population, not on the
fourteen lines: every Compose service and every workflow `services:` or
`container:` image whose last path segment names Postgres or pgvector must be
exactly the line tag, and the official image may appear only as the FROM of
`deploy/postgres/Dockerfile`. The population is asserted by name (five
Compose services) and by count (nine workflow references in seven files), so
a reference the classifier stops seeing fails as loudly as one that points
elsewhere.

## Files

| File | Role |
| --- | --- |
| `deploy/docker-compose.prod.yml`, `docker-compose{,.prod,.staging,.test}.yml` | `postgres` (or `db`, `postgres-test`) on the line tag |
| `.github/workflows/{ci,agent-evals,dast,dast-full,garak,integration-stress,load-test}.yml` | Service containers on the line tag |
| `tests/guards/postgres-pgvector-image.test.ts` | The population rule and its detector proof |
| `tests/guardrails/runtime-image-pinning.test.ts` | `BASELINE` entry for our repository, the same reason as `postgres` |
| `tests/guards/compose-database-hardening.test.ts` | Recognises our image as a Postgres service |
| `docs/deployment.md` | The image, its patches, the recreate on apply, the rollback |
| `docs/ai-architecture/weaviate.md`, `docs/{ci-local,sizing,multi-region,slos}.md` | 1.2 ticked; the image named where the docs name it |

## Decisions

- **By the line tag, not a digest**, in CI as in production. D-L4-8 kept the
  2026-10-10 rule for this image, so `BASELINE` carries it with the same
  reason as `postgres`. A digest in CI alone would let CI and the VM test
  different bytes for a week at a time.
- **`postgres` stays in `BASELINE`**: it is still referenced, as the
  Dockerfile's base, which is exactly the reference the rule exists for.
- **No extension here.** The image change and the first `CREATE EXTENSION`
  are separate deploys, so a problem with the recreate cannot be confused with
  a problem with the migration, and a rollback of either leaves the other.
