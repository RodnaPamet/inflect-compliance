-- ═══════════════════════════════════════════════════════════════════
-- RLS Fix for tables WITHOUT a tenantId column
-- ═══════════════════════════════════════════════════════════════════
-- 
-- Some of these tables are tenant-scoped ONLY by relationship (FK chains to
-- parent tables that have tenantId + RLS) and still use USING(true) WITH
-- CHECK(true) — each should gain its own tenantId column in a future migration.
--
-- IMPORTANT: several tables here (PolicyApproval, EvidenceReview,
-- FindingEvidence, AuditChecklistItem, AuditorPackAccess) HAVE SINCE been
-- promoted to a NOT NULL tenantId column + canonical Class-A RLS by the
-- denorm-tenantId migrations (20260423200000 etc.) / rls-setup.sql. For those,
-- this file must RE-ASSERT the canonical tenant_isolation trio — NOT recreate
-- allow_all, which (because this file is "safe to re-run") silently re-opened
-- them to cross-tenant access. Those stanzas are corrected below.
--
-- This script is fully IDEMPOTENT — safe to re-run at any time.
-- ═══════════════════════════════════════════════════════════════════

-- PolicyVersion: REMOVED — now has tenantId column, handled in rls-setup.sql

-- PolicyApproval (HAS tenantId — canonical tenant_isolation, NOT allow_all).
-- Promoted to direct-tenantId RLS (see rls-setup.sql); re-asserted idempotently.
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

-- PolicyAcknowledgement (no tenantId — child of PolicyVersion)
DROP POLICY IF EXISTS tenant_isolation ON "PolicyAcknowledgement";
DROP POLICY IF EXISTS tenant_isolation_insert ON "PolicyAcknowledgement";
DROP POLICY IF EXISTS allow_all ON "PolicyAcknowledgement";
ALTER TABLE "PolicyAcknowledgement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PolicyAcknowledgement" FORCE ROW LEVEL SECURITY;
CREATE POLICY allow_all ON "PolicyAcknowledgement" USING (true) WITH CHECK (true);

-- PolicyControlLink (no tenantId — junction of Policy × Control)
-- Isolation via EXISTS against parent tables.
--
-- IMPORTANT: We use a SINGLE policy with both USING and WITH CHECK because
-- PostgreSQL's permissive policy semantics mean that a FOR ALL USING clause
-- implicitly doubles as WITH CHECK for inserts. If we had two separate
-- permissive policies (one FOR ALL checking only Policy, one FOR INSERT
-- checking both Policy+Control), the FOR ALL USING would pass for inserts
-- where the Policy belongs to the tenant—even if the Control doesn't.
--
-- USING:       visible if the linked Policy belongs to the current tenant
-- WITH CHECK:  insertable only if BOTH Policy AND Control belong to tenant
DROP POLICY IF EXISTS tenant_isolation ON "PolicyControlLink";
DROP POLICY IF EXISTS tenant_isolation_insert ON "PolicyControlLink";
DROP POLICY IF EXISTS allow_all ON "PolicyControlLink";
ALTER TABLE "PolicyControlLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PolicyControlLink" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "PolicyControlLink"
    USING (
        EXISTS (
            SELECT 1 FROM "Policy" p
            WHERE p.id = "policyId"
              AND p."tenantId" = current_setting('app.tenant_id', true)::text
        )
    )
    WITH CHECK (
        -- INSERT/UPDATE: the Policy must belong to the current tenant
        EXISTS (
            SELECT 1 FROM "Policy" p
            WHERE p.id = "policyId"
              AND p."tenantId" = current_setting('app.tenant_id', true)::text
        )
        AND
        -- INSERT/UPDATE: the Control must belong to the current tenant (or be global)
        EXISTS (
            SELECT 1 FROM "Control" c
            WHERE c.id = "controlId"
              AND (c."tenantId" IS NULL OR c."tenantId" = current_setting('app.tenant_id', true)::text)
        )
    );

