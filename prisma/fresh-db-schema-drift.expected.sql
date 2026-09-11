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
--    after the referential-action reconcile (PR2)
--                              10 statements
--    after the #2356 SET NULL carve-out (this file's current state)
--                              26 statements
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
--  ── GROUP 3 — 20 × column-scoped SET NULL FKs.  PERMANENT. ────────
--  Ten tenant-carrying composite FKs whose referential action is
--  `ON DELETE SET NULL (<the fk column>)` in the database, and which the
--  schema can only imply as RESTRICT.
--
--  WHY THE DATABASE AND THE SCHEMA DISAGREE ON PURPOSE.  Each of these is
--  an OPTIONAL pointer between two tenant-scoped models, so the FK carries
--  `tenantId` to make a cross-tenant reference unrepresentable (#2356).
--  Postgres SET NULL over a multi-column FK nulls EVERY referencing column
--  — including `tenantId`, which is NOT NULL — so the parent delete aborts
--  with SQLSTATE 23502.  Postgres 15+ fixes that with a column list:
--      ON DELETE SET NULL ("compensatingControlId")
--  which nulls only the pointer.  PRISMA'S DSL CANNOT EXPRESS A COLUMN
--  LIST, and with a required `tenantId` in the FK it renders RESTRICT.  So
--  the diff will always propose replacing the column-scoped constraint
--  with a RESTRICT one, and we will always refuse — exactly like group 2,
--  and permanently for the same reason: not a disagreement anybody can fix
--  in prisma/schema, but a shape the DSL has no syntax for.
--
--  DO NOT "CLOSE" THIS BY WRITING `onDelete: SetNull` IN THE SCHEMA.
--  Prisma rejects SetNull once a required field joins the FK, and if it did
--  not, it would emit the whole-row form — the 23502 these migrations exist
--  to remove.  DO NOT close it by switching the database to RESTRICT
--  either: that would not preserve behaviour, it would move the failure.
--  The data-lifecycle sweep (src/app-layer/jobs/data-lifecycle.ts) hard
--  deletes parents row by row with no try/catch, so one refusal stops the
--  sweep for every soft-delete model after it.
--
--  The two ControlException members arrived with
--  20260911120000_controlexception_setnull_column_scoped, the other eight
--  sites with 20260911160000_tenant_fks_setnull_column_scoped.  Both
--  migrations assert `pg_constraint.confdelsetcols` in a post-condition
--  rather than `confdeltype`, because plain and column-scoped SET NULL are
--  BOTH `confdeltype = 'n'` — only the column list tells them apart, so a
--  silently-degraded ALTER cannot ship green.  Verify with
--      SELECT conname, confdeltype, confdelsetcols FROM pg_constraint
--       WHERE contype = 'f' AND confdelsetcols IS NOT NULL;
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
ALTER TABLE "AccessReview" DROP CONSTRAINT "AccessReview_evidenceFileRecordId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AssetVulnerability" DROP CONSTRAINT "AssetVulnerability_remediationTaskId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_compensatingControlId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_renewedFromId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_assetId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_fileRecordId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_taskId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "FileRecord" DROP CONSTRAINT "FileRecord_previousFileRecordId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskSuggestionItem" DROP CONSTRAINT "RiskSuggestionItem_assetId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ScannerFinding" DROP CONSTRAINT "ScannerFinding_assetId_tenantId_fkey";

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
ALTER TABLE "AssetVulnerability" ADD CONSTRAINT "AssetVulnerability_remediationTaskId_tenantId_fkey" FOREIGN KEY ("remediationTaskId", "tenantId") REFERENCES "Task"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScannerFinding" ADD CONSTRAINT "ScannerFinding_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReview" ADD CONSTRAINT "AccessReview_evidenceFileRecordId_tenantId_fkey" FOREIGN KEY ("evidenceFileRecordId", "tenantId") REFERENCES "FileRecord"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlException" ADD CONSTRAINT "ControlException_compensatingControlId_tenantId_fkey" FOREIGN KEY ("compensatingControlId", "tenantId") REFERENCES "Control"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlException" ADD CONSTRAINT "ControlException_renewedFromId_tenantId_fkey" FOREIGN KEY ("renewedFromId", "tenantId") REFERENCES "ControlException"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_taskId_tenantId_fkey" FOREIGN KEY ("taskId", "tenantId") REFERENCES "Task"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_fileRecordId_tenantId_fkey" FOREIGN KEY ("fileRecordId", "tenantId") REFERENCES "FileRecord"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileRecord" ADD CONSTRAINT "FileRecord_previousFileRecordId_tenantId_fkey" FOREIGN KEY ("previousFileRecordId", "tenantId") REFERENCES "FileRecord"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskSuggestionItem" ADD CONSTRAINT "RiskSuggestionItem_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
