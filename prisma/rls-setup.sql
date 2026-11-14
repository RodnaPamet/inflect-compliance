-- ═══════════════════════════════════════════════════════════════════
-- Row-Level Security Setup for Inflect Compliance
-- ═══════════════════════════════════════════════════════════════════
-- 
-- This script is fully IDEMPOTENT — safe to re-run at any time.
-- 
-- Pattern:
--   ENABLE ROW LEVEL SECURITY  — activates RLS on the table
--   FORCE  ROW LEVEL SECURITY  — enforces RLS even for table owners
--   tenant_isolation           — SELECT/UPDATE/DELETE policy
--   tenant_isolation_insert    — INSERT policy
--
-- All tenant-scoped tables use:
--   USING  ("tenantId" = current_setting('app.tenant_id', true)::text)
--   WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text)
--
-- Tables WITHOUT a tenantId column are handled in rls-fix.sql using
-- USING(true) as a temporary measure until tenantId is added via migration.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1) Create the app_user role (if it doesn't exist) ───

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user NOLOGIN;
    END IF;
END
$$;

-- ─── 2) Grant schema and table access to app_user ───

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- ─── 2b) Re-take what the migrations took away (#5314) ───
--
-- The blanket GRANT above re-grants UPDATE and DELETE on EVERY table, including
-- the write-once and never-deleted tables whose migrations REVOKE them from
-- app_user. Replaying this "safe to re-run" script would otherwise reopen them —
-- and for a table whose only protection is the REVOKE (no trigger), an app_user
-- session could then delete rows meant to survive (an ownership transfer, a
-- service-principal confirmation). So every REVOKE a migration left in force is
-- re-issued here, right after the GRANT that undoes it. A migration that adds a
-- REVOKE adds its line here too:
-- tests/guards/rls-replay-scripts-do-not-weaken-migrations.test.ts fails until it does.

REVOKE DELETE ON "AccessReviewAgentNarrowing" FROM app_user;
REVOKE UPDATE, DELETE ON "AccessReviewAgentPack" FROM app_user;
REVOKE DELETE ON "AccessReviewDecisionSampleAudit" FROM app_user;
REVOKE DELETE ON "AgentHarnessAcceptance" FROM app_user;
REVOKE DELETE ON "AgentOwnershipTransfer" FROM app_user;
REVOKE DELETE ON "AgentProfile" FROM app_user;
REVOKE DELETE ON "AgentProfileVersion" FROM app_user;
REVOKE UPDATE, DELETE ON "AgentProposalApproval" FROM app_user;
REVOKE DELETE ON "AgentServicePrincipalConfirmation" FROM app_user;
REVOKE DELETE ON "AgentSpendingAuthority" FROM app_user;
REVOKE UPDATE, DELETE ON "AuditLog" FROM app_user;
REVOKE DELETE ON "AuditWorkpaper" FROM app_user;
REVOKE UPDATE, DELETE ON "AuditWorkpaperFinding" FROM app_user;
REVOKE UPDATE, DELETE ON "AuditWorkpaperNarrative" FROM app_user;
REVOKE DELETE ON "AuditWorkpaperSampleReview" FROM app_user;
REVOKE DELETE ON "DiscoveredAgentAttribution" FROM app_user;
REVOKE UPDATE, DELETE ON "ExternalToolParameterSetApproval" FROM app_user;
REVOKE UPDATE, DELETE ON "OrgAuditLog" FROM app_user;
REVOKE DELETE ON "PeerAgent" FROM app_user;
REVOKE DELETE ON "PeerAgentInboundCredential" FROM app_user;
REVOKE DELETE ON "PeerAgentKillSwitch" FROM app_user;
REVOKE UPDATE, DELETE ON "PeerAgentMessage" FROM app_user;
REVOKE UPDATE, DELETE ON "PeerAgentReplyDelivery" FROM app_user;
REVOKE DELETE ON "PeerInvitation" FROM app_user;
REVOKE DELETE ON "TenantA2aSigningKey" FROM app_user;
REVOKE UPDATE, DELETE ON "TenantSkill" FROM app_user;
REVOKE DELETE ON "TenantSkillVersion" FROM app_user;
REVOKE DELETE ON "WorkflowRunDeferral" FROM app_user;

-- ─── 3) Grant the app_user role to the postgres superuser ───