-- EvidenceReview (HAS tenantId — canonical tenant_isolation, NOT allow_all).
-- Promoted to NOT NULL tenantId + composite parent FK + canonical RLS by the
-- denorm-tenantId migration; re-asserted idempotently (was recreating allow_all).
ALTER TABLE "EvidenceReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EvidenceReview" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "EvidenceReview";
CREATE POLICY tenant_isolation ON "EvidenceReview"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "EvidenceReview";
CREATE POLICY tenant_isolation_insert ON "EvidenceReview"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "EvidenceReview";
CREATE POLICY superuser_bypass ON "EvidenceReview"
    USING (current_setting('role') != 'app_user');
DROP POLICY IF EXISTS allow_all ON "EvidenceReview";

-- FindingEvidence (HAS tenantId — canonical tenant_isolation, NOT allow_all).
-- Promoted to NOT NULL tenantId + two composite parent FKs + canonical RLS by
-- the denorm-tenantId migration; re-asserted idempotently (was recreating allow_all).
ALTER TABLE "FindingEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FindingEvidence" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "FindingEvidence";
CREATE POLICY tenant_isolation ON "FindingEvidence"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "FindingEvidence";
CREATE POLICY tenant_isolation_insert ON "FindingEvidence"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "FindingEvidence";
CREATE POLICY superuser_bypass ON "FindingEvidence"
    USING (current_setting('role') != 'app_user');
DROP POLICY IF EXISTS allow_all ON "FindingEvidence";

-- AuditChecklistItem (HAS tenantId — canonical tenant_isolation, NOT allow_all)
-- Migration 20260423200000_denorm_tenantid_phase3_simplify_rls added a NOT NULL
-- tenantId column + composite parent FK (auditId, tenantId) → Audit(id, tenantId)
-- and swapped this table onto the canonical Class-A RLS. Re-assert that exact
-- shape here (idempotently) and drop any stale allow_all. The previous stanza
-- dropped tenant_isolation and recreated allow_all USING(true) — re-running this
-- "safe to re-run" file silently re-opened the table to cross-tenant access.
ALTER TABLE "AuditChecklistItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditChecklistItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditChecklistItem";
CREATE POLICY tenant_isolation ON "AuditChecklistItem"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditChecklistItem";
CREATE POLICY tenant_isolation_insert ON "AuditChecklistItem"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AuditChecklistItem";
CREATE POLICY superuser_bypass ON "AuditChecklistItem"
    USING (current_setting('role') != 'app_user');
DROP POLICY IF EXISTS allow_all ON "AuditChecklistItem";

-- AuditorPackAccess (HAS tenantId — canonical tenant_isolation, NOT allow_all)
-- Same Phase-3 migration (20260423200000): NOT NULL tenantId + two composite
-- parent FKs (auditPackId, tenantId) → AuditPack and (auditorId, tenantId) →
-- AuditorAccount. Canonical Class-A RLS, re-asserted idempotently here; drop any
-- stale allow_all. The previous stanza recreated allow_all USING(true), undoing
-- the migration on every re-run of this file.
ALTER TABLE "AuditorPackAccess" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditorPackAccess" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditorPackAccess";
CREATE POLICY tenant_isolation ON "AuditorPackAccess"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditorPackAccess";
CREATE POLICY tenant_isolation_insert ON "AuditorPackAccess"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AuditorPackAccess";
CREATE POLICY superuser_bypass ON "AuditorPackAccess"
    USING (current_setting('role') != 'app_user');
DROP POLICY IF EXISTS allow_all ON "AuditorPackAccess";

-- ═══════════════════════════════════════════════════════════════════
-- GLOBAL TABLES — no RLS needed
-- ═══════════════════════════════════════════════════════════════════
-- User, Account, AuthSession, VerificationToken, Tenant
-- Clause, ControlTemplate, ControlTemplateTask, ControlTemplateRequirementLink
-- Framework, FrameworkRequirement, FrameworkPack, PackTemplateLink, FrameworkMapping
-- PolicyTemplate, QuestionnaireTemplate, QuestionnaireQuestion, RiskTemplate

SELECT 'RLS fix applied!' AS result;
