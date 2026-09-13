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
--  ── GROUP 3 — 49 × column-scoped SET NULL FKs.  PERMANENT. ────────
--  Tenant-carrying composite FKs whose referential action is
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
--  It would emit the whole-row form — the 23502 these migrations exist to
--  remove.
--
--  CORRECTION, measured 2026-09-13 while adding batch 2: this used to say
--  "Prisma rejects SetNull once a required field joins the FK".  It does
--  NOT.  `prisma validate` on a composite FK carrying a required `tenantId`
--  with `onDelete: SetNull` prints a WARNING — "should not be set to
--  SetNull when a referenced field is required" — and then reports the
--  schema VALID.  The guard is the consequence above, not a refusal by the
--  toolchain: nothing stops someone writing it, and the only thing that
--  would tell them is this paragraph.  DO NOT close it by switching the database to RESTRICT
--  either: that would not preserve behaviour, it would move the failure.
--  The data-lifecycle sweep (src/app-layer/jobs/data-lifecycle.ts) hard
--  deletes parents row by row with no try/catch, so one refusal stops the
--  sweep for every soft-delete model after it.
--
--  The two ControlException members arrived with
--  20260911120000_controlexception_setnull_column_scoped, the next eight
--  with 20260911160000_tenant_fks_setnull_column_scoped, and ten more with
--  20260913000000_tenant_fks_composite_batch2, and the last NINETEEN with
--  20260913020000_tenant_fks_setnull_batch3b — which exhausts #2356's
--  measured population apart from the four Control sites split to #2532.
--  Nine of those nineteen declared `onDelete: SetNull`; the other ten
--  declared nothing and took Prisma's default for an OPTIONAL relation,
--  which IS SetNull, so all nineteen were already SET NULL in the database.
--  Treating "(default)" as "no action to preserve" would have converted ten
--  live behaviours to RESTRICT.  Batch 2 re-measured first
--  (67 single-column FKs between tenant-scoped models; 14 targets already
--  composite-capable, of which only TEN are safe) and excluded the four
--  pointing at `Control`, whose `tenantId` is NULLABLE — a composite FK
--  there would make a tenant-scoped child unable to reference a GLOBAL
--  library control.  See that migration's header.  Both
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
ALTER TABLE "AccessReviewConnectedDecision" DROP CONSTRAINT "AccessReviewConnectedDecision_connectedAccountId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AccessReviewDecision" DROP CONSTRAINT "AccessReviewDecision_membershipId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AgentActionReceipt" DROP CONSTRAINT "AgentActionReceipt_auditLogId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AiDecisionLog" DROP CONSTRAINT "AiDecisionLog_aiSystemId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AssetVulnerability" DROP CONSTRAINT "AssetVulnerability_remediationTaskId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Audit" DROP CONSTRAINT "Audit_auditCycleId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditPackShareComment" DROP CONSTRAINT "AuditPackShareComment_auditPackItemId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AutomationRule" DROP CONSTRAINT "AutomationRule_elseRuleId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AutomationRule" DROP CONSTRAINT "AutomationRule_nextRuleId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "BusinessImpactAnalysis" DROP CONSTRAINT "BusinessImpactAnalysis_processNodeId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_compensatingControlId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_renewedFromId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestEvidenceLink" DROP CONSTRAINT "ControlTestEvidenceLink_evidenceId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Device" DROP CONSTRAINT "Device_employeeId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_managerEmployeeId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_assetId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_fileRecordId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_riskId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_taskId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "FileRecord" DROP CONSTRAINT "FileRecord_previousFileRecordId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Finding" DROP CONSTRAINT "Finding_auditId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "IdentityWriteJournal" DROP CONSTRAINT "IdentityWriteJournal_linkId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "IntegrationExecution" DROP CONSTRAINT "IntegrationExecution_connectionId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "IntegrationSyncMapping" DROP CONSTRAINT "IntegrationSyncMapping_connectionId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "KeyRiskIndicator" DROP CONSTRAINT "KeyRiskIndicator_riskId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "LossEvent" DROP CONSTRAINT "LossEvent_riskId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Policy" DROP CONSTRAINT "Policy_currentVersionId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyEvidenceItem" DROP CONSTRAINT "PolicyEvidenceItem_evidenceId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ReadinessSnapshot" DROP CONSTRAINT "ReadinessSnapshot_auditCycleId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskAppetiteBreach" DROP CONSTRAINT "RiskAppetiteBreach_riskId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskHierarchyNode" DROP CONSTRAINT "RiskHierarchyNode_parentId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskSuggestionItem" DROP CONSTRAINT "RiskSuggestionItem_assetId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ScannerFinding" DROP CONSTRAINT "ScannerFinding_assetId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_findingId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TenantMembership" DROP CONSTRAINT "TenantMembership_customRoleId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_templateVersionId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentAnswer" DROP CONSTRAINT "VendorAssessmentAnswer_evidenceId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentAnswer" DROP CONSTRAINT "VendorAssessmentAnswer_templateQuestionId_tenantId_fkey";

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
ALTER TABLE "Audit" ADD CONSTRAINT "Audit_auditCycleId_tenantId_fkey" FOREIGN KEY ("auditCycleId", "tenantId") REFERENCES "AuditCycle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditPackShareComment" ADD CONSTRAINT "AuditPackShareComment_auditPackItemId_tenantId_fkey" FOREIGN KEY ("auditPackItemId", "tenantId") REFERENCES "AuditPackItem"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadinessSnapshot" ADD CONSTRAINT "ReadinessSnapshot_auditCycleId_tenantId_fkey" FOREIGN KEY ("auditCycleId", "tenantId") REFERENCES "AuditCycle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewConnectedDecision" ADD CONSTRAINT "AccessReviewConnectedDecision_connectedAccountId_tenantId_fkey" FOREIGN KEY ("connectedAccountId", "tenantId") REFERENCES "ConnectedIdentityAccount"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_customRoleId_tenantId_fkey" FOREIGN KEY ("customRoleId", "tenantId") REFERENCES "TenantCustomRole"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReview" ADD CONSTRAINT "AccessReview_evidenceFileRecordId_tenantId_fkey" FOREIGN KEY ("evidenceFileRecordId", "tenantId") REFERENCES "FileRecord"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewDecision" ADD CONSTRAINT "AccessReviewDecision_membershipId_tenantId_fkey" FOREIGN KEY ("membershipId", "tenantId") REFERENCES "TenantMembership"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationExecution" ADD CONSTRAINT "IntegrationExecution_connectionId_tenantId_fkey" FOREIGN KEY ("connectionId", "tenantId") REFERENCES "IntegrationConnection"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSyncMapping" ADD CONSTRAINT "IntegrationSyncMapping_connectionId_tenantId_fkey" FOREIGN KEY ("connectionId", "tenantId") REFERENCES "IntegrationConnection"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_nextRuleId_tenantId_fkey" FOREIGN KEY ("nextRuleId", "tenantId") REFERENCES "AutomationRule"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_elseRuleId_tenantId_fkey" FOREIGN KEY ("elseRuleId", "tenantId") REFERENCES "AutomationRule"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentActionReceipt" ADD CONSTRAINT "AgentActionReceipt_auditLogId_tenantId_fkey" FOREIGN KEY ("auditLogId", "tenantId") REFERENCES "AuditLog"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDecisionLog" ADD CONSTRAINT "AiDecisionLog_aiSystemId_tenantId_fkey" FOREIGN KEY ("aiSystemId", "tenantId") REFERENCES "AiSystem"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlTestEvidenceLink" ADD CONSTRAINT "ControlTestEvidenceLink_evidenceId_tenantId_fkey" FOREIGN KEY ("evidenceId", "tenantId") REFERENCES "Evidence"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlException" ADD CONSTRAINT "ControlException_compensatingControlId_tenantId_fkey" FOREIGN KEY ("compensatingControlId", "tenantId") REFERENCES "Control"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlException" ADD CONSTRAINT "ControlException_renewedFromId_tenantId_fkey" FOREIGN KEY ("renewedFromId", "tenantId") REFERENCES "ControlException"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_taskId_tenantId_fkey" FOREIGN KEY ("taskId", "tenantId") REFERENCES "Task"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_riskId_tenantId_fkey" FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_fileRecordId_tenantId_fkey" FOREIGN KEY ("fileRecordId", "tenantId") REFERENCES "FileRecord"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileRecord" ADD CONSTRAINT "FileRecord_previousFileRecordId_tenantId_fkey" FOREIGN KEY ("previousFileRecordId", "tenantId") REFERENCES "FileRecord"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_auditId_tenantId_fkey" FOREIGN KEY ("auditId", "tenantId") REFERENCES "Audit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessImpactAnalysis" ADD CONSTRAINT "BusinessImpactAnalysis_processNodeId_tenantId_fkey" FOREIGN KEY ("processNodeId", "tenantId") REFERENCES "ProcessNode"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_managerEmployeeId_tenantId_fkey" FOREIGN KEY ("managerEmployeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityWriteJournal" ADD CONSTRAINT "IdentityWriteJournal_linkId_tenantId_fkey" FOREIGN KEY ("linkId", "tenantId") REFERENCES "IdentityAccountLink"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_currentVersionId_tenantId_fkey" FOREIGN KEY ("currentVersionId", "tenantId") REFERENCES "PolicyVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyEvidenceItem" ADD CONSTRAINT "PolicyEvidenceItem_evidenceId_tenantId_fkey" FOREIGN KEY ("evidenceId", "tenantId") REFERENCES "Evidence"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskAppetiteBreach" ADD CONSTRAINT "RiskAppetiteBreach_riskId_tenantId_fkey" FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskHierarchyNode" ADD CONSTRAINT "RiskHierarchyNode_parentId_tenantId_fkey" FOREIGN KEY ("parentId", "tenantId") REFERENCES "RiskHierarchyNode"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyRiskIndicator" ADD CONSTRAINT "KeyRiskIndicator_riskId_tenantId_fkey" FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LossEvent" ADD CONSTRAINT "LossEvent_riskId_tenantId_fkey" FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskSuggestionItem" ADD CONSTRAINT "RiskSuggestionItem_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_findingId_tenantId_fkey" FOREIGN KEY ("findingId", "tenantId") REFERENCES "Finding"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessment" ADD CONSTRAINT "VendorAssessment_templateVersionId_tenantId_fkey" FOREIGN KEY ("templateVersionId", "tenantId") REFERENCES "VendorAssessmentTemplate"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentAnswer" ADD CONSTRAINT "VendorAssessmentAnswer_templateQuestionId_tenantId_fkey" FOREIGN KEY ("templateQuestionId", "tenantId") REFERENCES "VendorAssessmentTemplateQuestion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentAnswer" ADD CONSTRAINT "VendorAssessmentAnswer_evidenceId_tenantId_fkey" FOREIGN KEY ("evidenceId", "tenantId") REFERENCES "Evidence"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
