# 2026-09-19 — the shared test DB drifts behind main, and now the run refuses (#2640)

**Commit:** `1b0510016 test(setup): refuse a run against a test DB that is behind this branch`

## Design

`tests/setup/globalSetup.ts` skips `prisma migrate deploy` whenever `CI=1`, and
the repo convention is that every local run sets `CI=1` — because a migrate
fired from one worktree lands on a database four parallel sessions share. That
guard is correct and is untouched.

Its consequence is structural rather than anyone's mistake:

> Every session behaving correctly guarantees the shared DB falls behind, and
> nothing owns catching it up.

The only path that advances the shared database is the `else` branch nobody is
supposed to take. So the database advances when a human notices it is stale —
i.e. after it has already caused a failure. It did, for two days, by one
migration (`20260917170000_agent_risk_assessment_stale_notification`, from
#2563), and the failure did not look like a stale database. It looked like a
broken feature:

```
invalid input value for enum "NotificationType": "AGENT_RISK_ASSESSMENT_STALE"
```

Four tests of a feature that was fine. One session diagnosed it as a product
defect.

### The shape: an outcome, and three of them

`checkTestDbMigrationDrift()` in `tests/helpers/db.ts` compares the migration
directories on this branch against the rows of `_prisma_migrations` that
describe a migration this database actually ran (`finished_at IS NOT NULL AND
rolled_back_at IS NULL`). It returns one of three statuses, and the third is
the point:

| status | meaning | globalSetup's response |
| --- | --- | --- |
| `behind` | a migration on this branch was never applied here | **throws** — the run exits non-zero |
| `current` | every migration on this branch is applied | one log line, run proceeds |
| `unknown` | the check DID NOT RUN | warns loudly, run proceeds |

`unknown` covers an unreachable database, an unparseable URL, an unreadable
`prisma/migrations`, an empty migration list, an empty history (a
`prisma db push` database keeps none), and a `_prisma_migrations` read that
threw. Reporting any of those as `behind` would block the DB-free CI job and
every offline run; folding them into `current` would let the alarm go quiet,
which is the defect itself.

A fourth case is deliberately not a refusal: a database holding a migration
this branch does not carry is `ahead`, which is the normal state of a machine
running several branches at once, and is already owned by
`npm run db:check-migration-drift` (a different class — migrations edited
*after* being applied).

### Why it refuses rather than warns

Issue #2640 offered warn-and-proceed as option 1; its follow-up comment
sharpened it to fail loudly, and that is what shipped. A warning printed into
Jest's startup noise is only marginally better than silence — it scrolls past,
and the failure it predicted still arrives later in an unrelated suite wearing
a product defect's clothes. The issue's own acceptance criterion is that the
failure mode is silence, so a fix that can go quiet has not fixed it. A setup
that exits non-zero cannot go quiet.

### Blast radius

`globalSetup` runs before every suite in the repo, so the check is bounded on
every axis: one short-lived connection, one read of ~300 rows, no transaction,
no lock, no write, `connectionTimeoutMillis` and `query_timeout` both 5 s. It
sits *after* the migrate branch, so a non-CI run that just migrated
successfully is current by construction. The concurrent-run lock is released
before the throw, because a throw from `globalSetup` skips `globalTeardown`
and the next run should be refused by a live run, never by a corpse.

## Files

| File | Role |
| --- | --- |
| `tests/helpers/db.ts` | `compareMigrations` (pure), `migrationsOnDisk`, `migrationDriftRefusal`, `checkTestDbMigrationDrift` |
| `tests/setup/globalSetup.ts` | the call site: warn on `unknown`, release-then-throw on `behind` |
| `scripts/catchup-test-db.ts` | `npm run db:test:catchup` — the named owner the job never had |
| `package.json` | the `db:test:catchup` script |
| `tests/unit/test-setup-refuses-drifted-db.test.ts` | executes `globalSetup` with a faked helper; the mutation target |
| `tests/unit/test-db-migration-drift.test.ts` | the pure comparison and every `unknown` cause |
| `tests/integration/test-db-migration-drift.test.ts` | the live-Postgres proof that the SQL reads a real history |

## Decisions

- **The tests live in `tests/unit` and `tests/integration`, not `tests/guards`.**
  They execute the subject rather than asserting on its source text, and a
  source-text guard could not tell a `throw` from a `console.warn` that a
  future refactor is about to introduce. Zero files were added under
  `tests/guards` / `tests/guardrails`, whose count is capped at `< 700`.
- **The call-site test fakes `../helpers/db`, not the detector.** The
  regression to catch is not "the check computes the wrong answer" — it is a
  caller that logs the answer and carries on, which is exactly as silent as no
  check. So the assertion is on what `globalSetup` DOES with each outcome, and
  the mutations that prove it are at that call site: softening the `throw` into
  a `console.warn` (3 failed / 4 passed / 7 total) and deleting the call
  entirely (4 failed / 3 passed / 7 total).
- **The refusal's "not written" assertion is the marker file.** Asserting only
  that it rejects would survive a caller that logged and continued to a later
  throw. The per-worker marker write is the next thing `globalSetup` does, so
  its absence is what proves nothing proceeded.
- **`db:test:catchup` imports `getBaseTestDatabaseUrl` and `migrateTestDb`
  rather than re-deriving the URL.** An independent resolver would be a second
  source of truth for "which database do the tests use", and the first thing it
  could do is disagree with the refusal that sent you there.
- **Query parameters are stripped before handing the URL to `pg`.**
  `?schema=` is a Prisma connection parameter, not a `pg` one;
  `adminConnectionString()` drops them for the same reason, and
  `scripts/check-applied-migration-drift.mjs` has its own list. A database
  whose history genuinely lives in another schema lands in `unknown`, which is
  the safe side.
- **The empty-history case was the easiest one to get wrong.** Zero migrations
  on disk means zero can be missing, so a naive implementation reports
  "current" for a database it never looked at — a vacuous pass of exactly the
  kind this change exists to prevent. Both empty denominators (`prisma/migrations`
  and `_prisma_migrations`) are `unknown`.
