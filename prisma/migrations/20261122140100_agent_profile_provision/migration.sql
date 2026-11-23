-- AgentProfileProvision (Step 5b of docs/claude-managed-agents-design.md, #4165).
--
-- One row per Managed Agent Inflect wrote for an approved profile version in a
-- customer's Anthropic workspace: the agent's id and version, the environment,
-- and the SHA-256 of the `system` and `tools` the request carried, which a run
-- compares with the agent as Anthropic returns it before it creates a session
-- (AGENT_DRIFTED).
--
-- ADDITIVE ONLY. Nothing writes this table in production in this deploy: a
-- provision happens on approval only for a tenant whose engine is
-- MANAGED_AGENTS, a mode no writer accepts, and DRIVER_IMPLEMENTED is false.
--
-- profileId, profileVersionId and connectionId are plain ids, never foreign
-- keys: Step 5c archives every agent recorded here on purge or on connection
-- removal, and a cascade would delete the record before that clean-up reads it.

-- CreateTable
CREATE TABLE "AgentProfileProvision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "profileVersionId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "anthropicAgentId" TEXT NOT NULL,
    "anthropicAgentVersion" INTEGER NOT NULL,
    "environmentId" TEXT NOT NULL,
    "systemHash" TEXT NOT NULL,
    "toolsHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentProfileProvision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AgentProfileProvision_agent_version_positive" CHECK ("anthropicAgentVersion" >= 1),
    CONSTRAINT "AgentProfileProvision_hash_shape" CHECK (
        "systemHash" ~ '^[0-9a-f]{64}$' AND "toolsHash" ~ '^[0-9a-f]{64}$'
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfileProvision_tenantId_profileVersionId_connectionI_key" ON "AgentProfileProvision"("tenantId", "profileVersionId", "connectionId");

-- CreateIndex
CREATE INDEX "AgentProfileProvision_tenantId_profileId_connectionId_idx" ON "AgentProfileProvision"("tenantId", "profileId", "connectionId");

-- CreateIndex
CREATE INDEX "AgentProfileProvision_tenantId_connectionId_idx" ON "AgentProfileProvision"("tenantId", "connectionId");

-- AddForeignKey
ALTER TABLE "AgentProfileProvision" ADD CONSTRAINT "AgentProfileProvision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentProfileProvision" TO app_user;

ALTER TABLE "AgentProfileProvision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentProfileProvision" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AgentProfileProvision";
CREATE POLICY tenant_isolation ON "AgentProfileProvision"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentProfileProvision";
CREATE POLICY tenant_isolation_insert ON "AgentProfileProvision"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "AgentProfileProvision";
CREATE POLICY superuser_bypass ON "AgentProfileProvision"
    USING (current_setting('role') != 'app_user');
