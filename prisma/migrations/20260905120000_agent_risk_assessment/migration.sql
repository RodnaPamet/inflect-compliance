-- Epic Agentic 3 — the AGENT RISK ASSESSMENT.
--
-- Two GLOBAL reference tables (no tenantId, no RLS — seeded from a fixture) +
-- two TENANT-SCOPED tables (canonical policy triple under FORCE ROW LEVEL
-- SECURITY). The split is copied exactly from the AI-governance self-assessment
-- migration (20260629140000), and the copy is deliberate: getting it backwards
-- either puts a question set that is identical for every customer behind RLS,
-- or publishes one customer's answers about its own agents.
--
-- Also adds `RegisteredAgent.modelRef`. NULLABLE and NOT backfilled: the
-- platform cannot observe which model an agent runs on, so a value there is a
-- declaration, and inventing one for existing rows would be a declaration
-- nobody made. It exists so "the underlying model changed" is a comparison
-- rather than a notion — NULL on both sides is NOT a change.

-- ─── The declared model, on the agent ───────────────────────────────
ALTER TABLE "RegisteredAgent" ADD COLUMN "modelRef" TEXT;

-- ─── Global reference tables ────────────────────────────────────────
CREATE TABLE "AgentAssessmentDomain" (
    "id"          INTEGER NOT NULL,
    "code"        TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sortOrder"   INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AgentAssessmentDomain_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentAssessmentQuestion" (
    "id"           TEXT NOT NULL,
    "domainId"     INTEGER NOT NULL,
    "text"         TEXT NOT NULL,
    "guidance"     TEXT,
    "mappingsJson" JSONB NOT NULL,
    "criticality"  TEXT NOT NULL,
    CONSTRAINT "AgentAssessmentQuestion_pkey" PRIMARY KEY ("id")
);

-- ─── Tenant-scoped runs ─────────────────────────────────────────────
CREATE TABLE "AgentRiskAssessment" (
    "id"                   TEXT NOT NULL,
    "tenantId"             TEXT NOT NULL,
    "agentId"              TEXT NOT NULL,
    "status"               TEXT NOT NULL DEFAULT 'DRAFT',
    "questionSetVersion"   INTEGER NOT NULL DEFAULT 1,
    "scoredTier"           "AgentRiskTier",
    "score"                INTEGER,
    "scoreBreakdownJson"   JSONB,
    "basisAutonomyLevel"   INTEGER,
    "basisDataAccessScope" "AgentDataAccessScope",
    "basisReversibility"   "AgentReversibility",
    "basisProvenance"      "AgentProvenance",
    "basisToolCount"       INTEGER,
    "basisModelRef"        TEXT,
    "staleAt"              TIMESTAMP(3),
    "staleTriggers"        TEXT[],
    "createdById"          TEXT,
    "startedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"          TIMESTAMP(3),
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentRiskAssessment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentRiskAssessmentAnswer" (
    "id"           TEXT NOT NULL,
    "tenantId"     TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "questionId"   TEXT NOT NULL,
    "answer"       TEXT NOT NULL,
    "note"         TEXT,
    "answeredById" TEXT,
    "answeredAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentRiskAssessmentAnswer_pkey" PRIMARY KEY ("id")
);

-- ─── Indexes ────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "AgentAssessmentDomain_code_key" ON "AgentAssessmentDomain"("code");
CREATE INDEX "AgentAssessmentQuestion_domainId_idx" ON "AgentAssessmentQuestion"("domainId");

-- Composite parent key, so answers can never point cross-tenant.
CREATE UNIQUE INDEX "AgentRiskAssessment_id_tenantId_key" ON "AgentRiskAssessment"("id", "tenantId");
-- The read every surface here makes: this tenant's runs for one agent.
CREATE INDEX "AgentRiskAssessment_tenantId_agentId_idx" ON "AgentRiskAssessment"("tenantId", "agentId");
CREATE INDEX "AgentRiskAssessment_tenantId_updatedAt_idx" ON "AgentRiskAssessment"("tenantId", "updatedAt");
CREATE INDEX "AgentRiskAssessment_tenantId_status_idx" ON "AgentRiskAssessment"("tenantId", "status");

CREATE UNIQUE INDEX "AgentRiskAssessmentAnswer_assessmentId_questionId_key" ON "AgentRiskAssessmentAnswer"("assessmentId", "questionId");
CREATE INDEX "AgentRiskAssessmentAnswer_tenantId_assessmentId_idx" ON "AgentRiskAssessmentAnswer"("tenantId", "assessmentId");
CREATE INDEX "AgentRiskAssessmentAnswer_questionId_idx" ON "AgentRiskAssessmentAnswer"("questionId");

-- ─── Foreign keys ───────────────────────────────────────────────────
ALTER TABLE "AgentAssessmentQuestion"
    ADD CONSTRAINT "AgentAssessmentQuestion_domainId_fkey"
    FOREIGN KEY ("domainId") REFERENCES "AgentAssessmentDomain"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AgentRiskAssessment"
    ADD CONSTRAINT "AgentRiskAssessment_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FK to the agent's (id, tenantId) parent key: an assessment can
-- never name another tenant's agent, and Postgres enforces it even though it
-- runs FK checks as the table owner and therefore bypasses row security.
-- CASCADE, like RegisteredAgentTool and unlike AgentProposal: an assessment is
-- a judgement ABOUT an agent, and a judgement about a row that no longer exists
-- caps nothing.
ALTER TABLE "AgentRiskAssessment"
    ADD CONSTRAINT "AgentRiskAssessment_agentId_tenantId_fkey"
    FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRiskAssessmentAnswer"
    ADD CONSTRAINT "AgentRiskAssessmentAnswer_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRiskAssessmentAnswer"
    ADD CONSTRAINT "AgentRiskAssessmentAnswer_assessmentId_tenantId_fkey"
    FOREIGN KEY ("assessmentId", "tenantId") REFERENCES "AgentRiskAssessment"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: the question set is global reference content, and a
-- question retired from the fixture must not silently delete the answers that
-- cite it in completed assessments. A seed that would orphan answers fails
-- loudly instead.
ALTER TABLE "AgentRiskAssessmentAnswer"
    ADD CONSTRAINT "AgentRiskAssessmentAnswer_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "AgentAssessmentQuestion"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-Level Security (Epic A.1)
-- ═══════════════════════════════════════════════════════════════════
-- AgentAssessmentDomain + AgentAssessmentQuestion are GLOBAL reference tables
-- (no tenantId) — no tenant RLS, only the app_user grant. AgentRiskAssessment +
-- …Answer are tenant-scoped: canonical tenant_isolation +
-- tenant_isolation_insert + superuser_bypass under FORCE ROW LEVEL SECURITY.
-- `tenantId` is NOT NULL on both, so the split USING / WITH CHECK form is
-- correct and the single-policy exception UserSession needs does not apply.

-- 1) app_user grants
GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentAssessmentDomain" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentAssessmentQuestion" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentRiskAssessment" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentRiskAssessmentAnswer" TO app_user;

