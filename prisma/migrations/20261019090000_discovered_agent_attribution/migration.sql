-- The newest PARSED owner suggestion of a `discovered-agent-review` run, one
-- row per discovered agent (#3728, a follow-up of #3712 under the agentic IAM
-- roadmap #3654). The harness tab's Register dialog shows it to the person who
-- chooses the owner; the registration intake records it as provenance when the
-- person keeps it. It is never the owner.
--
-- A NEW TABLE on purpose, rather than columns on `DiscoveredAgent` (whose one
-- writer is the harness ingest, `tests/guards/agent-harness-single-write-seam.test.ts`)
-- or on `WorkflowRun` (whose input is sealed and encrypted, so "the suggestion
-- for agent X" could not be read without opening every run). One writer,
-- `usecases/agent-harness-attribution.ts`, keyed by the discovered agent.
--
-- `proposedOwnerRef` and `signalsJson` hold model output and are encrypted at
-- rest by the Epic B manifest; the CHECKs below hold the closed vocabularies
-- and the shape the output contract (`parseOwnershipAttribution`) already
-- guarantees, so a row the writer could not have written is refused here too.

CREATE TABLE "DiscoveredAgentAttribution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "discoveredAgentId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "grade" TEXT,
    "unmatchedReason" TEXT,
    "signalsJson" TEXT NOT NULL,
    "proposedOwnerRef" TEXT,
    "runCompletedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredAgentAttribution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiscoveredAgentAttribution_tenantId_runId_idx" ON "DiscoveredAgentAttribution"("tenantId", "runId");

CREATE UNIQUE INDEX "DiscoveredAgentAttribution_tenantId_discoveredAgentId_key" ON "DiscoveredAgentAttribution"("tenantId", "discoveredAgentId");

ALTER TABLE "DiscoveredAgentAttribution" ADD CONSTRAINT "DiscoveredAgentAttribution_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscoveredAgentAttribution" ADD CONSTRAINT "DiscoveredAgentAttribution_discoveredAgentId_tenantId_fkey" FOREIGN KEY ("discoveredAgentId", "tenantId") REFERENCES "DiscoveredAgent"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscoveredAgentAttribution" ADD CONSTRAINT "DiscoveredAgentAttribution_runId_tenantId_fkey" FOREIGN KEY ("runId", "tenantId") REFERENCES "WorkflowRun"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- The contract's closed vocabularies, and its shape: a grade and a named person
-- only on SUGGESTED, a reason only on UNMATCHED. `LINKED` (and any word for an
-- owner already decided) is not a status this table can hold.
ALTER TABLE "DiscoveredAgentAttribution"
    ADD CONSTRAINT "DiscoveredAgentAttribution_shape"
    CHECK (
        "status" IN ('SUGGESTED', 'AMBIGUOUS', 'UNMATCHED')
        AND ("grade" IS NULL OR "grade" IN ('STRONG', 'WEAK'))
        AND ("unmatchedReason" IS NULL OR "unmatchedReason" IN ('NO_OWNER_SIGNAL', 'OWNER_DEPARTED'))
        AND (("status" = 'SUGGESTED') = ("grade" IS NOT NULL))
        AND (("status" = 'SUGGESTED') = ("proposedOwnerRef" IS NOT NULL))
        AND (("status" = 'UNMATCHED') = ("unmatchedReason" IS NOT NULL))
    );

-- No DELETE for `app_user`: nothing deletes a suggestion row by hand. It goes
-- with its run, its agent or its tenant, by cascade.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "DiscoveredAgentAttribution" TO app_user;
        REVOKE DELETE ON "DiscoveredAgentAttribution" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "DiscoveredAgentAttribution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscoveredAgentAttribution" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "DiscoveredAgentAttribution";
CREATE POLICY tenant_isolation ON "DiscoveredAgentAttribution"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "DiscoveredAgentAttribution";
CREATE POLICY tenant_isolation_insert ON "DiscoveredAgentAttribution"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "DiscoveredAgentAttribution";
CREATE POLICY superuser_bypass ON "DiscoveredAgentAttribution"
    USING (current_setting('role') != 'app_user');