GRANT app_user TO postgres;

-- ═══════════════════════════════════════════════════════════════════
-- 4) Enable RLS on ALL tenant-scoped tables with tenantId column
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────
-- CORE ENTITIES
-- ─────────────────────────────────────

-- Risk
ALTER TABLE "Risk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Risk" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Risk";
CREATE POLICY tenant_isolation ON "Risk"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Risk";
CREATE POLICY tenant_isolation_insert ON "Risk"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- Policy (document)
ALTER TABLE "Policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Policy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Policy";
CREATE POLICY tenant_isolation ON "Policy"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Policy";
CREATE POLICY tenant_isolation_insert ON "Policy"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- Evidence
ALTER TABLE "Evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Evidence" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Evidence";
CREATE POLICY tenant_isolation ON "Evidence"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Evidence";
CREATE POLICY tenant_isolation_insert ON "Evidence"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- Control (nullable tenantId — global controls have NULL tenantId)
ALTER TABLE "Control" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Control" FORCE ROW LEVEL SECURITY;
-- ONE ASYMMETRIC POLICY, NOT THE SPLIT PAIR (#5241).
--
-- This stanza used to recreate the shape migration
-- 20260806120000_control_rls_single_asymmetric_policy REMOVED as a leak:
--
--   tenant_isolation        FOR ALL    USING ("tenantId" IS NULL OR own)
--   tenant_isolation_insert FOR INSERT WITH CHECK (own)
--
-- A FOR ALL policy with no WITH CHECK takes its USING clause as the check, so
-- the pair let an app_user session UPDATE a global (tenantId NULL) row every
-- tenant reads, and set its own row's tenantId to NULL — publishing it into
-- every tenant's library. The INSERT-only policy does not constrain UPDATE.
--
-- This file calls itself "fully IDEMPOTENT — safe to re-run at any time", so an
-- operator replaying it to REPAIR RLS would have reopened the hole the
-- migration closed. Keep this identical to that migration.
DROP POLICY IF EXISTS tenant_isolation_insert ON "Control";
DROP POLICY IF EXISTS tenant_isolation ON "Control";
CREATE POLICY tenant_isolation ON "Control"
    USING (
        "tenantId" IS NULL
        OR "tenantId" = current_setting('app.tenant_id', true)::text
    )
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)::text
    );

-- Asset
ALTER TABLE "Asset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Asset" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Asset";
CREATE POLICY tenant_isolation ON "Asset"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Asset";
CREATE POLICY tenant_isolation_insert ON "Asset"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- Audit
ALTER TABLE "Audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Audit" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Audit";
CREATE POLICY tenant_isolation ON "Audit"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Audit";
CREATE POLICY tenant_isolation_insert ON "Audit"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- Finding
ALTER TABLE "Finding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Finding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Finding";
CREATE POLICY tenant_isolation ON "Finding"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Finding";
CREATE POLICY tenant_isolation_insert ON "Finding"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- TASK/WORK ITEMS
-- ─────────────────────────────────────

-- Task
ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Task";
CREATE POLICY tenant_isolation ON "Task"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Task";
CREATE POLICY tenant_isolation_insert ON "Task"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- TaskLink
ALTER TABLE "TaskLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TaskLink";
CREATE POLICY tenant_isolation ON "TaskLink"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TaskLink";
CREATE POLICY tenant_isolation_insert ON "TaskLink"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- TaskComment
ALTER TABLE "TaskComment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskComment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TaskComment";
CREATE POLICY tenant_isolation ON "TaskComment"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TaskComment";
CREATE POLICY tenant_isolation_insert ON "TaskComment"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- TaskWatcher
ALTER TABLE "TaskWatcher" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskWatcher" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TaskWatcher";
CREATE POLICY tenant_isolation ON "TaskWatcher"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TaskWatcher";
CREATE POLICY tenant_isolation_insert ON "TaskWatcher"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- CONTROL SUB-ENTITIES
-- ─────────────────────────────────────

