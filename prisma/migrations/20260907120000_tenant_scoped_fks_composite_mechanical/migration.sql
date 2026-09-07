-- 35 tenant-scoped foreign keys: single-column -> composite, tenant-carrying.
--
-- ─── Why ────────────────────────────────────────────────────────────
--
-- Postgres runs foreign-key checks AS THE TABLE OWNER, which bypasses row-level
-- security. RLS does not constrain what a FK will accept. So a single-column
-- `xId -> Target(id)` between two tenant-scoped tables makes a CROSS-TENANT
-- reference representable at the database, however carefully the application
-- filters. A composite `[xId, tenantId] -> Target[id, tenantId]` makes it
-- unrepresentable.
--
-- This is the pattern the repo already treats as correct: `RegisteredAgent`
-- carries a composite FK to `AiSystem` for exactly this reason, and #2355 gave
-- `RegisteredAgent.vendor` the same shape. Sweeping for the rest found 121
-- single-column FKs between tenant-scoped models (issue #2356).
--
-- ─── What this migration deliberately does NOT include ──────────────
--
-- Only the 35 that are MECHANICAL: their target already carries
-- `@@unique([id, tenantId])`, and their onDelete is Cascade or Restrict, both of
-- which a composite FK expresses unchanged. No semantics move.
--
-- The 14 remaining ready sites use `onDelete: SetNull`, which a composite FK
-- CANNOT express: SET NULL nulls every referencing column, and `tenantId` is NOT
-- NULL. Converting those means changing SetNull to Restrict — a real behavioural
-- decision per site — so they are a separate change, not smuggled in here.
--
-- ─── Safety ─────────────────────────────────────────────────────────
--
-- Every one of these is currently defended at the application layer, and
-- reaching a cross-tenant id also requires knowing an id RLS prevents reading.
-- Nothing here is a known-exploitable bug; it is the second isolation layer the
-- model in CLAUDE.md says should exist. The DO block below refuses the migration
-- with a NAMED error if any row already violates the constraint it is about to
-- add, because otherwise the first violation surfaces as an opaque FK failure on
-- an ALTER halfway down this file.
--
-- Rollback: restore the single-column constraints. This repo forward-fixes
-- rather than reverting (docs/change-management-policy.md).

DO $$
DECLARE offending INTEGER; total INTEGER := 0; detail TEXT := '';
BEGIN
    SELECT count(*) INTO offending FROM "AgenticEvidenceArtefact" c
      JOIN "Control" t ON t.id = c."controlId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  AgenticEvidenceArtefact.controlId -> Control: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "AssetRiskLink" c
      JOIN "Risk" t ON t.id = c."riskId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  AssetRiskLink.riskId -> Risk: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "AuditPackItem" c
      JOIN "AuditPack" t ON t.id = c."auditPackId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  AuditPackItem.auditPackId -> AuditPack: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "AuditPackShare" c
      JOIN "AuditPack" t ON t.id = c."auditPackId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  AuditPackShare.auditPackId -> AuditPack: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "AuditPackShareComment" c
      JOIN "AuditPack" t ON t.id = c."auditPackId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  AuditPackShareComment.auditPackId -> AuditPack: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "ControlAsset" c
      JOIN "Control" t ON t.id = c."controlId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  ControlAsset.controlId -> Control: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "ControlContributor" c
      JOIN "Control" t ON t.id = c."controlId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  ControlContributor.controlId -> Control: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "ControlEvidenceLink" c
      JOIN "Control" t ON t.id = c."controlId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  ControlEvidenceLink.controlId -> Control: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "ControlRequirementLink" c
      JOIN "Control" t ON t.id = c."controlId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  ControlRequirementLink.controlId -> Control: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "ControlTestPlan" c
      JOIN "Control" t ON t.id = c."controlId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  ControlTestPlan.controlId -> Control: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "ControlTestRun" c
      JOIN "Control" t ON t.id = c."controlId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  ControlTestRun.controlId -> Control: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "EvidenceControlLink" c
      JOIN "Control" t ON t.id = c."controlId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  EvidenceControlLink.controlId -> Control: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "EvidenceRiskLink" c
      JOIN "Risk" t ON t.id = c."riskId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  EvidenceRiskLink.riskId -> Risk: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "PolicyApproval" c
      JOIN "Policy" t ON t.id = c."policyId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  PolicyApproval.policyId -> Policy: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "PolicyControlLink" c
      JOIN "Control" t ON t.id = c."controlId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  PolicyControlLink.controlId -> Control: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "PolicyVersion" c
      JOIN "Policy" t ON t.id = c."policyId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  PolicyVersion.policyId -> Policy: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "ProcessEdgeControl" c
      JOIN "Control" t ON t.id = c."controlId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  ProcessEdgeControl.controlId -> Control: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "ReminderHistory" c
      JOIN "Evidence" t ON t.id = c."evidenceId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  ReminderHistory.evidenceId -> Evidence: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "RiskControl" c
      JOIN "Control" t ON t.id = c."controlId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  RiskControl.controlId -> Control: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "RiskControl" c
      JOIN "Risk" t ON t.id = c."riskId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  RiskControl.riskId -> Risk: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "RiskCorrelation" c
      JOIN "Risk" t ON t.id = c."riskAId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  RiskCorrelation.riskAId -> Risk: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "RiskCorrelation" c
      JOIN "Risk" t ON t.id = c."riskBId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  RiskCorrelation.riskBId -> Risk: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "RiskHierarchyLink" c
      JOIN "Risk" t ON t.id = c."riskId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  RiskHierarchyLink.riskId -> Risk: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "RiskScoreEvent" c
      JOIN "Risk" t ON t.id = c."riskId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  RiskScoreEvent.riskId -> Risk: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "RiskSnapshot" c
      JOIN "Risk" t ON t.id = c."riskId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  RiskSnapshot.riskId -> Risk: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "VendorAssessment" c
      JOIN "Vendor" t ON t.id = c."vendorId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  VendorAssessment.vendorId -> Vendor: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "VendorContact" c
      JOIN "Vendor" t ON t.id = c."vendorId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  VendorContact.vendorId -> Vendor: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "VendorDocExtraction" c
      JOIN "Vendor" t ON t.id = c."vendorId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  VendorDocExtraction.vendorId -> Vendor: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "VendorDocument" c
      JOIN "Vendor" t ON t.id = c."vendorId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  VendorDocument.vendorId -> Vendor: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "VendorEvidenceBundle" c
      JOIN "Vendor" t ON t.id = c."vendorId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  VendorEvidenceBundle.vendorId -> Vendor: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "VendorLink" c
      JOIN "Vendor" t ON t.id = c."vendorId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  VendorLink.vendorId -> Vendor: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "VendorMonitor" c
      JOIN "Vendor" t ON t.id = c."vendorId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  VendorMonitor.vendorId -> Vendor: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "VendorPostureEvent" c
      JOIN "Vendor" t ON t.id = c."vendorId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  VendorPostureEvent.vendorId -> Vendor: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "VendorRelationship" c
      JOIN "Vendor" t ON t.id = c."primaryVendorId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  VendorRelationship.primaryVendorId -> Vendor: ' || offending || E'\n'; END IF;
    SELECT count(*) INTO offending FROM "VendorRelationship" c
      JOIN "Vendor" t ON t.id = c."subprocessorVendorId"
      WHERE c."tenantId" <> t."tenantId";
    IF offending > 0 THEN total := total + offending;
        detail := detail || '  VendorRelationship.subprocessorVendorId -> Vendor: ' || offending || E'\n'; END IF;

    IF total > 0 THEN
        RAISE EXCEPTION E'Cannot add composite foreign keys: % row(s) already reference another tenant.\n%These are exactly the rows these constraints exist to prevent; resolve them before migrating.', total, detail;
    END IF;
END $$;

ALTER TABLE "AgenticEvidenceArtefact" DROP CONSTRAINT "AgenticEvidenceArtefact_controlId_fkey";
ALTER TABLE "AgenticEvidenceArtefact" ADD CONSTRAINT "AgenticEvidenceArtefact_controlId_tenantId_fkey"
    FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssetRiskLink" DROP CONSTRAINT "AssetRiskLink_riskId_fkey";
ALTER TABLE "AssetRiskLink" ADD CONSTRAINT "AssetRiskLink_riskId_tenantId_fkey"
    FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditPackItem" DROP CONSTRAINT "AuditPackItem_auditPackId_fkey";
ALTER TABLE "AuditPackItem" ADD CONSTRAINT "AuditPackItem_auditPackId_tenantId_fkey"
    FOREIGN KEY ("auditPackId", "tenantId") REFERENCES "AuditPack"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditPackShare" DROP CONSTRAINT "AuditPackShare_auditPackId_fkey";
ALTER TABLE "AuditPackShare" ADD CONSTRAINT "AuditPackShare_auditPackId_tenantId_fkey"
    FOREIGN KEY ("auditPackId", "tenantId") REFERENCES "AuditPack"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuditPackShareComment" DROP CONSTRAINT "AuditPackShareComment_auditPackId_fkey";
ALTER TABLE "AuditPackShareComment" ADD CONSTRAINT "AuditPackShareComment_auditPackId_tenantId_fkey"
    FOREIGN KEY ("auditPackId", "tenantId") REFERENCES "AuditPack"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ControlAsset" DROP CONSTRAINT "ControlAsset_controlId_fkey";
ALTER TABLE "ControlAsset" ADD CONSTRAINT "ControlAsset_controlId_tenantId_fkey"
    FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ControlContributor" DROP CONSTRAINT "ControlContributor_controlId_fkey";
ALTER TABLE "ControlContributor" ADD CONSTRAINT "ControlContributor_controlId_tenantId_fkey"
    FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ControlEvidenceLink" DROP CONSTRAINT "ControlEvidenceLink_controlId_fkey";
ALTER TABLE "ControlEvidenceLink" ADD CONSTRAINT "ControlEvidenceLink_controlId_tenantId_fkey"
    FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ControlRequirementLink" DROP CONSTRAINT "ControlRequirementLink_controlId_fkey";
ALTER TABLE "ControlRequirementLink" ADD CONSTRAINT "ControlRequirementLink_controlId_tenantId_fkey"
    FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ControlTestPlan" DROP CONSTRAINT "ControlTestPlan_controlId_fkey";
ALTER TABLE "ControlTestPlan" ADD CONSTRAINT "ControlTestPlan_controlId_tenantId_fkey"
    FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ControlTestRun" DROP CONSTRAINT "ControlTestRun_controlId_fkey";
ALTER TABLE "ControlTestRun" ADD CONSTRAINT "ControlTestRun_controlId_tenantId_fkey"
    FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EvidenceControlLink" DROP CONSTRAINT "EvidenceControlLink_controlId_fkey";
ALTER TABLE "EvidenceControlLink" ADD CONSTRAINT "EvidenceControlLink_controlId_tenantId_fkey"
    FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EvidenceRiskLink" DROP CONSTRAINT "EvidenceRiskLink_riskId_fkey";
ALTER TABLE "EvidenceRiskLink" ADD CONSTRAINT "EvidenceRiskLink_riskId_tenantId_fkey"
    FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolicyApproval" DROP CONSTRAINT "PolicyApproval_policyId_fkey";
ALTER TABLE "PolicyApproval" ADD CONSTRAINT "PolicyApproval_policyId_tenantId_fkey"
    FOREIGN KEY ("policyId", "tenantId") REFERENCES "Policy"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolicyControlLink" DROP CONSTRAINT "PolicyControlLink_controlId_fkey";
ALTER TABLE "PolicyControlLink" ADD CONSTRAINT "PolicyControlLink_controlId_tenantId_fkey"
    FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolicyVersion" DROP CONSTRAINT "PolicyVersion_policyId_fkey";
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_policyId_tenantId_fkey"
    FOREIGN KEY ("policyId", "tenantId") REFERENCES "Policy"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProcessEdgeControl" DROP CONSTRAINT "ProcessEdgeControl_controlId_fkey";
ALTER TABLE "ProcessEdgeControl" ADD CONSTRAINT "ProcessEdgeControl_controlId_tenantId_fkey"
    FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReminderHistory" DROP CONSTRAINT "ReminderHistory_evidenceId_fkey";
ALTER TABLE "ReminderHistory" ADD CONSTRAINT "ReminderHistory_evidenceId_tenantId_fkey"
    FOREIGN KEY ("evidenceId", "tenantId") REFERENCES "Evidence"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiskControl" DROP CONSTRAINT "RiskControl_controlId_fkey";
ALTER TABLE "RiskControl" ADD CONSTRAINT "RiskControl_controlId_tenantId_fkey"
    FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RiskControl" DROP CONSTRAINT "RiskControl_riskId_fkey";
ALTER TABLE "RiskControl" ADD CONSTRAINT "RiskControl_riskId_tenantId_fkey"
    FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RiskCorrelation" DROP CONSTRAINT "RiskCorrelation_riskAId_fkey";
ALTER TABLE "RiskCorrelation" ADD CONSTRAINT "RiskCorrelation_riskAId_tenantId_fkey"
    FOREIGN KEY ("riskAId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RiskCorrelation" DROP CONSTRAINT "RiskCorrelation_riskBId_fkey";
ALTER TABLE "RiskCorrelation" ADD CONSTRAINT "RiskCorrelation_riskBId_tenantId_fkey"
    FOREIGN KEY ("riskBId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RiskHierarchyLink" DROP CONSTRAINT "RiskHierarchyLink_riskId_fkey";
ALTER TABLE "RiskHierarchyLink" ADD CONSTRAINT "RiskHierarchyLink_riskId_tenantId_fkey"
    FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RiskScoreEvent" DROP CONSTRAINT "RiskScoreEvent_riskId_fkey";
ALTER TABLE "RiskScoreEvent" ADD CONSTRAINT "RiskScoreEvent_riskId_tenantId_fkey"
    FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RiskSnapshot" DROP CONSTRAINT "RiskSnapshot_riskId_fkey";
ALTER TABLE "RiskSnapshot" ADD CONSTRAINT "RiskSnapshot_riskId_tenantId_fkey"
    FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_vendorId_fkey";
ALTER TABLE "VendorAssessment" ADD CONSTRAINT "VendorAssessment_vendorId_tenantId_fkey"
    FOREIGN KEY ("vendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VendorContact" DROP CONSTRAINT "VendorContact_vendorId_fkey";
ALTER TABLE "VendorContact" ADD CONSTRAINT "VendorContact_vendorId_tenantId_fkey"
    FOREIGN KEY ("vendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VendorDocExtraction" DROP CONSTRAINT "VendorDocExtraction_vendorId_fkey";
ALTER TABLE "VendorDocExtraction" ADD CONSTRAINT "VendorDocExtraction_vendorId_tenantId_fkey"
    FOREIGN KEY ("vendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VendorDocument" DROP CONSTRAINT "VendorDocument_vendorId_fkey";
ALTER TABLE "VendorDocument" ADD CONSTRAINT "VendorDocument_vendorId_tenantId_fkey"
    FOREIGN KEY ("vendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VendorEvidenceBundle" DROP CONSTRAINT "VendorEvidenceBundle_vendorId_fkey";
ALTER TABLE "VendorEvidenceBundle" ADD CONSTRAINT "VendorEvidenceBundle_vendorId_tenantId_fkey"
    FOREIGN KEY ("vendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VendorLink" DROP CONSTRAINT "VendorLink_vendorId_fkey";
ALTER TABLE "VendorLink" ADD CONSTRAINT "VendorLink_vendorId_tenantId_fkey"
    FOREIGN KEY ("vendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VendorMonitor" DROP CONSTRAINT "VendorMonitor_vendorId_fkey";
ALTER TABLE "VendorMonitor" ADD CONSTRAINT "VendorMonitor_vendorId_tenantId_fkey"
    FOREIGN KEY ("vendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VendorPostureEvent" DROP CONSTRAINT "VendorPostureEvent_vendorId_fkey";
ALTER TABLE "VendorPostureEvent" ADD CONSTRAINT "VendorPostureEvent_vendorId_tenantId_fkey"
    FOREIGN KEY ("vendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VendorRelationship" DROP CONSTRAINT "VendorRelationship_primaryVendorId_fkey";
ALTER TABLE "VendorRelationship" ADD CONSTRAINT "VendorRelationship_primaryVendorId_tenantId_fkey"
    FOREIGN KEY ("primaryVendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VendorRelationship" DROP CONSTRAINT "VendorRelationship_subprocessorVendorId_fkey";
ALTER TABLE "VendorRelationship" ADD CONSTRAINT "VendorRelationship_subprocessorVendorId_tenantId_fkey"
    FOREIGN KEY ("subprocessorVendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

