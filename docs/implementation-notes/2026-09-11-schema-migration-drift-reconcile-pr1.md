# 2026-09-11 — main's migrations do not reproduce main's schema (issue #2367, PR1: schema-only)

**Commit:** `<sha> fix(prisma): reconcile prisma/schema with what the migrations build (#2367)`

## The measurement

A Postgres 16 built from `prisma/migrations` alone (roles from
`prisma/init-roles.sh`, then `prisma migrate deploy`), diffed against
`prisma/schema`:

```
prisma migrate diff --from-config-datasource --to-schema prisma/schema --script
```

| | statements | of which ALTER TABLE |
| --- | --- | --- |
| origin/main @ 3.33.9 | 59 | 53 |
| after this PR | 41 | 38 |

Nothing in the Prisma toolchain compares those two artefacts, which is why 59
statements of disagreement had accumulated invisibly: `migrate deploy` applies
files, `migrate status` counts them, `validate` only parses the schema.

## Design

The owner's policy for this issue: **the database is the record of what
production actually does, so the default is to correct `prisma/schema` to
describe reality** — zero behavioural risk. Divergences where the schema's
intent is right and the DB is genuinely wrong are a separate, DB-changing PR
(PR2) reviewed on its own. This PR therefore carries **zero SQL migrations**.

Eighteen statements were removed by describing reality in the schema:

| what | statements | how |
| --- | --- | --- |
| 7 `@default` clauses the DB has and the schema did not | 5 | `@default([])` on six `String[]`; `@default("{}")` on `AgentActionReceipt.scannedSummary`, which is `jsonb DEFAULT '{}'::jsonb` — an empty OBJECT, so `@default([])` would have been the wrong shape |
| 2 plain-btree indexes the DB has and the schema did not | 2 | `@@index([evidenceFileRecordId])` on `AccessReview`, `@@index([tenantId, spDriveId, spItemId])` on `Policy` — both confirmed `USING btree` in `pg_indexes` before declaring them |
| 1 index whose DB name differs from Prisma's default | 1 | `map: "UserCalendarEventMapping_identity_key"` on the five-column `@@unique` |
| 5 FKs where the DB is right (7 newly declared clause tokens: 4 `onDelete` + 3 `onUpdate`) | 10 (5 drops + 5 re-adds) | `onDelete: Restrict` on `AgentCircuitBreaker.closedByUserId`; `NoAction` on the inert clauses of `ProcessMapSnapshot` ×3 and `ReadinessSnapshot` ×1 |

`AgentCircuitBreaker.closedByUserId` is the one where the DB's own migration
argues its case, and the schema comment now quotes it
(`20260906120000_agent_circuit_breaker`): *"RESTRICT, not CASCADE, and not SET
NULL. The name against a close is the evidence; deleting the user must not
silently erase who un-trapped an agent, and SET NULL would violate the
accountability CHECK above rather than fail loudly."* The schema had no
`onDelete`, so Prisma's default for an optional relation — `SetNull` — was
exactly what that comment forbids.

The `NoAction` group is `NO ACTION` in the DB versus `RESTRICT`/`CASCADE` in
the schema. `NO ACTION` and `RESTRICT` differ only for a DEFERRABLE
constraint, and this database has none:

```sql
SELECT count(*) FROM pg_constraint WHERE contype='f' AND condeferrable;  -- 0
```

The `ON UPDATE` halves are equally inert: every parent key here is an
immutable cuid.

## The gate

`scripts/check-fresh-db-schema-drift.mjs` (`npm run db:check-schema-drift`)
re-runs the diff and compares it against
`prisma/fresh-db-schema-drift.expected.sql`. It is wired into
`.github/workflows/ci.yml` as **`Gate: fresh-DB schema drift`**, immediately
after `prisma migrate deploy` in the `test` job — the only point where the
database is provably "what the migrations build" and nothing else.

It fails on any difference **in either direction**. A new statement means the
schema moved without a migration; a residue line that stops appearing means an
intentional divergence was "fixed", or the residue legitimately shrank and the
file was not updated in the same commit. Comparison is a multiset of
whitespace-normalised statements, so SQL comments carry the per-group prose and
a future Prisma release reordering its output does not turn CI red.

Exit codes split `mismatch` (1) from `unavailable` (2), following
`scripts/check-applied-migration-drift.mjs`: a check that could not run must
never read as one that ran and found nothing.

## Why the expected file is 41 lines and not empty

Six of the residue statements are PERMANENT:

- 3 × `DROP NOT NULL` on `User.emailHash`, `AuditorAccount.emailHash`,
  `UserIdentityLink.emailAtLinkTimeHash` — GAP-21, documented in
  `prisma/schema/auth.prisma` and pinned by the four-test ratchet
  `tests/guardrails/pii-hash-not-null.test.ts`. Dropping the `?` is exactly
  what that ratchet blocks.
- 3 × `DROP INDEX Control_*_trgm_idx` — `gin (… gin_trgm_ops)` is not
  expressible in Prisma at all.

The other 35 are PR2's: 16 tenant FKs that are `CASCADE` in the DB and
`RESTRICT` in the schema (31 statements), plus the 2 `ControlException` FKs
that are `SET NULL` in the DB (4). The file's header explains, per group, which
lines PR2 is expected to delete — so a reviewer seeing this gate go red on a
shrunk residue knows the fix is to update the file, not to revert.

## Decisions

- **No `prisma generate` in this PR, and no migration.** The only client-visible
  effect of the new `@default`s is that ONE field changes type (`scannedSummary`), across nine generated input types; the six
  `String[] @default([])` change the generated client not at all,
  which is a widening; nothing needed a code change.
- **The gate runs on all four test shards** rather than in a fifth job with its
  own Postgres. Four redundant ~2-second diffs buy the property that no shard
  can be green against a database that disagrees with the schema.
- **Group 3's prose does not take a side, deliberately.** The brief for this
  work described the 16 tenant CASCADEs as a case where the schema is right,
  citing the tenant soft-delete policy. `docs/data-retention.md` supports that
  for `Tenant` itself (soft-deleted, never auto-purged) but describes several of
  these very children as "cascade on tenant delete" (`AgentActionReceipt`,
  `AccessReviewConnectedDecision`, `TrustCenterDocument`). The evidence points
  both ways, so PR1 records the measurement and leaves the decision to the PR
  that changes behaviour.
- **`FK_INDEX_EXEMPT['AccessReview.evidenceFileRecordId']` was deleted** from
  `tests/guardrails/schema-index-coverage.test.ts` in the same diff. Declaring
  the index the DB already had made that exemption stale, and the guard's own
  "no stale entries" test named it — the repo rule is to delete the entry when
  the real index lands.