-- ControlContributor
ALTER TABLE "ControlContributor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlContributor" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ControlContributor";
CREATE POLICY tenant_isolation ON "ControlContributor"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ControlContributor";
CREATE POLICY tenant_isolation_insert ON "ControlContributor"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ControlTask
ALTER TABLE "ControlTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlTask" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ControlTask";
CREATE POLICY tenant_isolation ON "ControlTask"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ControlTask";
CREATE POLICY tenant_isolation_insert ON "ControlTask"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ControlEvidenceLink
ALTER TABLE "ControlEvidenceLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlEvidenceLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ControlEvidenceLink";
CREATE POLICY tenant_isolation ON "ControlEvidenceLink"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ControlEvidenceLink";
CREATE POLICY tenant_isolation_insert ON "ControlEvidenceLink"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ControlRequirementLink
ALTER TABLE "ControlRequirementLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlRequirementLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ControlRequirementLink";
CREATE POLICY tenant_isolation ON "ControlRequirementLink"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ControlRequirementLink";
CREATE POLICY tenant_isolation_insert ON "ControlRequirementLink"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- MAPPING/JUNCTION TABLES (with tenantId)
-- ─────────────────────────────────────

-- RiskControl (has tenantId — previously had USING(true), now FIXED)
ALTER TABLE "RiskControl" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RiskControl" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "RiskControl";
CREATE POLICY tenant_isolation ON "RiskControl"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "RiskControl";
CREATE POLICY tenant_isolation_insert ON "RiskControl"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ControlAsset (has tenantId — previously had USING(true), now FIXED)
ALTER TABLE "ControlAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlAsset" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ControlAsset";
CREATE POLICY tenant_isolation ON "ControlAsset"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ControlAsset";
CREATE POLICY tenant_isolation_insert ON "ControlAsset"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- AssetRiskLink
ALTER TABLE "AssetRiskLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetRiskLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AssetRiskLink";
CREATE POLICY tenant_isolation ON "AssetRiskLink"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AssetRiskLink";
CREATE POLICY tenant_isolation_insert ON "AssetRiskLink"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- CLAUSE TRACKER
-- ─────────────────────────────────────

-- ClauseProgress
ALTER TABLE "ClauseProgress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClauseProgress" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ClauseProgress";
CREATE POLICY tenant_isolation ON "ClauseProgress"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ClauseProgress";
CREATE POLICY tenant_isolation_insert ON "ClauseProgress"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- AUDIT & LOGGING
-- ─────────────────────────────────────

-- AuditLog
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditLog";
CREATE POLICY tenant_isolation ON "AuditLog"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditLog";
CREATE POLICY tenant_isolation_insert ON "AuditLog"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- NOTIFICATIONS
-- ─────────────────────────────────────

-- Notification
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Notification";
CREATE POLICY tenant_isolation ON "Notification"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Notification";
CREATE POLICY tenant_isolation_insert ON "Notification"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ReminderHistory (has tenantId — previously had USING(true), now FIXED)
ALTER TABLE "ReminderHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReminderHistory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ReminderHistory";
DROP POLICY IF EXISTS allow_all ON "ReminderHistory";
CREATE POLICY tenant_isolation ON "ReminderHistory"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ReminderHistory";
CREATE POLICY tenant_isolation_insert ON "ReminderHistory"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- NotificationOutbox
ALTER TABLE "NotificationOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationOutbox" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "NotificationOutbox";
CREATE POLICY tenant_isolation ON "NotificationOutbox"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "NotificationOutbox";
CREATE POLICY tenant_isolation_insert ON "NotificationOutbox"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- TenantNotificationSettings
ALTER TABLE "TenantNotificationSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantNotificationSettings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TenantNotificationSettings";
CREATE POLICY tenant_isolation ON "TenantNotificationSettings"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TenantNotificationSettings";
CREATE POLICY tenant_isolation_insert ON "TenantNotificationSettings"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- UserNotificationPreference
ALTER TABLE "UserNotificationPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserNotificationPreference" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "UserNotificationPreference";
CREATE POLICY tenant_isolation ON "UserNotificationPreference"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "UserNotificationPreference";
CREATE POLICY tenant_isolation_insert ON "UserNotificationPreference"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- MEMBERSHIP
-- ─────────────────────────────────────

