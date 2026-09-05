-- Tool-manifest pinning + receipt tool provenance (OWASP ASI04, tool poisoning).
--
-- A tool definition is three fields the model reads — name, DESCRIPTION and
-- parameter schema — and only the first is ever visible in a normal session. The
-- description is instruction text delivered straight into the agent's context by
-- `tools/list`, which makes it the field an attacker edits expecting nobody to
-- look. "McpToolManifestPin" is the tenant's record of the definition it has
-- seen; the MCP boundary refuses a tool whose live definition no longer matches,
-- until a named human re-approves it.
--
-- Two changes, deliberately in one migration because they are two halves of one
-- claim:
--
--   1. CREATE "McpToolManifestPin" — tenant-scoped, canonical policy triple +
--      FORCE ROW LEVEL SECURITY.
--   2. ALTER "AgentActionReceipt" — four NULLABLE provenance columns, so a
--      receipt can answer "which version of which tool description produced this
--      action" years after the description has been fixed.
--
-- ROLLING-DEPLOY SAFETY. The new table is created empty and no already-running
-- container writes it. The four receipt columns are added NULLABLE with no
-- default and no backfill, so an old container's INSERT — which names none of
-- them — still succeeds. There is no `ALTER TYPE` anywhere: `approvalSource` and
-- `toolProvenance` are TEXT with CHECK constraints rather than Postgres enums,
-- for the reason the `@@map("WorkItem*")` pins record — an enum rename or value
-- add mid-deploy makes still-running old containers fail with SQLSTATE 42704.

-- ─── Table ──────────────────────────────────────────────────────────
CREATE TABLE "McpToolManifestPin" (
    "id"                   TEXT NOT NULL,
    "tenantId"             TEXT NOT NULL,
    "toolName"             TEXT NOT NULL,
    "descriptionHash"      TEXT NOT NULL,
    "schemaHash"           TEXT NOT NULL,
    "manifestHash"         TEXT NOT NULL,
    "approvalSource"       TEXT NOT NULL,
    "approvedByUserId"     TEXT,
    "approvedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision"             INTEGER NOT NULL DEFAULT 1,
    "previousManifestHash" TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "McpToolManifestPin_pkey" PRIMARY KEY ("id")
);

-- ─── Value constraints ──────────────────────────────────────────────
-- The accountability invariant, at the database rather than only at the usecase:
-- a BASELINE row is trust-on-first-use and has NO approver and NOTHING it
-- displaced; an APPROVED row is a person accepting a definition and MUST name
-- them. Without this, a write path that forgot the approver would produce rows
-- indistinguishable from baselines, and "did a human accept this description"
-- would stop being answerable from the table — which is the single question the
-- table exists to answer.
ALTER TABLE "McpToolManifestPin"
    ADD CONSTRAINT "McpToolManifestPin_approval_accountability"
    CHECK (
        ("approvalSource" = 'BASELINE'
            AND "approvedByUserId" IS NULL
            AND "previousManifestHash" IS NULL)
        OR ("approvalSource" = 'APPROVED' AND "approvedByUserId" IS NOT NULL)
    );

ALTER TABLE "McpToolManifestPin"
    ADD CONSTRAINT "McpToolManifestPin_revision_positive"
    CHECK ("revision" >= 1);

-- ─── Indexes ────────────────────────────────────────────────────────
-- One pin per (tenant, tool). Tenant-leading, so it doubles as the tenant-scoped
-- lookup index: every query this table serves is `tenantId` alone or
-- `tenantId + toolName`, and a separate "McpToolManifestPin_tenantId_idx" would
-- be a second copy of this index's leading column with nothing to serve.
CREATE UNIQUE INDEX "McpToolManifestPin_tenantId_toolName_key"
    ON "McpToolManifestPin"("tenantId", "toolName");

-- ─── Foreign keys ───────────────────────────────────────────────────
ALTER TABLE "McpToolManifestPin"
    ADD CONSTRAINT "McpToolManifestPin_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-Level Security (Epic A.1)
-- ═══════════════════════════════════════════════════════════════════
-- `tenantId` is NOT NULL, so the split USING / WITH CHECK form is correct and
-- the single-policy exception UserSession needs does not apply.

-- 1) app_user grants
GRANT SELECT, INSERT, UPDATE, DELETE ON "McpToolManifestPin" TO app_user;

-- 2) Enable + FORCE RLS
ALTER TABLE "McpToolManifestPin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "McpToolManifestPin" FORCE ROW LEVEL SECURITY;

-- 3) tenant_isolation (USING) + tenant_isolation_insert (WITH CHECK)
DROP POLICY IF EXISTS tenant_isolation ON "McpToolManifestPin";
CREATE POLICY tenant_isolation ON "McpToolManifestPin"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "McpToolManifestPin";
CREATE POLICY tenant_isolation_insert ON "McpToolManifestPin"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- 4) superuser_bypass — non-app_user roles (postgres) keep full access
DROP POLICY IF EXISTS superuser_bypass ON "McpToolManifestPin";
CREATE POLICY superuser_bypass ON "McpToolManifestPin"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- Receipt tool provenance
-- ═══════════════════════════════════════════════════════════════════
-- NULLABLE and NOT backfilled. A NULL here is not a migration convenience — it
-- is the honest record for a receipt whose tool this build does not define (an
-- external mediator sees calls to third-party MCP servers too), and for every
-- row written before this column existed. Inventing a hash for either would make
-- the column unreadable as evidence.
ALTER TABLE "AgentActionReceipt" ADD COLUMN "toolProvenance"       TEXT;
ALTER TABLE "AgentActionReceipt" ADD COLUMN "toolDescriptionHash"  TEXT;
ALTER TABLE "AgentActionReceipt" ADD COLUMN "toolManifestHash"     TEXT;
ALTER TABLE "AgentActionReceipt" ADD COLUMN "toolManifestRevision" INTEGER;

-- The provenance vocabulary, pinned so a typo cannot create a third silent
-- class. NULL is permitted for the pre-existing rows this migration does not
-- touch.
ALTER TABLE "AgentActionReceipt"
    ADD CONSTRAINT "AgentActionReceipt_tool_provenance_known"
    CHECK (
        "toolProvenance" IS NULL
        OR "toolProvenance" IN (
            'inflect:builtin',
            'unattested',
            -- Our tool, but the pin on file was approved AFTER the action
            -- occurred, so the definition in front of the agent is not the one
            -- we hold. The three digest columns are NULL alongside it: saying
            -- "we do not know" beats recording a definition nobody observed.
            'pin-moved-since-action'
        )
    );
