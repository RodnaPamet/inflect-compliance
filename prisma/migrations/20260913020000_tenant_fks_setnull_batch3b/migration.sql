-- ═══════════════════════════════════════════════════════════════════
-- #2356 batch 3b: the NINETEEN remaining sites, all ON DELETE SET NULL.
--
-- Batch 3a (20260913010000) converted the 34 sites whose action Prisma can
-- express and added the composite uniques all 53 needed. These nineteen
-- were held back because SET NULL over a composite FK is a different
-- mechanism, not a different domain.
--
-- With this migration #2356's measured population is exhausted except the
-- four Control sites split to #2532 (Control.tenantId is NULLABLE — a
-- composite FK there would exile global library controls).
--
-- ─── Why column-scoped, and why that is not optional ───────────────
--
-- A composite FK carrying `tenantId` cannot use plain SET NULL: Postgres
-- nulls EVERY referencing column, `tenantId` is NOT NULL, and the parent
-- delete aborts with SQLSTATE 23502 against a column the DELETE never
-- mentioned. The Postgres 15+ column list nulls only the pointer:
--     ON DELETE SET NULL ("<the fk column>")
-- the same form 20260911120000, 20260911160000 and 20260913000000 use.
--
-- NINE OF THE NINETEEN DECLARE `onDelete: SetNull`; THE OTHER TEN DECLARE
-- NOTHING. Prisma's default for an OPTIONAL relation is SetNull, so all
-- nineteen are SET NULL in the database today. Treating "(default)" as
-- "no action to preserve" would have converted ten live behaviours to
-- RESTRICT — which is exactly what Prisma's own generated SQL proposes,
-- and why every ADD below is rewritten rather than taken as generated.
--
-- ─── Three are SELF-REFERENTIAL ────────────────────────────────────
--
--     AutomationRule.nextRuleId  -> AutomationRule
--     AutomationRule.elseRuleId  -> AutomationRule
--     Employee.managerId         -> Employee
--     RiskHierarchyNode.parentId -> RiskHierarchyNode
--
-- The composite works unchanged for these — parent and child are the same
-- table, so `tenantId` is trivially equal — but the SET NULL matters more
-- than elsewhere: RESTRICT on a self-reference makes a chain undeletable
-- from the middle.
--
-- ─── One new unique, for a ONE-TO-ONE ──────────────────────────────
--
-- Policy(currentVersionId, tenantId). Prisma requires the defining side of
-- a 1:1 to be unique over exactly the fields the relation uses. The
-- pre-existing single-column @unique is KEPT: it is the stronger claim
-- (one current version per id globally), and dropping it would widen the
-- model rather than narrow it.
-- ═══════════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF current_setting('server_version_num')::int < 150000 THEN
        RAISE EXCEPTION
            '#2356 batch 3b needs Postgres 15+ for "ON DELETE SET NULL (column)"; this server is %',
            current_setting('server_version');
    END IF;
END
$$;

-- ── Precondition: no existing row already violates the composite ───

DO $$
DECLARE
    site      RECORD;
    offenders BIGINT;
    total     BIGINT := 0;
    report    TEXT := '';
