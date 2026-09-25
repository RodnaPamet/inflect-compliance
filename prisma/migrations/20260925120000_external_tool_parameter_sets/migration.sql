-- Tenant-configured PARAMETERS for external tools, never tenant-configured
-- capabilities (#2860).
--
-- The agentic spine is `effective = min(key.maxAutonomyLevel, agent.autonomyLevel,
-- tierCap)` with NO TERM CAN WIDEN, stated in six files. A tenant-authored
-- ACTION would be a configuration term that widens, which the model forbids
-- outright. A tenant-authored ARGUMENT is not: the grant decides what the agent
-- may call, the external server's pinned schema decides what shape the call may
-- take, and this table only decides what is asked WITHIN that.
--
-- WHY THE PENDING COLUMNS EXIST. Editing a saved set requires the same authority
-- that granted the tool, and a changed set does not take effect until a human
-- accepts it. So an edit lands in the `pending*` columns while the agent keeps
-- dispatching `parameters`. Without the split, an authorised edit would
-- re-point a live agent's query with no reviewed moment — the same failure
-- `McpToolManifestPin` prevents one layer up, for text somebody else wrote.
--
-- WHY NO VERSION TABLE. The arguments a run actually sent are already recorded:
-- the `TOOL_CALL` step stores `input` as dispatched. This table answers only
-- "what is in force, at which revision"; a `*Version` child would be a second,
-- divergent answer to a question the run ledger already settles.
--
-- ROLLING-DEPLOY SAFETY. The table is created empty and no already-running
-- container writes it. No `ALTER TYPE` anywhere — `approvalSource` is TEXT with
-- a CHECK rather than a Postgres enum, because an enum value added mid-deploy
-- makes still-running old containers fail with SQLSTATE 42704.

-- ─── Table ──────────────────────────────────────────────────────────
CREATE TABLE "ExternalToolParameterSet" (
    "id"                TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "toolName"          TEXT NOT NULL,
    "label"             TEXT NOT NULL,
    "parameters"        JSONB NOT NULL,
    "parametersHash"    TEXT NOT NULL,
    "revision"          INTEGER NOT NULL DEFAULT 1,
    "approvalSource"    TEXT NOT NULL,
    "approvedByUserId"  TEXT,
    "approvedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousHash"      TEXT,
    "pendingParameters" JSONB,
    "pendingHash"       TEXT,
    "pendingByUserId"   TEXT,
    "pendingAt"         TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalToolParameterSet_pkey" PRIMARY KEY ("id")
);

-- ─── Value constraints ──────────────────────────────────────────────
-- The accountability invariant, at the database rather than only at the
-- usecase: a BASELINE row is the first set anybody saved and has NO approver
-- and NOTHING it displaced; an APPROVED row is a person accepting a CHANGE and
-- must name them. Without this, a write path that forgot the approver would
-- produce rows indistinguishable from baselines, and "did a human accept this
-- query" would stop being answerable from the table.
ALTER TABLE "ExternalToolParameterSet"
    ADD CONSTRAINT "ExternalToolParameterSet_approval_accountability"
    CHECK (
        ("approvalSource" = 'BASELINE'
            AND "approvedByUserId" IS NULL
            AND "previousHash" IS NULL)
        OR ("approvalSource" = 'APPROVED' AND "approvedByUserId" IS NOT NULL)
    );

ALTER TABLE "ExternalToolParameterSet"
    ADD CONSTRAINT "ExternalToolParameterSet_revision_positive"
    CHECK ("revision" >= 1);

-- A pending edit is FOUR facts — the values, their digest, who proposed them
-- and when — and a row carrying some of them is not interpretable. Half a
-- pending edit would be read by the approval path as "there is something to
-- approve" while being unable to say what or by whom, which is worse than no
-- pending edit at all. All four, or none.
ALTER TABLE "ExternalToolParameterSet"
    ADD CONSTRAINT "ExternalToolParameterSet_pending_is_whole"
    CHECK (
        ("pendingParameters" IS NULL
            AND "pendingHash" IS NULL
            AND "pendingByUserId" IS NULL
            AND "pendingAt" IS NULL)
        OR ("pendingParameters" IS NOT NULL
            AND "pendingHash" IS NOT NULL
            AND "pendingByUserId" IS NOT NULL
            AND "pendingAt" IS NOT NULL)
    );

-- ─── Indexes ────────────────────────────────────────────────────────
-- One set per (tenant, tool, label). Tenant-leading, so it doubles as the
-- tenant-scoped lookup index: every query this table serves is `tenantId`,
-- `tenantId + toolName`, or all three, and a separate tenantId index would be
-- a second copy of this one's leading column with nothing to serve.
CREATE UNIQUE INDEX "ExternalToolParameterSet_tenantId_toolName_label_key"
    ON "ExternalToolParameterSet"("tenantId", "toolName", "label");

-- ─── Foreign keys ───────────────────────────────────────────────────
ALTER TABLE "ExternalToolParameterSet"
    ADD CONSTRAINT "ExternalToolParameterSet_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-Level Security (Epic A.1)
-- ═══════════════════════════════════════════════════════════════════
-- `tenantId` is NOT NULL, so the split USING / WITH CHECK form is correct.

-- 1) app_user grants
GRANT SELECT, INSERT, UPDATE, DELETE ON "ExternalToolParameterSet" TO app_user;

-- 2) Enable + FORCE RLS
ALTER TABLE "ExternalToolParameterSet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalToolParameterSet" FORCE ROW LEVEL SECURITY;

-- 3) tenant_isolation (USING) + tenant_isolation_insert (WITH CHECK)
DROP POLICY IF EXISTS tenant_isolation ON "ExternalToolParameterSet";
CREATE POLICY tenant_isolation ON "ExternalToolParameterSet"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ExternalToolParameterSet";
CREATE POLICY tenant_isolation_insert ON "ExternalToolParameterSet"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- 4) superuser_bypass — non-app_user roles (postgres) keep full access
DROP POLICY IF EXISTS superuser_bypass ON "ExternalToolParameterSet";
CREATE POLICY superuser_bypass ON "ExternalToolParameterSet"
    USING (current_setting('role') != 'app_user');