-- 2) Enable + FORCE RLS on the tenant-scoped tables
ALTER TABLE "AgentRiskAssessment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRiskAssessment" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AgentRiskAssessmentAnswer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRiskAssessmentAnswer" FORCE ROW LEVEL SECURITY;

-- 3) tenant_isolation (USING) + tenant_isolation_insert (WITH CHECK)
DROP POLICY IF EXISTS tenant_isolation ON "AgentRiskAssessment";
CREATE POLICY tenant_isolation ON "AgentRiskAssessment"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentRiskAssessment";
CREATE POLICY tenant_isolation_insert ON "AgentRiskAssessment"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation ON "AgentRiskAssessmentAnswer";
CREATE POLICY tenant_isolation ON "AgentRiskAssessmentAnswer"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentRiskAssessmentAnswer";
CREATE POLICY tenant_isolation_insert ON "AgentRiskAssessmentAnswer"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- 4) superuser_bypass — non-app_user roles (postgres) keep full access
DROP POLICY IF EXISTS superuser_bypass ON "AgentRiskAssessment";
CREATE POLICY superuser_bypass ON "AgentRiskAssessment"
    USING (current_setting('role') != 'app_user');
DROP POLICY IF EXISTS superuser_bypass ON "AgentRiskAssessmentAnswer";
CREATE POLICY superuser_bypass ON "AgentRiskAssessmentAnswer"
    USING (current_setting('role') != 'app_user');