BEGIN
    FOR site IN
        SELECT * FROM (VALUES
            ('AccessReviewConnectedDecision', 'connectedAccountId', 'ConnectedIdentityAccount'),
            ('AccessReviewDecision', 'membershipId', 'TenantMembership'),
            ('AgentActionReceipt', 'auditLogId', 'AuditLog'),
            ('Audit', 'auditCycleId', 'AuditCycle'),
            ('AuditPackShareComment', 'auditPackItemId', 'AuditPackItem'),
            ('AutomationRule', 'nextRuleId', 'AutomationRule'),
            ('AutomationRule', 'elseRuleId', 'AutomationRule'),
            ('BusinessImpactAnalysis', 'processNodeId', 'ProcessNode'),
            ('Device', 'employeeId', 'Employee'),
            ('Employee', 'managerEmployeeId', 'Employee'),
            ('IdentityWriteJournal', 'linkId', 'IdentityAccountLink'),
            ('IntegrationExecution', 'connectionId', 'IntegrationConnection'),
            ('IntegrationSyncMapping', 'connectionId', 'IntegrationConnection'),
            ('Policy', 'currentVersionId', 'PolicyVersion'),
            ('ReadinessSnapshot', 'auditCycleId', 'AuditCycle'),
            ('RiskHierarchyNode', 'parentId', 'RiskHierarchyNode'),
            ('TenantMembership', 'customRoleId', 'TenantCustomRole'),
            ('VendorAssessment', 'templateVersionId', 'VendorAssessmentTemplate'),
            ('VendorAssessmentAnswer', 'templateQuestionId', 'VendorAssessmentTemplateQuestion')
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
            E'#2356 batch 3b: % existing row(s) reference a parent in ANOTHER tenant and would be refused by the composite FK.%\n\nResolve them (re-point or null) before this migration can apply.',
            total, report;
    END IF;
END
$$;

-- ── The one new composite unique (1:1 defining side) ───────────────

CREATE UNIQUE INDEX "Policy_currentVersionId_tenantId_key" ON "Policy"("currentVersionId", "tenantId");

-- ── Swap each FK for its tenant-carrying, column-scoped form ──────

ALTER TABLE "AccessReviewConnectedDecision" DROP CONSTRAINT "AccessReviewConnectedDecision_connectedAccountId_fkey";
ALTER TABLE "Audit"
    ADD CONSTRAINT "Audit_auditCycleId_tenantId_fkey"
    FOREIGN KEY ("auditCycleId", "tenantId") REFERENCES "AuditCycle"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("auditCycleId");

ALTER TABLE "AccessReviewDecision" DROP CONSTRAINT "AccessReviewDecision_membershipId_fkey";
ALTER TABLE "AuditPackShareComment"
    ADD CONSTRAINT "AuditPackShareComment_auditPackItemId_tenantId_fkey"
    FOREIGN KEY ("auditPackItemId", "tenantId") REFERENCES "AuditPackItem"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("auditPackItemId");

ALTER TABLE "AgentActionReceipt" DROP CONSTRAINT "AgentActionReceipt_auditLogId_fkey";
ALTER TABLE "ReadinessSnapshot"
    ADD CONSTRAINT "ReadinessSnapshot_auditCycleId_tenantId_fkey"
    FOREIGN KEY ("auditCycleId", "tenantId") REFERENCES "AuditCycle"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("auditCycleId");

ALTER TABLE "Audit" DROP CONSTRAINT "Audit_auditCycleId_fkey";
ALTER TABLE "AccessReviewConnectedDecision"
    ADD CONSTRAINT "AccessReviewConnectedDecision_connectedAccountId_tenantId_fkey"
    FOREIGN KEY ("connectedAccountId", "tenantId") REFERENCES "ConnectedIdentityAccount"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("connectedAccountId");

ALTER TABLE "AuditPackShareComment" DROP CONSTRAINT "AuditPackShareComment_auditPackItemId_fkey";
ALTER TABLE "TenantMembership"
    ADD CONSTRAINT "TenantMembership_customRoleId_tenantId_fkey"
    FOREIGN KEY ("customRoleId", "tenantId") REFERENCES "TenantCustomRole"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("customRoleId");

ALTER TABLE "AutomationRule" DROP CONSTRAINT "AutomationRule_elseRuleId_fkey";
ALTER TABLE "AccessReviewDecision"
    ADD CONSTRAINT "AccessReviewDecision_membershipId_tenantId_fkey"
    FOREIGN KEY ("membershipId", "tenantId") REFERENCES "TenantMembership"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("membershipId");

ALTER TABLE "AutomationRule" DROP CONSTRAINT "AutomationRule_nextRuleId_fkey";
ALTER TABLE "IntegrationExecution"
    ADD CONSTRAINT "IntegrationExecution_connectionId_tenantId_fkey"
    FOREIGN KEY ("connectionId", "tenantId") REFERENCES "IntegrationConnection"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("connectionId");

ALTER TABLE "BusinessImpactAnalysis" DROP CONSTRAINT "BusinessImpactAnalysis_processNodeId_fkey";
ALTER TABLE "IntegrationSyncMapping"
    ADD CONSTRAINT "IntegrationSyncMapping_connectionId_tenantId_fkey"
    FOREIGN KEY ("connectionId", "tenantId") REFERENCES "IntegrationConnection"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("connectionId");

ALTER TABLE "Device" DROP CONSTRAINT "Device_employeeId_fkey";
ALTER TABLE "AutomationRule"
    ADD CONSTRAINT "AutomationRule_nextRuleId_tenantId_fkey"
    FOREIGN KEY ("nextRuleId", "tenantId") REFERENCES "AutomationRule"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("nextRuleId");

ALTER TABLE "Employee" DROP CONSTRAINT "Employee_managerEmployeeId_fkey";
ALTER TABLE "AutomationRule"
    ADD CONSTRAINT "AutomationRule_elseRuleId_tenantId_fkey"
    FOREIGN KEY ("elseRuleId", "tenantId") REFERENCES "AutomationRule"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("elseRuleId");

ALTER TABLE "IdentityWriteJournal" DROP CONSTRAINT "IdentityWriteJournal_linkId_fkey";
ALTER TABLE "AgentActionReceipt"
    ADD CONSTRAINT "AgentActionReceipt_auditLogId_tenantId_fkey"
    FOREIGN KEY ("auditLogId", "tenantId") REFERENCES "AuditLog"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("auditLogId");

ALTER TABLE "IntegrationExecution" DROP CONSTRAINT "IntegrationExecution_connectionId_fkey";
ALTER TABLE "BusinessImpactAnalysis"
    ADD CONSTRAINT "BusinessImpactAnalysis_processNodeId_tenantId_fkey"
    FOREIGN KEY ("processNodeId", "tenantId") REFERENCES "ProcessNode"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("processNodeId");

ALTER TABLE "IntegrationSyncMapping" DROP CONSTRAINT "IntegrationSyncMapping_connectionId_fkey";
ALTER TABLE "Device"
    ADD CONSTRAINT "Device_employeeId_tenantId_fkey"
    FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("employeeId");

ALTER TABLE "Policy" DROP CONSTRAINT "Policy_currentVersionId_fkey";
ALTER TABLE "Employee"
    ADD CONSTRAINT "Employee_managerEmployeeId_tenantId_fkey"
    FOREIGN KEY ("managerEmployeeId", "tenantId") REFERENCES "Employee"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("managerEmployeeId");

ALTER TABLE "ReadinessSnapshot" DROP CONSTRAINT "ReadinessSnapshot_auditCycleId_fkey";
ALTER TABLE "IdentityWriteJournal"
    ADD CONSTRAINT "IdentityWriteJournal_linkId_tenantId_fkey"
    FOREIGN KEY ("linkId", "tenantId") REFERENCES "IdentityAccountLink"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("linkId");

ALTER TABLE "RiskHierarchyNode" DROP CONSTRAINT "RiskHierarchyNode_parentId_fkey";
ALTER TABLE "Policy"
    ADD CONSTRAINT "Policy_currentVersionId_tenantId_fkey"
    FOREIGN KEY ("currentVersionId", "tenantId") REFERENCES "PolicyVersion"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("currentVersionId");

ALTER TABLE "TenantMembership" DROP CONSTRAINT "TenantMembership_customRoleId_fkey";
ALTER TABLE "RiskHierarchyNode"
    ADD CONSTRAINT "RiskHierarchyNode_parentId_tenantId_fkey"
    FOREIGN KEY ("parentId", "tenantId") REFERENCES "RiskHierarchyNode"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("parentId");

ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_templateVersionId_fkey";
ALTER TABLE "VendorAssessment"
    ADD CONSTRAINT "VendorAssessment_templateVersionId_tenantId_fkey"
    FOREIGN KEY ("templateVersionId", "tenantId") REFERENCES "VendorAssessmentTemplate"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("templateVersionId");

ALTER TABLE "VendorAssessmentAnswer" DROP CONSTRAINT "VendorAssessmentAnswer_templateQuestionId_fkey";
ALTER TABLE "VendorAssessmentAnswer"
    ADD CONSTRAINT "VendorAssessmentAnswer_templateQuestionId_tenantId_fkey"
    FOREIGN KEY ("templateQuestionId", "tenantId") REFERENCES "VendorAssessmentTemplateQuestion"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("templateQuestionId");

-- ── Post-condition: every one is column-scoped SET NULL ────────────
--
-- Plain and column-scoped SET NULL are BOTH confdeltype = 'n'; only
-- confdelsetcols separates them, so a silently-degraded ALTER would look
-- identical without this.

DO $$
DECLARE
    bad TEXT;
    n   INT;
BEGIN
    SELECT count(*) INTO n
      FROM pg_constraint
     WHERE contype = 'f' AND conname IN (
               'Audit_auditCycleId_tenantId_fkey',
               'AuditPackShareComment_auditPackItemId_tenantId_fkey',
               'ReadinessSnapshot_auditCycleId_tenantId_fkey',
               'AccessReviewConnectedDecision_connectedAccountId_tenantId_fkey',
               'TenantMembership_customRoleId_tenantId_fkey',
               'AccessReviewDecision_membershipId_tenantId_fkey',
               'IntegrationExecution_connectionId_tenantId_fkey',
               'IntegrationSyncMapping_connectionId_tenantId_fkey',
               'AutomationRule_nextRuleId_tenantId_fkey',
               'AutomationRule_elseRuleId_tenantId_fkey',
               'AgentActionReceipt_auditLogId_tenantId_fkey',
               'BusinessImpactAnalysis_processNodeId_tenantId_fkey',
               'Device_employeeId_tenantId_fkey',
               'Employee_managerEmployeeId_tenantId_fkey',
               'IdentityWriteJournal_linkId_tenantId_fkey',
               'Policy_currentVersionId_tenantId_fkey',
               'RiskHierarchyNode_parentId_tenantId_fkey',
               'VendorAssessment_templateVersionId_tenantId_fkey',
               'VendorAssessmentAnswer_templateQuestionId_tenantId_fkey'
           );
    IF n <> 19 THEN
        RAISE EXCEPTION '#2356 batch 3b: expected 19 new FKs, found %', n;
    END IF;

    SELECT string_agg(conname, ', ') INTO bad
      FROM pg_constraint
     WHERE contype = 'f' AND conname IN (
               'Audit_auditCycleId_tenantId_fkey',
               'AuditPackShareComment_auditPackItemId_tenantId_fkey',
               'ReadinessSnapshot_auditCycleId_tenantId_fkey',
               'AccessReviewConnectedDecision_connectedAccountId_tenantId_fkey',
               'TenantMembership_customRoleId_tenantId_fkey',
               'AccessReviewDecision_membershipId_tenantId_fkey',
               'IntegrationExecution_connectionId_tenantId_fkey',
               'IntegrationSyncMapping_connectionId_tenantId_fkey',
               'AutomationRule_nextRuleId_tenantId_fkey',
               'AutomationRule_elseRuleId_tenantId_fkey',
               'AgentActionReceipt_auditLogId_tenantId_fkey',
               'BusinessImpactAnalysis_processNodeId_tenantId_fkey',
               'Device_employeeId_tenantId_fkey',
               'Employee_managerEmployeeId_tenantId_fkey',
               'IdentityWriteJournal_linkId_tenantId_fkey',
               'Policy_currentVersionId_tenantId_fkey',
               'RiskHierarchyNode_parentId_tenantId_fkey',
               'VendorAssessment_templateVersionId_tenantId_fkey',
               'VendorAssessmentAnswer_templateQuestionId_tenantId_fkey'
           )
       AND (confdeltype <> 'n' OR confdelsetcols IS NULL OR cardinality(confdelsetcols) <> 1);
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION '#2356 batch 3b: not column-scoped SET NULL: %', bad;
    END IF;
END
$$;
