-- Epic Agentic 2 — DENY-BY-DEFAULT MCP tool exposure.
--
-- One row per (agent, tool) a tenant has deliberately granted. The MCP server
-- offering a tool is not permission to call it: `/api/mcp` refuses any tool an
-- agent has no row for. Creating the table therefore creates NO grants, which
-- is the intended starting state — see the note below on why that is safe here
-- and would not have been before the register shipped.
--
-- NO BACKFILL, ON PURPOSE. A backfill that granted every existing agent every
-- tool would have made the feature a no-op on the only tenants that have agents
-- today, which is the shape where a control ships switched off and nobody
-- notices for a year. It is affordable because the register itself is new: the
-- `RegisteredAgent` table was created two migrations ago and the only rows it
-- can hold are the SUSPENDED legacy placeholder (which the gate refuses anyway)
-- and agents an operator registered by hand since. An operator granting the
-- tools their agent needs is one POST per tool, and the denial audit row names
-- the tool it wanted.

CREATE TABLE "RegisteredAgentTool" (
    "id"              TEXT NOT NULL,
    "tenantId"        TEXT NOT NULL,
    "agentId"         TEXT NOT NULL,
    "toolName"        TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegisteredAgentTool_pkey" PRIMARY KEY ("id")
);

-- One grant per (agent, tool). Tenant-leading, so it also serves the
-- tenant-scoped lookup and no separate index is needed for it.
CREATE UNIQUE INDEX "RegisteredAgentTool_tenantId_agentId_toolName_key"
    ON "RegisteredAgentTool"("tenantId", "agentId", "toolName");
-- The read every MCP invocation makes: all tools granted to one agent.
CREATE INDEX "RegisteredAgentTool_tenantId_agentId_idx"
    ON "RegisteredAgentTool"("tenantId", "agentId");

ALTER TABLE "RegisteredAgentTool"
    ADD CONSTRAINT "RegisteredAgentTool_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FK to the agent's (id, tenantId) parent key: a grant can never name
-- another tenant's agent, and Postgres enforces it even though it runs FK
-- checks as the table owner and therefore bypasses row security.
--
-- CASCADE, where AgentProposal's equivalent FK is RESTRICT. The two are
-- different kinds of row: a proposal is HISTORY and must outlive the agent that
-- made it, a grant is AUTHORITY and must not.
ALTER TABLE "RegisteredAgentTool"
    ADD CONSTRAINT "RegisteredAgentTool_agentId_tenantId_fkey"
    FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row Level Security ─────────────────────────────────────────────
--
-- The canonical triple. `tenantId` is NOT NULL here, so the split
-- USING / WITH CHECK form is correct and the single-policy exception that
-- `UserSession` needs does not apply.

ALTER TABLE "RegisteredAgentTool" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RegisteredAgentTool" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "RegisteredAgentTool";
CREATE POLICY tenant_isolation ON "RegisteredAgentTool"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "RegisteredAgentTool";
CREATE POLICY tenant_isolation_insert ON "RegisteredAgentTool"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "RegisteredAgentTool";
CREATE POLICY superuser_bypass ON "RegisteredAgentTool"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "RegisteredAgentTool" TO app_user;
