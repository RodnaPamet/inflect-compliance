-- ════════════════════════════════════════════════════════════════════
--  EXPECTED residue of `prisma migrate diff` between a database built
--  ONLY from prisma/migrations and prisma/schema.  Issue #2367.
--
--  Produced by, and compared by:
--      npm run db:check-schema-drift            (scripts/check-fresh-db-schema-drift.mjs)
--  Gated in CI by "Gate: fresh-DB schema drift" in .github/workflows/ci.yml,
--  immediately after `prisma migrate deploy`.
--
--  READ THIS BEFORE EDITING.  The gate fails on any difference in EITHER
--  direction — a statement the diff produces that is not listed here, and
--  a statement listed here that the diff no longer produces.  The second
--  direction is deliberate: it catches an intentional divergence being
--  quietly "fixed".  It also means the PR that removes a group below MUST
--  delete those lines here in the same commit.  A SHRINKING file is the
--  intended direction of travel, not a regression.
--
--  ADDING a line here is the one edit that can hide a real defect, so
--  tests/guardrails/schema-drift-gate-runs-in-ci.test.ts refuses any
--  statement that is not one of the three shapes below.  Widening this
--  file is not a way to make new drift pass.
--
--  Measured history
--    origin/main @ 3.33.9      59 statements (53 ALTER TABLE)
--    after the schema-only reconcile (PR1, #2410)
--                              41 statements (38 ALTER TABLE)
--    after the referential-action reconcile (PR2, this file's current state)
--                              10 statements
--    floor, once GROUP 3 below is settled                     6 statements
--
--  ── GROUP 1 — 3 × DROP NOT NULL.  PERMANENT. ───────────────────────
--  User.emailHash, AuditorAccount.emailHash and
--  UserIdentityLink.emailAtLinkTimeHash are NOT NULL in the database and
--  optional (`String?`) in the schema, ON PURPOSE.  The reasoning is
--  written in the GAP-21 comment on `User.emailHash` in
--  prisma/schema/auth.prisma ("The schema-DB drift on this single field is
--  intentional and documented"), the NOT NULL comes from migration
--  20260429000000_gap21_drop_pii_plaintext_columns, and the four-test ratchet
--  tests/guardrails/pii-hash-not-null.test.ts pins it: dropping the `?`
--  from the schema is exactly what that ratchet blocks.  So the diff will
--  always want to relax the column, and we will always refuse.
--
--  ── GROUP 2 — 3 × pg_trgm GIN indexes.  PERMANENT. ─────────────────
--  Control_code_trgm_idx / Control_name_trgm_idx /
--  Control_objective_trgm_idx are `USING gin (… gin_trgm_ops)`.  Prisma
--  cannot express an operator-class-qualified GIN index, so they cannot
--  be declared in prisma/schema at any cost; the diff therefore always
--  proposes dropping them and we always keep them.  Verify with
--      SELECT indexdef FROM pg_indexes WHERE indexname LIKE 'Control_%_trgm_idx';
--
--  ── GROUP 3 — 2 ControlException FKs.  OPEN — DO NOT CLOSE THIS BY
--     DECLARING `onDelete: SetNull` IN THE SCHEMA. ──────────────────
--  ControlException_compensatingControlId_tenantId_fkey and
--  ControlException_renewedFromId_tenantId_fkey are ON DELETE SET NULL in
--  the database and imply RESTRICT in the schema.  The SET NULL is the
--  authored intent — migration 20260507140000_epic_g5_control_exceptions
--  says so at the constraint: "SetNull on cascade so deleting the prior row
--  doesn't shred the renewal record (the audit log carries the lineage)."
--
--  BUT THE DATABASE DOES NOT DO THAT.  Both are COMPOSITE FKs on
--  (<fk column>, tenantId), and the constraint carries no SET NULL column
--  list (pg_constraint.confdelsetcols IS NULL), so Postgres nulls EVERY
--  referencing column — including `tenantId`, which is NOT NULL.  The
--  delete therefore cannot succeed; it raises
--      null value in column "tenantId" of relation "ControlException"
--      violates not-null constraint
--  Reproduced on a shadow database built from these migrations.
--
--  This is reachable, not theoretical: src/app-layer/jobs/data-lifecycle.ts
--  purges soft-deleted rows with `DELETE FROM "Control" WHERE "id" = $1`,
--  and `Control` is in SOFT_DELETE_MODELS — so the scheduled sweep throws
--  the first time it reaches a control that any ControlException names as
--  its compensating control.
--
--  So neither side is currently right, and writing `onDelete: SetNull` into
--  prisma/schema would zero these four lines out while making the schema
--  assert a behaviour the database provably cannot perform.  Settling it
--  needs a DB-changing migration — either the Postgres 15+ column-list form
--      ON DELETE SET NULL ("compensatingControlId")
--  which Prisma cannot express (so these lines become PERMANENT, like
--  group 2), or ON DELETE RESTRICT, which matches the schema and drops
--  these four lines but changes behaviour.  That is a product decision
--  about what deleting a compensating control should do, and it is filed
--  rather than guessed.
--
--  ── What is NOT in this file, because it was fixed in prisma/schema ──
--  PR1 (#2410): 7 @default clauses (5 statements), 2 plain-btree @@index
--  declarations, 1 ALTER INDEX … RENAME TO (`map:`), and 6 referential-
--  action clauses where the DATABASE was right.  59 − 41 = 18.
--  PR2 (this change): the 16 tenant FKs that are ON DELETE CASCADE in the
--  database and were silently RESTRICT in the schema, because 15 of them
--  simply omitted `onDelete:` and took Prisma's default for a required
--  relation, and CompliancePostureSummary declared no relation at all.
--  All 16 are documented "cascade on tenant delete" in docs/data-retention.md
--  (lines 51, 54, 84, 125, 128-139), the CASCADE is written by hand in each
--  creating migration, and 26 sibling models already declared it — so the
--  schema was the side that was wrong.  41 − 10 = 31, and none of it is SQL.
-- ════════════════════════════════════════════════════════════════════
-- ==== EXPECTED RESIDUE BEGINS BELOW ====

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_compensatingControlId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_renewedFromId_tenantId_fkey";

-- DropIndex
DROP INDEX "Control_code_trgm_idx";

-- DropIndex
DROP INDEX "Control_name_trgm_idx";

-- DropIndex
DROP INDEX "Control_objective_trgm_idx";

-- AlterTable
ALTER TABLE "AuditorAccount" ALTER COLUMN "emailHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "emailHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "UserIdentityLink" ALTER COLUMN "emailAtLinkTimeHash" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ControlException" ADD CONSTRAINT "ControlException_compensatingControlId_tenantId_fkey" FOREIGN KEY ("compensatingControlId", "tenantId") REFERENCES "Control"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlException" ADD CONSTRAINT "ControlException_renewedFromId_tenantId_fkey" FOREIGN KEY ("renewedFromId", "tenantId") REFERENCES "ControlException"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