-- TenantMembership
ALTER TABLE "TenantMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantMembership" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TenantMembership";
CREATE POLICY tenant_isolation ON "TenantMembership"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TenantMembership";
CREATE POLICY tenant_isolation_insert ON "TenantMembership"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- TenantOnboarding
ALTER TABLE "TenantOnboarding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantOnboarding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TenantOnboarding";
CREATE POLICY tenant_isolation ON "TenantOnboarding"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TenantOnboarding";
CREATE POLICY tenant_isolation_insert ON "TenantOnboarding"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- VENDOR MANAGEMENT
-- ─────────────────────────────────────

-- Vendor
ALTER TABLE "Vendor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Vendor" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Vendor";
CREATE POLICY tenant_isolation ON "Vendor"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Vendor";
CREATE POLICY tenant_isolation_insert ON "Vendor"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- VendorContact
ALTER TABLE "VendorContact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VendorContact" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "VendorContact";
CREATE POLICY tenant_isolation ON "VendorContact"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "VendorContact";
CREATE POLICY tenant_isolation_insert ON "VendorContact"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- VendorDocument
ALTER TABLE "VendorDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VendorDocument" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "VendorDocument";
CREATE POLICY tenant_isolation ON "VendorDocument"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "VendorDocument";
CREATE POLICY tenant_isolation_insert ON "VendorDocument"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- VendorAssessment
ALTER TABLE "VendorAssessment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VendorAssessment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "VendorAssessment";
CREATE POLICY tenant_isolation ON "VendorAssessment"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "VendorAssessment";
CREATE POLICY tenant_isolation_insert ON "VendorAssessment"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- VendorAssessmentAnswer
ALTER TABLE "VendorAssessmentAnswer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VendorAssessmentAnswer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "VendorAssessmentAnswer";
CREATE POLICY tenant_isolation ON "VendorAssessmentAnswer"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "VendorAssessmentAnswer";
CREATE POLICY tenant_isolation_insert ON "VendorAssessmentAnswer"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- VendorLink
ALTER TABLE "VendorLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VendorLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "VendorLink";
CREATE POLICY tenant_isolation ON "VendorLink"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "VendorLink";
CREATE POLICY tenant_isolation_insert ON "VendorLink"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- VendorEvidenceBundle
ALTER TABLE "VendorEvidenceBundle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VendorEvidenceBundle" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "VendorEvidenceBundle";
CREATE POLICY tenant_isolation ON "VendorEvidenceBundle"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "VendorEvidenceBundle";
CREATE POLICY tenant_isolation_insert ON "VendorEvidenceBundle"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- VendorEvidenceBundleItem
ALTER TABLE "VendorEvidenceBundleItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VendorEvidenceBundleItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "VendorEvidenceBundleItem";
CREATE POLICY tenant_isolation ON "VendorEvidenceBundleItem"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "VendorEvidenceBundleItem";
CREATE POLICY tenant_isolation_insert ON "VendorEvidenceBundleItem"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- VendorRelationship
ALTER TABLE "VendorRelationship" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VendorRelationship" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "VendorRelationship";
CREATE POLICY tenant_isolation ON "VendorRelationship"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "VendorRelationship";
CREATE POLICY tenant_isolation_insert ON "VendorRelationship"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- AUDIT READINESS
-- ─────────────────────────────────────

-- AuditCycle
ALTER TABLE "AuditCycle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditCycle" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditCycle";
CREATE POLICY tenant_isolation ON "AuditCycle"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditCycle";
CREATE POLICY tenant_isolation_insert ON "AuditCycle"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- AuditPack
ALTER TABLE "AuditPack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditPack" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditPack";
CREATE POLICY tenant_isolation ON "AuditPack"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditPack";
CREATE POLICY tenant_isolation_insert ON "AuditPack"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- AuditPackItem
ALTER TABLE "AuditPackItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditPackItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditPackItem";
CREATE POLICY tenant_isolation ON "AuditPackItem"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditPackItem";
CREATE POLICY tenant_isolation_insert ON "AuditPackItem"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- AuditPackShare
ALTER TABLE "AuditPackShare" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditPackShare" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditPackShare";
CREATE POLICY tenant_isolation ON "AuditPackShare"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditPackShare";
CREATE POLICY tenant_isolation_insert ON "AuditPackShare"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- AuditorAccount
ALTER TABLE "AuditorAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditorAccount" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditorAccount";
CREATE POLICY tenant_isolation ON "AuditorAccount"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditorAccount";
CREATE POLICY tenant_isolation_insert ON "AuditorAccount"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- CONTROL TESTS (Test-of-Control)
-- ─────────────────────────────────────

