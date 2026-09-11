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
--  Measured history
--    origin/main @ 3.33.9      59 statements (53 ALTER TABLE)
--    after the schema-only reconcile (PR1, this file's introduction)
--                              41 statements (38 ALTER TABLE)
--    after PR2 (referential actions, DB-changing)   6 statements expected
--
--  ── GROUP 1 — 3 × DROP NOT NULL.  PERMANENT.  Not PR2's. ───────────
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
--  These three lines are expected to survive PR2 untouched.
--
--  ── GROUP 2 — 3 × pg_trgm GIN indexes.  PERMANENT.  Not PR2's. ─────
--  Control_code_trgm_idx / Control_name_trgm_idx /
--  Control_objective_trgm_idx are `USING gin (… gin_trgm_ops)`.  Prisma
--  cannot express an operator-class-qualified GIN index, so they cannot
--  be declared in prisma/schema at any cost; the diff therefore always
--  proposes dropping them and we always keep them.  Verify with
--      SELECT indexdef FROM pg_indexes WHERE indexname LIKE 'Control_%_trgm_idx';
--  These three lines are expected to survive PR2 untouched.
--
--  ── GROUP 3 — 16 tenant FKs, CASCADE in the DB vs RESTRICT in the
--     schema.  PR2 OWNS THESE (31 statements: 16 drops, 15 re-adds). ──
--  AccessReviewConnectedDecision, AgentActionReceipt,
--  AiSystemRequirementLink, BackgroundCheck, CompliancePostureSummary,
--  ConnectedIdentityAccount, Device, Employee, InboundQuestionnaire,
--  InboundQuestionnaireItem, QuestionnaireAnswerLibrary,
--  TenantDeviceToken, TrainingAssignment, TrainingCourse,
--  TrustCenterAccessRequest, TrustCenterDocument — each `tenantId → Tenant`,
--  measured `ON DELETE CASCADE` in the database and declared
--  `onDelete: Restrict` (Prisma's default for a required relation) in the
--  schema.  Verify with
--      SELECT conname, confdeltype FROM pg_constraint WHERE contype='f';
--  WHICH SIDE IS RIGHT IS NOT DECIDED HERE, and PR1 deliberately does not
--  guess.  It is a behavioural question about what a hard `DELETE FROM
--  "Tenant"` should do, and the evidence points both ways: `Tenant` itself
--  is soft-deleted and never auto-purged (docs/data-retention.md, the
--  `Tenant` row), which argues for refusing the hard delete — while the
--  same document describes several of these very children as "cascade on
--  tenant delete" (see its `AgentActionReceipt`, `AccessReviewConnectedDecision`
--  and `TrustCenterDocument` rows), which argues the database is already
--  correct and the schema's RESTRICT is the accident.  Settling it changes
--  either the DB or a documented policy, so it is reviewed on its own in
--  PR2.  Writing `onDelete: Cascade` into the schema here to zero this file
--  out would pre-empt that review with the side nobody has signed off.
--  CompliancePostureSummary appears as a drop with NO matching re-add:
--  the schema declares no relation there at all, so there is nothing for
--  the diff to re-create.  PR2 owns that reconciliation too.
--
--  ── GROUP 4 — 2 ControlException FKs, SET NULL in the DB vs RESTRICT
--     in the schema.  PR2 OWNS THESE (4 statements). ─────────────────
--  ControlException_compensatingControlId_tenantId_fkey and
--  ControlException_renewedFromId_tenantId_fkey.  Same shape of decision as
--  group 3 — what should happen to an exception whose compensating control
--  (or whose renewed-from predecessor) is deleted — so it belongs in the
--  same DB-changing PR, not here.
--
--  ── What is NOT in this file, because PR1 fixed it in the schema ────
--  7 @default clauses (5 statements), 2 plain-btree @@index declarations,
--  1 ALTER INDEX … RENAME TO (expressed with `map:`), and 6 referential-
--  action clauses where the DATABASE was right (AgentCircuitBreaker
--  .closedByUserId → Restrict; the inert NO ACTION clauses on
--  ProcessMapSnapshot ×3 and ReadinessSnapshot ×1).  59 − 41 = 18
--  statements, none of them a DB change.
-- ════════════════════════════════════════════════════════════════════
-- ==== EXPECTED RESIDUE BEGINS BELOW ====

-- DropForeignKey
ALTER TABLE "AccessReviewConnectedDecision" DROP CONSTRAINT "AccessReviewConnectedDecision_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AgentActionReceipt" DROP CONSTRAINT "AgentActionReceipt_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AiSystemRequirementLink" DROP CONSTRAINT "AiSystemRequirementLink_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "BackgroundCheck" DROP CONSTRAINT "BackgroundCheck_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "CompliancePostureSummary" DROP CONSTRAINT "CompliancePostureSummary_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ConnectedIdentityAccount" DROP CONSTRAINT "ConnectedIdentityAccount_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_compensatingControlId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_renewedFromId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Device" DROP CONSTRAINT "Device_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "InboundQuestionnaire" DROP CONSTRAINT "InboundQuestionnaire_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "InboundQuestionnaireItem" DROP CONSTRAINT "InboundQuestionnaireItem_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "QuestionnaireAnswerLibrary" DROP CONSTRAINT "QuestionnaireAnswerLibrary_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TenantDeviceToken" DROP CONSTRAINT "TenantDeviceToken_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TrainingAssignment" DROP CONSTRAINT "TrainingAssignment_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TrainingCourse" DROP CONSTRAINT "TrainingCourse_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TrustCenterAccessRequest" DROP CONSTRAINT "TrustCenterAccessRequest_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TrustCenterDocument" DROP CONSTRAINT "TrustCenterDocument_tenantId_fkey";

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
ALTER TABLE "AiSystemRequirementLink" ADD CONSTRAINT "AiSystemRequirementLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantDeviceToken" ADD CONSTRAINT "TenantDeviceToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewConnectedDecision" ADD CONSTRAINT "AccessReviewConnectedDecision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentActionReceipt" ADD CONSTRAINT "AgentActionReceipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlException" ADD CONSTRAINT "ControlException_compensatingControlId_tenantId_fkey" FOREIGN KEY ("compensatingControlId", "tenantId") REFERENCES "Control"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlException" ADD CONSTRAINT "ControlException_renewedFromId_tenantId_fkey" FOREIGN KEY ("renewedFromId", "tenantId") REFERENCES "ControlException"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedIdentityAccount" ADD CONSTRAINT "ConnectedIdentityAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingCourse" ADD CONSTRAINT "TrainingCourse_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundCheck" ADD CONSTRAINT "BackgroundCheck_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionnaireAnswerLibrary" ADD CONSTRAINT "QuestionnaireAnswerLibrary_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundQuestionnaire" ADD CONSTRAINT "InboundQuestionnaire_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundQuestionnaireItem" ADD CONSTRAINT "InboundQuestionnaireItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustCenterDocument" ADD CONSTRAINT "TrustCenterDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustCenterAccessRequest" ADD CONSTRAINT "TrustCenterAccessRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
