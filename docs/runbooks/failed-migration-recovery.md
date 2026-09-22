# Recovering a half-applied migration

**This is judgement, not a command.** The wrong recovery looks exactly like the
right one and puts the app straight back into the crash loop. Read the whole
page before running anything.

## The symptom

```
Error: P3009
migrate found failed migrations in the target database, new migrations will not be applied.
```

`scripts/entrypoint.sh` runs `prisma migrate deploy` on every container start,
so the container exits, Docker restarts it, and it fails identically —
indefinitely. On 2026-09-20 this kept production down for ~25 hours (#2745).

## Detection

Nonzero exactly when the app cannot start:

```sql
SELECT count(*) FROM _prisma_migrations
WHERE finished_at IS NULL AND rolled_back_at IS NULL;
```

Cheap enough to run anywhere, and it is the query behind
`npm run db:check-failed-migration`.

## Trap 1 — `applied_steps_count` lies

The failed row said:

```
applied_steps_count = 0
finished_at         = NULL
rolled_back_at      = NULL
```

`applied_steps=0` reads as "nothing was applied". **It was wrong.** The
database actually held:

| statement | state |
|---|---|
| `ALTER TYPE "WorkflowStepKind" ADD VALUE 'MODEL_CALL'` | **applied** |
| `ALTER TYPE "WorkflowStepKind" ADD VALUE 'TOOL_CALL'` | **applied** |
| `ALTER TABLE "AgentProposal" ADD COLUMN "runId","stepSeq"` | **applied** |
| `CREATE INDEX "AgentProposal_tenantId_runId_idx"` | missing |
| `ADD CONSTRAINT "AgentProposal_runId_tenantId_fkey"` | missing |
| `ADD CONSTRAINT "AgentProposal_step_requires_run"` | missing |

**Never trust the counter. Verify every statement against the live catalogue**
— `pg_enum`, `information_schema.columns`, `pg_constraint`, `pg_indexes`.

## Trap 2 — `pg_constraint` does not show every unique

A unique created as `CREATE UNIQUE INDEX` appears in `pg_indexes` and **not**
in `pg_constraint`. Checking only the latter produces a confident false
negative. It did here, and briefly suggested the migration could never succeed.
Check both.

## Trap 3 — the April precedent is the wrong one

`20260422180000_enable_rls_coverage` was resolved with `--rolled-back` in
April. Following that here would have been **wrong**.

- `--rolled-back` makes Prisma **re-run the migration from the top**.
- `ALTER TYPE ... ADD VALUE 'MODEL_CALL'` against an enum that already
  contains it **fails**.
- Back into the loop.

The April migration was genuinely un-applied. This one was not, and
`applied_steps_count` did not distinguish them.

> `--applied` when the work is done. `--rolled-back` **only** when genuinely
> nothing landed — and you have checked the catalogue, not the counter.

## The recovery that worked

1. Enumerate the migration's statements and check each against the live
   catalogue. Write down which applied.
2. **Dry-run the remaining statements inside `BEGIN … ROLLBACK`** before
   applying anything. This is the step that turns a guess into a fact.
3. Apply the remaining statements.
4. `prisma migrate resolve --applied <migration_name>`.
5. Restart the app and confirm the migration count advanced.

Production went 297 → 302 migrations and the app came up healthy.

## Preventing the next one

`ALTER TYPE ... ADD VALUE` commits in a way that does not roll back with the
surrounding transaction, and Prisma wraps a migration in one. So any migration
mixing an enum addition with other DDL can land in exactly this state.

Two valid shapes, and `tests/guardrails/migration-enum-isolation.test.ts`
enforces them for new migrations:

```sql
-- 1. idempotent, so a --rolled-back re-run survives
ALTER TYPE "K" ADD VALUE IF NOT EXISTS 'X';

-- 2. or the addition lives in its OWN migration, so a partial failure
--    lands on a boundary where --applied/--rolled-back mean what they say
```

The repo already writes the idempotent form 57 times against 24 bare ones; the
guard makes the habit binding rather than optional. Nine historical migrations
carry the old shape and are grandfathered by name — they are applied in
production, and editing an applied migration changes its checksum, which breaks
`migrate deploy` everywhere that already ran it.

## Related

- #2745 — the outage, and why nothing alerted
- #2746 — this runbook and the guard
- `infra/alerts/external-uptime.yml` — the alert that now fires when the app
  stops answering