-- ControlTestPlan
ALTER TABLE "ControlTestPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlTestPlan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ControlTestPlan";
CREATE POLICY tenant_isolation ON "ControlTestPlan"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ControlTestPlan";
CREATE POLICY tenant_isolation_insert ON "ControlTestPlan"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ControlTestRun
ALTER TABLE "ControlTestRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlTestRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ControlTestRun";
CREATE POLICY tenant_isolation ON "ControlTestRun"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ControlTestRun";
CREATE POLICY tenant_isolation_insert ON "ControlTestRun"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ControlTestEvidenceLink
ALTER TABLE "ControlTestEvidenceLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlTestEvidenceLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ControlTestEvidenceLink";
CREATE POLICY tenant_isolation ON "ControlTestEvidenceLink"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ControlTestEvidenceLink";
CREATE POLICY tenant_isolation_insert ON "ControlTestEvidenceLink"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ControlTestStep
ALTER TABLE "ControlTestStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlTestStep" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ControlTestStep";
CREATE POLICY tenant_isolation ON "ControlTestStep"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ControlTestStep";
CREATE POLICY tenant_isolation_insert ON "ControlTestStep"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- FILES
-- ─────────────────────────────────────

-- FileRecord
ALTER TABLE "FileRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FileRecord" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "FileRecord";
CREATE POLICY tenant_isolation ON "FileRecord"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "FileRecord";
CREATE POLICY tenant_isolation_insert ON "FileRecord"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- AI RISK SUGGESTIONS
-- ─────────────────────────────────────

-- RiskSuggestionSession
ALTER TABLE "RiskSuggestionSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RiskSuggestionSession" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "RiskSuggestionSession";
CREATE POLICY tenant_isolation ON "RiskSuggestionSession"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "RiskSuggestionSession";
CREATE POLICY tenant_isolation_insert ON "RiskSuggestionSession"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- RiskSuggestionItem
ALTER TABLE "RiskSuggestionItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RiskSuggestionItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "RiskSuggestionItem";
CREATE POLICY tenant_isolation ON "RiskSuggestionItem"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "RiskSuggestionItem";
CREATE POLICY tenant_isolation_insert ON "RiskSuggestionItem"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- ─────────────────────────────────────
-- BILLING
-- ─────────────────────────────────────

-- BillingAccount
ALTER TABLE "BillingAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingAccount" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BillingAccount";
CREATE POLICY tenant_isolation ON "BillingAccount"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "BillingAccount";
CREATE POLICY tenant_isolation_insert ON "BillingAccount"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- BillingEvent
ALTER TABLE "BillingEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BillingEvent";
CREATE POLICY tenant_isolation ON "BillingEvent"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "BillingEvent";
CREATE POLICY tenant_isolation_insert ON "BillingEvent"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- PolicyVersion (now has tenantId — migrated from allow_all)
ALTER TABLE "PolicyVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PolicyVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PolicyVersion";
CREATE POLICY tenant_isolation ON "PolicyVersion"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "PolicyVersion";
CREATE POLICY tenant_isolation_insert ON "PolicyVersion"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS allow_all ON "PolicyVersion";

-- PolicyApproval — promoted to direct-tenantId (migration
-- 20260521130000_promote_policy_approval_tenant).
ALTER TABLE "PolicyApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PolicyApproval" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PolicyApproval";
CREATE POLICY tenant_isolation ON "PolicyApproval"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "PolicyApproval";
CREATE POLICY tenant_isolation_insert ON "PolicyApproval"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "PolicyApproval";
CREATE POLICY superuser_bypass ON "PolicyApproval"
    USING (current_setting('role') != 'app_user');
DROP POLICY IF EXISTS allow_all ON "PolicyApproval";

