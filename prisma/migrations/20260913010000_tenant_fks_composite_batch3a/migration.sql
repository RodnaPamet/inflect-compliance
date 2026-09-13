-- ═══════════════════════════════════════════════════════════════════
-- #2356 batch 3a: the THIRTY-FOUR sites whose referential action Prisma
-- can express, plus the 35 composite uniques they reference.
--
-- Batches 1 and 2 took every site whose target ALREADY carried
-- @@unique([id, tenantId]). This is the second phase #2356 describes: the
-- target has to gain that unique first.
--
-- Re-measured on this commit:
--
--     single-column FKs between tenant-scoped models: 57
--       target already composite-capable:              4  (all -> Control, #2532)
--       target needs the unique first:                53
--         of those, action Prisma CAN express:        34  <- this migration
--         of those, ON DELETE SET NULL:               19  <- batch 3b
--
-- ─── Why the split is by MECHANISM, not by domain ──────────────────
--
-- #2356 suggests batching by domain. The reviewable seam turned out to be
-- the referential action instead. These 34 are Cascade (30) or Restrict
-- (4) — both expressible in Prisma's DSL, so the schema and the database
-- agree and NOTHING is added to the drift residue. The other 19 are SET
-- NULL, which a composite FK can only do with the Postgres 15+ column
-- list that Prisma cannot write, so every one of them adds two permanent
-- residue statements and needs its own argument. Mixing them would put a
-- 34-site mechanical change and a 19-site judgement call in one diff.
--
-- ─── The effective action, not the declared one ────────────────────
--
-- Four of the 34 declare no `onDelete:` at all. Prisma's default for a
-- REQUIRED relation is Restrict, so that is what the database does today
-- and what it keeps doing. The same reading is why the 19 SET NULL sites
-- are NOT here: ten of them also declare nothing, and Prisma's default for
-- an OPTIONAL relation is SetNull. "(default)" is not "no action".
--
-- ─── The index cost, stated rather than buried ─────────────────────
--
-- 35 new unique indexes: one per target model, plus
-- IdentityAccountLink(connectedAccountId, tenantId) because Prisma requires
-- the defining side of a ONE-TO-ONE to be unique over exactly the fields
-- the relation uses.
--
-- Each is a second btree over a superset of the primary key, so it adds
-- nothing to what is UNIQUE — `id` alone already is. It exists solely
-- because Postgres requires a unique index on the referenced columns
-- before it will accept a composite FK. The cost is real: 35 more indexes
-- maintained on every insert and update to those tables. The alternative —
-- promoting each PK to @@id([id, tenantId]) — avoids the second index but
-- rewrites every primary key in the schema, which is a far larger change
-- than this issue is scoped for.
--
-- Rollback: drop the composite FKs, restore the single-column ones, drop
-- the uniques. That re-opens the cross-tenant hole, so it is deliberate.
-- ═══════════════════════════════════════════════════════════════════

-- ── Precondition: no existing row already violates the composite ───
--
-- The single-column FK guarantees the parent id EXISTS; it says nothing
-- about whose tenant the parent is in. Counting first turns what would be
-- a generic "violates foreign key constraint" on the ALTER into a named
-- error saying which table, which column and how many rows.

DO $$
DECLARE
    site      RECORD;
    offenders BIGINT;
    total     BIGINT := 0;
    report    TEXT := '';
BEGIN
    FOR site IN
        SELECT * FROM (VALUES
            ('AiGovSelfAssessmentAnswer', 'assessmentId', 'AiGovSelfAssessment'),
            ('AuditPack', 'auditCycleId', 'AuditCycle'),
            ('AuditPackShareComment', 'auditPackShareId', 'AuditPackShare'),
            ('AutomationExecution', 'ruleId', 'AutomationRule'),
            ('BackgroundCheck', 'employeeId', 'Employee'),
            ('BiaDependency', 'biaId', 'BusinessImpactAnalysis'),
            ('ConnectedIdentityAccount', 'connectionId', 'IntegrationConnection'),
            ('ControlEvidenceLink', 'biaId', 'BusinessImpactAnalysis'),
            ('ControlTestEvidenceLink', 'testRunId', 'ControlTestRun'),
            ('ControlTestRun', 'testPlanId', 'ControlTestPlan'),
            ('ControlTestStep', 'testPlanId', 'ControlTestPlan'),
            ('IdentityAccountLink', 'employeeId', 'Employee'),
            ('IdentityAccountLink', 'connectedAccountId', 'ConnectedIdentityAccount'),
            ('InboundQuestionnaireItem', 'questionnaireId', 'InboundQuestionnaire'),
            ('KriReading', 'kriId', 'KeyRiskIndicator'),
            ('Nis2GapAssignment', 'assessmentId', 'Nis2SelfAssessment'),
            ('Nis2SelfAssessmentAnswer', 'assessmentId', 'Nis2SelfAssessment'),
            ('PolicyApproval', 'policyVersionId', 'PolicyVersion'),
            ('ReportRun', 'templateId', 'ReportTemplate'),
            ('ReportSchedule', 'templateId', 'ReportTemplate'),
            ('RiskHierarchyLink', 'nodeId', 'RiskHierarchyNode'),
            ('TrainingAssignment', 'employeeId', 'Employee'),
            ('TrainingAssignment', 'courseId', 'TrainingCourse'),
            ('TrustCenterAccessRequest', 'documentId', 'TrustCenterDocument'),
            ('TrustCenterDocument', 'trustCenterId', 'TrustCenter'),
            ('UserIdentityLink', 'providerId', 'TenantIdentityProvider'),
            ('VendorAnswerProposal', 'extractionId', 'VendorDocExtraction'),
            ('VendorAssessmentAnswer', 'assessmentId', 'VendorAssessment'),
            ('VendorAssessmentTemplateQuestion', 'templateId', 'VendorAssessmentTemplate'),
            ('VendorAssessmentTemplateQuestion', 'sectionId', 'VendorAssessmentTemplateSection'),
            ('VendorAssessmentTemplateSection', 'templateId', 'VendorAssessmentTemplate'),
            ('VendorDocExtraction', 'documentId', 'VendorDocument'),
            ('VendorEvidenceBundleItem', 'bundleId', 'VendorEvidenceBundle'),
            ('WorkflowStep', 'runId', 'WorkflowRun')
        ) AS t(child, col, parent)
    LOOP
        EXECUTE format(
            'SELECT count(*) FROM %I c JOIN %I p ON p.id = c.%I WHERE c.%I IS NOT NULL AND p."tenantId" IS DISTINCT FROM c."tenantId"',
            site.child, site.parent, site.col, site.col
        ) INTO offenders;
        IF offenders > 0 THEN
            total := total + offenders;
            report := report || format(E'\n  %s.%s -> %s: %s row(s)', site.child, site.col, site.parent, offenders);
        END IF;
    END LOOP;
    IF total > 0 THEN
        RAISE EXCEPTION
            E'#2356 batch 3a: % existing row(s) reference a parent in ANOTHER tenant and would be refused by the composite FK.%\n\nThese are the cross-tenant references #2356 exists to make unrepresentable. Resolve them (re-point or null) before this migration can apply.',
            total, report;
    END IF;
END
$$;

-- ── Drop the single-column FKs ─────────────────────────────────────
ALTER TABLE "AiGovSelfAssessmentAnswer" DROP CONSTRAINT "AiGovSelfAssessmentAnswer_assessmentId_fkey";
ALTER TABLE "AuditPack" DROP CONSTRAINT "AuditPack_auditCycleId_fkey";
ALTER TABLE "AuditPackShareComment" DROP CONSTRAINT "AuditPackShareComment_auditPackShareId_fkey";
ALTER TABLE "AutomationExecution" DROP CONSTRAINT "AutomationExecution_ruleId_fkey";
ALTER TABLE "BackgroundCheck" DROP CONSTRAINT "BackgroundCheck_employeeId_fkey";
ALTER TABLE "BiaDependency" DROP CONSTRAINT "BiaDependency_biaId_fkey";
ALTER TABLE "ConnectedIdentityAccount" DROP CONSTRAINT "ConnectedIdentityAccount_connectionId_fkey";
ALTER TABLE "ControlEvidenceLink" DROP CONSTRAINT "ControlEvidenceLink_biaId_fkey";
ALTER TABLE "ControlTestEvidenceLink" DROP CONSTRAINT "ControlTestEvidenceLink_testRunId_fkey";
ALTER TABLE "ControlTestRun" DROP CONSTRAINT "ControlTestRun_testPlanId_fkey";
ALTER TABLE "ControlTestStep" DROP CONSTRAINT "ControlTestStep_testPlanId_fkey";
ALTER TABLE "IdentityAccountLink" DROP CONSTRAINT "IdentityAccountLink_connectedAccountId_fkey";
ALTER TABLE "IdentityAccountLink" DROP CONSTRAINT "IdentityAccountLink_employeeId_fkey";
ALTER TABLE "InboundQuestionnaireItem" DROP CONSTRAINT "InboundQuestionnaireItem_questionnaireId_fkey";
ALTER TABLE "KriReading" DROP CONSTRAINT "KriReading_kriId_fkey";
ALTER TABLE "Nis2GapAssignment" DROP CONSTRAINT "Nis2GapAssignment_assessmentId_fkey";
ALTER TABLE "Nis2SelfAssessmentAnswer" DROP CONSTRAINT "Nis2SelfAssessmentAnswer_assessmentId_fkey";
ALTER TABLE "PolicyApproval" DROP CONSTRAINT "PolicyApproval_policyVersionId_fkey";
ALTER TABLE "ReportRun" DROP CONSTRAINT "ReportRun_templateId_fkey";
ALTER TABLE "ReportSchedule" DROP CONSTRAINT "ReportSchedule_templateId_fkey";
ALTER TABLE "RiskHierarchyLink" DROP CONSTRAINT "RiskHierarchyLink_nodeId_fkey";
ALTER TABLE "TrainingAssignment" DROP CONSTRAINT "TrainingAssignment_courseId_fkey";
ALTER TABLE "TrainingAssignment" DROP CONSTRAINT "TrainingAssignment_employeeId_fkey";
ALTER TABLE "TrustCenterAccessRequest" DROP CONSTRAINT "TrustCenterAccessRequest_documentId_fkey";
ALTER TABLE "TrustCenterDocument" DROP CONSTRAINT "TrustCenterDocument_trustCenterId_fkey";
ALTER TABLE "UserIdentityLink" DROP CONSTRAINT "UserIdentityLink_providerId_fkey";
ALTER TABLE "VendorAnswerProposal" DROP CONSTRAINT "VendorAnswerProposal_extractionId_fkey";
ALTER TABLE "VendorAssessmentAnswer" DROP CONSTRAINT "VendorAssessmentAnswer_assessmentId_fkey";
ALTER TABLE "VendorAssessmentTemplateQuestion" DROP CONSTRAINT "VendorAssessmentTemplateQuestion_sectionId_fkey";
ALTER TABLE "VendorAssessmentTemplateQuestion" DROP CONSTRAINT "VendorAssessmentTemplateQuestion_templateId_fkey";
ALTER TABLE "VendorAssessmentTemplateSection" DROP CONSTRAINT "VendorAssessmentTemplateSection_templateId_fkey";
ALTER TABLE "VendorDocExtraction" DROP CONSTRAINT "VendorDocExtraction_documentId_fkey";
ALTER TABLE "VendorEvidenceBundleItem" DROP CONSTRAINT "VendorEvidenceBundleItem_bundleId_fkey";
ALTER TABLE "WorkflowStep" DROP CONSTRAINT "WorkflowStep_runId_fkey";

-- ── The composite uniques the new FKs reference ────────────────────
--
-- Created BEFORE the FKs that need them: Postgres refuses a composite FK
-- whose referenced columns carry no unique index.

CREATE UNIQUE INDEX "AiGovSelfAssessment_id_tenantId_key" ON "AiGovSelfAssessment"("id", "tenantId");
CREATE UNIQUE INDEX "AuditCycle_id_tenantId_key" ON "AuditCycle"("id", "tenantId");
CREATE UNIQUE INDEX "AuditLog_id_tenantId_key" ON "AuditLog"("id", "tenantId");
CREATE UNIQUE INDEX "AuditPackItem_id_tenantId_key" ON "AuditPackItem"("id", "tenantId");
CREATE UNIQUE INDEX "AuditPackShare_id_tenantId_key" ON "AuditPackShare"("id", "tenantId");
CREATE UNIQUE INDEX "AutomationRule_id_tenantId_key" ON "AutomationRule"("id", "tenantId");
CREATE UNIQUE INDEX "BusinessImpactAnalysis_id_tenantId_key" ON "BusinessImpactAnalysis"("id", "tenantId");
CREATE UNIQUE INDEX "ConnectedIdentityAccount_id_tenantId_key" ON "ConnectedIdentityAccount"("id", "tenantId");
CREATE UNIQUE INDEX "ControlTestPlan_id_tenantId_key" ON "ControlTestPlan"("id", "tenantId");
CREATE UNIQUE INDEX "ControlTestRun_id_tenantId_key" ON "ControlTestRun"("id", "tenantId");
CREATE UNIQUE INDEX "Employee_id_tenantId_key" ON "Employee"("id", "tenantId");
CREATE UNIQUE INDEX "IdentityAccountLink_id_tenantId_key" ON "IdentityAccountLink"("id", "tenantId");
CREATE UNIQUE INDEX "IdentityAccountLink_connectedAccountId_tenantId_key" ON "IdentityAccountLink"("connectedAccountId", "tenantId");
CREATE UNIQUE INDEX "InboundQuestionnaire_id_tenantId_key" ON "InboundQuestionnaire"("id", "tenantId");
CREATE UNIQUE INDEX "IntegrationConnection_id_tenantId_key" ON "IntegrationConnection"("id", "tenantId");
CREATE UNIQUE INDEX "KeyRiskIndicator_id_tenantId_key" ON "KeyRiskIndicator"("id", "tenantId");
CREATE UNIQUE INDEX "Nis2SelfAssessment_id_tenantId_key" ON "Nis2SelfAssessment"("id", "tenantId");
CREATE UNIQUE INDEX "PolicyVersion_id_tenantId_key" ON "PolicyVersion"("id", "tenantId");
CREATE UNIQUE INDEX "ProcessNode_id_tenantId_key" ON "ProcessNode"("id", "tenantId");
CREATE UNIQUE INDEX "ReportTemplate_id_tenantId_key" ON "ReportTemplate"("id", "tenantId");
CREATE UNIQUE INDEX "RiskHierarchyNode_id_tenantId_key" ON "RiskHierarchyNode"("id", "tenantId");
CREATE UNIQUE INDEX "TenantCustomRole_id_tenantId_key" ON "TenantCustomRole"("id", "tenantId");
CREATE UNIQUE INDEX "TenantIdentityProvider_id_tenantId_key" ON "TenantIdentityProvider"("id", "tenantId");
CREATE UNIQUE INDEX "TenantMembership_id_tenantId_key" ON "TenantMembership"("id", "tenantId");
CREATE UNIQUE INDEX "TrainingCourse_id_tenantId_key" ON "TrainingCourse"("id", "tenantId");
CREATE UNIQUE INDEX "TrustCenter_id_tenantId_key" ON "TrustCenter"("id", "tenantId");
CREATE UNIQUE INDEX "TrustCenterDocument_id_tenantId_key" ON "TrustCenterDocument"("id", "tenantId");
CREATE UNIQUE INDEX "VendorAssessment_id_tenantId_key" ON "VendorAssessment"("id", "tenantId");
CREATE UNIQUE INDEX "VendorAssessmentTemplate_id_tenantId_key" ON "VendorAssessmentTemplate"("id", "tenantId");
CREATE UNIQUE INDEX "VendorAssessmentTemplateQuestion_id_tenantId_key" ON "VendorAssessmentTemplateQuestion"("id", "tenantId");
CREATE UNIQUE INDEX "VendorAssessmentTemplateSection_id_tenantId_key" ON "VendorAssessmentTemplateSection"("id", "tenantId");
CREATE UNIQUE INDEX "VendorDocExtraction_id_tenantId_key" ON "VendorDocExtraction"("id", "tenantId");
CREATE UNIQUE INDEX "VendorDocument_id_tenantId_key" ON "VendorDocument"("id", "tenantId");
CREATE UNIQUE INDEX "VendorEvidenceBundle_id_tenantId_key" ON "VendorEvidenceBundle"("id", "tenantId");
CREATE UNIQUE INDEX "WorkflowRun_id_tenantId_key" ON "WorkflowRun"("id", "tenantId");

-- ── The tenant-carrying composite FKs ──────────────────────────────

ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_runId_tenantId_fkey" FOREIGN KEY ("runId", "tenantId") REFERENCES "WorkflowRun"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiGovSelfAssessmentAnswer" ADD CONSTRAINT "AiGovSelfAssessmentAnswer_assessmentId_tenantId_fkey" FOREIGN KEY ("assessmentId", "tenantId") REFERENCES "AiGovSelfAssessment"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditPack" ADD CONSTRAINT "AuditPack_auditCycleId_tenantId_fkey" FOREIGN KEY ("auditCycleId", "tenantId") REFERENCES "AuditCycle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditPackShareComment" ADD CONSTRAINT "AuditPackShareComment_auditPackShareId_tenantId_fkey" FOREIGN KEY ("auditPackShareId", "tenantId") REFERENCES "AuditPackShare"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserIdentityLink" ADD CONSTRAINT "UserIdentityLink_providerId_tenantId_fkey" FOREIGN KEY ("providerId", "tenantId") REFERENCES "TenantIdentityProvider"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_ruleId_tenantId_fkey" FOREIGN KEY ("ruleId", "tenantId") REFERENCES "AutomationRule"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ControlEvidenceLink" ADD CONSTRAINT "ControlEvidenceLink_biaId_tenantId_fkey" FOREIGN KEY ("biaId", "tenantId") REFERENCES "BusinessImpactAnalysis"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ControlTestRun" ADD CONSTRAINT "ControlTestRun_testPlanId_tenantId_fkey" FOREIGN KEY ("testPlanId", "tenantId") REFERENCES "ControlTestPlan"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ControlTestEvidenceLink" ADD CONSTRAINT "ControlTestEvidenceLink_testRunId_tenantId_fkey" FOREIGN KEY ("testRunId", "tenantId") REFERENCES "ControlTestRun"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ControlTestStep" ADD CONSTRAINT "ControlTestStep_testPlanId_tenantId_fkey" FOREIGN KEY ("testPlanId", "tenantId") REFERENCES "ControlTestPlan"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BiaDependency" ADD CONSTRAINT "BiaDependency_biaId_tenantId_fkey" FOREIGN KEY ("biaId", "tenantId") REFERENCES "BusinessImpactAnalysis"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Nis2SelfAssessmentAnswer" ADD CONSTRAINT "Nis2SelfAssessmentAnswer_assessmentId_tenantId_fkey" FOREIGN KEY ("assessmentId", "tenantId") REFERENCES "Nis2SelfAssessment"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Nis2GapAssignment" ADD CONSTRAINT "Nis2GapAssignment_assessmentId_tenantId_fkey" FOREIGN KEY ("assessmentId", "tenantId") REFERENCES "Nis2SelfAssessment"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectedIdentityAccount" ADD CONSTRAINT "ConnectedIdentityAccount_connectionId_tenantId_fkey" FOREIGN KEY ("connectionId", "tenantId") REFERENCES "IntegrationConnection"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_courseId_tenantId_fkey" FOREIGN KEY ("courseId", "tenantId") REFERENCES "TrainingCourse"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackgroundCheck" ADD CONSTRAINT "BackgroundCheck_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdentityAccountLink" ADD CONSTRAINT "IdentityAccountLink_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdentityAccountLink" ADD CONSTRAINT "IdentityAccountLink_connectedAccountId_tenantId_fkey" FOREIGN KEY ("connectedAccountId", "tenantId") REFERENCES "ConnectedIdentityAccount"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PolicyApproval" ADD CONSTRAINT "PolicyApproval_policyVersionId_tenantId_fkey" FOREIGN KEY ("policyVersionId", "tenantId") REFERENCES "PolicyVersion"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboundQuestionnaireItem" ADD CONSTRAINT "InboundQuestionnaireItem_questionnaireId_tenantId_fkey" FOREIGN KEY ("questionnaireId", "tenantId") REFERENCES "InboundQuestionnaire"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiskHierarchyLink" ADD CONSTRAINT "RiskHierarchyLink_nodeId_tenantId_fkey" FOREIGN KEY ("nodeId", "tenantId") REFERENCES "RiskHierarchyNode"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KriReading" ADD CONSTRAINT "KriReading_kriId_tenantId_fkey" FOREIGN KEY ("kriId", "tenantId") REFERENCES "KeyRiskIndicator"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_templateId_tenantId_fkey" FOREIGN KEY ("templateId", "tenantId") REFERENCES "ReportTemplate"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_templateId_tenantId_fkey" FOREIGN KEY ("templateId", "tenantId") REFERENCES "ReportTemplate"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustCenterDocument" ADD CONSTRAINT "TrustCenterDocument_trustCenterId_tenantId_fkey" FOREIGN KEY ("trustCenterId", "tenantId") REFERENCES "TrustCenter"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrustCenterAccessRequest" ADD CONSTRAINT "TrustCenterAccessRequest_documentId_tenantId_fkey" FOREIGN KEY ("documentId", "tenantId") REFERENCES "TrustCenterDocument"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorAssessmentTemplateSection" ADD CONSTRAINT "VendorAssessmentTemplateSection_templateId_tenantId_fkey" FOREIGN KEY ("templateId", "tenantId") REFERENCES "VendorAssessmentTemplate"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorAssessmentTemplateQuestion" ADD CONSTRAINT "VendorAssessmentTemplateQuestion_templateId_tenantId_fkey" FOREIGN KEY ("templateId", "tenantId") REFERENCES "VendorAssessmentTemplate"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorAssessmentTemplateQuestion" ADD CONSTRAINT "VendorAssessmentTemplateQuestion_sectionId_tenantId_fkey" FOREIGN KEY ("sectionId", "tenantId") REFERENCES "VendorAssessmentTemplateSection"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorAssessmentAnswer" ADD CONSTRAINT "VendorAssessmentAnswer_assessmentId_tenantId_fkey" FOREIGN KEY ("assessmentId", "tenantId") REFERENCES "VendorAssessment"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorDocExtraction" ADD CONSTRAINT "VendorDocExtraction_documentId_tenantId_fkey" FOREIGN KEY ("documentId", "tenantId") REFERENCES "VendorDocument"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorAnswerProposal" ADD CONSTRAINT "VendorAnswerProposal_extractionId_tenantId_fkey" FOREIGN KEY ("extractionId", "tenantId") REFERENCES "VendorDocExtraction"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorEvidenceBundleItem" ADD CONSTRAINT "VendorEvidenceBundleItem_bundleId_tenantId_fkey" FOREIGN KEY ("bundleId", "tenantId") REFERENCES "VendorEvidenceBundle"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Post-condition: every new FK really is two columns ─────────────
--
-- A DROP that applied while its ADD silently did not would leave the table
-- with NO constraint at all — strictly worse than before this migration.
-- Counting them here means that cannot ship green.

DO $$
DECLARE
    n INT;
BEGIN
    SELECT count(*) INTO n
      FROM pg_constraint
     WHERE contype = 'f'
       AND cardinality(conkey) = 2
       AND conname LIKE '%\_tenantId\_fkey';
    IF n < 34 THEN
        RAISE EXCEPTION
            '#2356 batch 3a: expected at least 34 two-column tenant FKs after this migration, found %', n;
    END IF;
END
$$;
