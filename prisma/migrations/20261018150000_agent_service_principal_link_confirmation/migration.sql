-- A person's confirmation of an agent's Entra service-principal link (#3671,
-- step 2c of the agentic IAM roadmap). Owner decision, 2026-10-18: an
-- UNATTENDED disable of a contained agent's principal needs a person to have
-- confirmed that the discovered principal is that agent's own. The harness
-- scanner's reconciliation alone is enough for DRY_RUN and PROPOSE_ONLY, where
-- a person reads the proposal; it is not enough for AUTOMATIC.
--
-- ONE-WAY, enforced here: the confirmed triple, the confirmer and the time are
-- never rewritten, and the one permitted move is `invalidatedAt` NULL -> a
-- value with its reason code. A confirmation is never re-pointed; the harness
-- ingest invalidates it when the link moves, and a new link needs a new
-- confirmation. `app_user` holds no DELETE.
--
-- Triggers and the partial unique index are invisible to Prisma's schema; the
-- integration suite tests/integration/agent-service-principal-link-confirmation.test.ts
-- is their guard.

CREATE TABLE "AgentServicePrincipalConfirmation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "discoveredAgentId" TEXT NOT NULL,
    "registeredAgentId" TEXT NOT NULL,
    "discoveredId" TEXT NOT NULL,
    "confirmedByUserId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentServicePrincipalConfirmation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentServicePrincipalConfirmation_tenantId_registeredAgentI_idx" ON "AgentServicePrincipalConfirmation"("tenantId", "registeredAgentId");

CREATE INDEX "AgentServicePrincipalConfirmation_tenantId_discoveredAgentI_idx" ON "AgentServicePrincipalConfirmation"("tenantId", "discoveredAgentId");

CREATE UNIQUE INDEX "AgentServicePrincipalConfirmation_id_tenantId_key" ON "AgentServicePrincipalConfirmation"("id", "tenantId");

ALTER TABLE "AgentServicePrincipalConfirmation" ADD CONSTRAINT "AgentServicePrincipalConfirmation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentServicePrincipalConfirmation" ADD CONSTRAINT "AgentServicePrincipalConfirmation_discoveredAgentId_tenant_fkey" FOREIGN KEY ("discoveredAgentId", "tenantId") REFERENCES "DiscoveredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "AgentServicePrincipalConfirmation" ADD CONSTRAINT "AgentServicePrincipalConfirmation_registeredAgentId_tenant_fkey" FOREIGN KEY ("registeredAgentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Only an Entra service principal can be confirmed.
ALTER TABLE "AgentServicePrincipalConfirmation"
    ADD CONSTRAINT "AgentServicePrincipalConfirmation_entra_sp_only"
    CHECK ("discoveredId" LIKE 'entra:sp:%');

-- An invalidation carries its reason, and only a known one.
ALTER TABLE "AgentServicePrincipalConfirmation"
    ADD CONSTRAINT "AgentServicePrincipalConfirmation_invalidation_shape"
    CHECK (
        (("invalidatedAt" IS NULL) = ("invalidatedReason" IS NULL))
        AND ("invalidatedReason" IS NULL
             OR "invalidatedReason" IN ('PRINCIPAL_RELINKED', 'AGENT_RELINKED'))
    );

-- At most one LIVE confirmation per link. Partial, so a re-confirmation after
-- an invalidation is a new row rather than a refused one.
CREATE UNIQUE INDEX "AgentServicePrincipalConfirmation_one_live_per_link"
    ON "AgentServicePrincipalConfirmation"("tenantId", "discoveredAgentId", "registeredAgentId")
    WHERE "invalidatedAt" IS NULL;

CREATE OR REPLACE FUNCTION agent_sp_confirmation_one_way()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
       OR NEW."discoveredAgentId" IS DISTINCT FROM OLD."discoveredAgentId"
       OR NEW."registeredAgentId" IS DISTINCT FROM OLD."registeredAgentId"
       OR NEW."discoveredId" IS DISTINCT FROM OLD."discoveredId"
       OR NEW."confirmedByUserId" IS DISTINCT FROM OLD."confirmedByUserId"
       OR NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION
            'AGENT_SP_CONFIRMATION_ONE_WAY: a confirmation is never re-pointed or rewritten; confirm the new link instead.';
    END IF;
    IF OLD."invalidatedAt" IS NOT NULL
       AND (NEW."invalidatedAt" IS DISTINCT FROM OLD."invalidatedAt"
            OR NEW."invalidatedReason" IS DISTINCT FROM OLD."invalidatedReason") THEN
        RAISE EXCEPTION
            'AGENT_SP_CONFIRMATION_ONE_WAY: an invalidated confirmation stays invalidated.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_sp_confirmation_one_way ON "AgentServicePrincipalConfirmation";
CREATE TRIGGER agent_sp_confirmation_one_way
    BEFORE UPDATE ON "AgentServicePrincipalConfirmation"
    FOR EACH ROW
    EXECUTE FUNCTION agent_sp_confirmation_one_way();

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "AgentServicePrincipalConfirmation" TO app_user;
        REVOKE DELETE ON "AgentServicePrincipalConfirmation" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "AgentServicePrincipalConfirmation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentServicePrincipalConfirmation" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AgentServicePrincipalConfirmation";
CREATE POLICY tenant_isolation ON "AgentServicePrincipalConfirmation"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentServicePrincipalConfirmation";
CREATE POLICY tenant_isolation_insert ON "AgentServicePrincipalConfirmation"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "AgentServicePrincipalConfirmation";
CREATE POLICY superuser_bypass ON "AgentServicePrincipalConfirmation"
    USING (current_setting('role') != 'app_user');