-- ═══════════════════════════════════════════════════════════════════
-- TABLES WITHOUT tenantId (handled in rls-fix.sql with USING(true))
-- ═══════════════════════════════════════════════════════════════════
-- PolicyAcknowledgement                                 → isolated via EXISTS on PolicyVersion (20260422180000)
-- FrameworkMapping                                      → global by design (cross-tenant mapping)

-- ═══════════════════════════════════════════════════════════════════
-- 4b) Organization layer — user-scoped (Epic O-1)
-- ═══════════════════════════════════════════════════════════════════
-- `Organization` and `OrgMembership` aren't tenant-scoped — neither
-- carries a `tenantId` column, so the tenant_isolation regime keyed on
-- `current_setting('app.tenant_id')` doesn't fit. They live on a
-- parallel RLS axis keyed on `app.user_id`:
--
--   * Organization → `org_isolation` — visible to an app_user iff
--     they hold an OrgMembership in this org.
--   * OrgMembership → `org_membership_self_isolation` — each user
--     reads only their own membership rows. The admin "list all
--     members of my org" UI runs through the global Prisma client
--     (postgres role); that surface is permission-gated at the API
--     layer, not by RLS.
--
-- The `app_user` policies are USING-only (no WITH CHECK). Under
-- FORCE ROW LEVEL SECURITY an `app_user` can read its own org rows
-- but never INSERT or UPDATE — privileged paths (org-create API,
-- invite redemption, auto-provisioning, seeds, migrations) all run
-- as `postgres` and pass through the canonical `superuser_bypass`
-- added by the loop in section 5 below.
--
-- Idempotent — safe to re-run. Mirrors
-- prisma/migrations/20260426060000_add_organization_layer_rls.

-- ─── Organization ────────────────────────────────────────────────
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "Organization";
CREATE POLICY org_isolation ON "Organization"
    USING (
        EXISTS (
            SELECT 1
            FROM "OrgMembership" om
            WHERE om."organizationId" = "Organization".id
              AND om."userId" = current_setting('app.user_id', true)::text
        )
    );

-- ─── OrgMembership ───────────────────────────────────────────────
ALTER TABLE "OrgMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgMembership" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_membership_self_isolation ON "OrgMembership";
CREATE POLICY org_membership_self_isolation ON "OrgMembership"
    USING ("userId" = current_setting('app.user_id', true)::text);


-- ═══════════════════════════════════════════════════════════════════
-- GLOBAL TABLES (no RLS needed)
-- ═══════════════════════════════════════════════════════════════════
-- Tenant              — root entity, looked up by slug before context set
-- User                — global, cross-tenant identity
-- Account             — auth system table
-- AuthSession         — auth system table
-- VerificationToken   — auth system table
-- Clause              — ISO 27001 clause reference catalog
-- ControlTemplate     — global control template library
-- ControlTemplateTask — template child
-- ControlTemplateRequirementLink — template child
-- Framework           — reference catalog
-- FrameworkRequirement — reference catalog
-- FrameworkPack       — reference catalog
-- PackTemplateLink    — catalog junction
-- PolicyTemplate      — global template library
-- QuestionnaireTemplate — global template library
-- QuestionnaireQuestion — template child
-- RiskTemplate        — global template library


-- ═══════════════════════════════════════════════════════════════════
-- 5) Superuser bypass — allow non-app_user roles (postgres) full access
-- ═══════════════════════════════════════════════════════════════════
-- FORCE ROW LEVEL SECURITY applies policies even to table owners.
-- The auth layer (NextAuth JWT) queries TenantMembership etc. without
-- a tenant context because it's discovering the tenant from the user's
-- membership. This bypass allows those queries while withTenantDb()
-- (SET LOCAL ROLE app_user) still enforces tenant_isolation.

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOR tbl IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relforcerowsecurity = true
        ORDER BY c.relname
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS superuser_bypass ON %I', tbl);
        EXECUTE format(
            'CREATE POLICY superuser_bypass ON %I USING (current_setting(''role'') != ''app_user'')',
            tbl
        );
    END LOOP;
END
$$;

SELECT 'RLS setup complete — all tenant-scoped tables covered!' AS result;
