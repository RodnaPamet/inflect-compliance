-- #2861 — which READ tells us what a WRITE is about to replace.
--
-- Owner decision, 2026-09-28. MCP has no generic "read the thing this write will
-- change", so decision 2 -- read prior state first, refuse the write if it cannot
-- be read -- needs somebody to say which read corresponds to which write. An
-- OWNER nominates one of the same server's READ tools and it is called with the
-- write's own arguments immediately before the write goes out.
--
-- Three alternatives were rejected. The far end returning prior state in its own
-- result needs no storage and is what the OrangeHRM adapter already does, but a
-- lost response then loses the prior state too -- precisely what reading first
-- exists to prevent. Deriving the read from the write by NAME needs no
-- configuration and is silently wrong the moment a server's naming differs, and a
-- wrong prior state is worse than none because it reads as authoritative.
-- Refusing every write until something better exists is honest and is a path that
-- always refuses, which is the shape #2241 deleted from the identity ladder.
--
-- WHY A TABLE AND NOT A COLUMN ON THE PIN. `McpToolManifestPin` is an attestation
-- of what the SERVER said; this is a tenant CONFIGURATION. Putting it there would
-- mean re-approving a manifest touched configuration, and would give the pin two
-- meanings that change for different reasons.
--
-- CreateTable
CREATE TABLE "ExternalToolPriorStateRead" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "writeToolName" TEXT NOT NULL,
    "readToolName" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalToolPriorStateRead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One read per write: a second pairing would make "which read ran" a plan detail
-- rather than a decision somebody made.
CREATE UNIQUE INDEX "ExternalToolPriorStateRead_tenantId_writeToolName_key"
    ON "ExternalToolPriorStateRead"("tenantId", "writeToolName");
CREATE INDEX "ExternalToolPriorStateRead_tenantId_idx"
    ON "ExternalToolPriorStateRead"("tenantId");

-- AddForeignKey
ALTER TABLE "ExternalToolPriorStateRead"
    ADD CONSTRAINT "ExternalToolPriorStateRead_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE "ExternalToolPriorStateRead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalToolPriorStateRead" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "ExternalToolPriorStateRead";
CREATE POLICY tenant_isolation ON "ExternalToolPriorStateRead"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "ExternalToolPriorStateRead";
CREATE POLICY tenant_isolation_insert ON "ExternalToolPriorStateRead"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "ExternalToolPriorStateRead";
CREATE POLICY superuser_bypass ON "ExternalToolPriorStateRead"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "ExternalToolPriorStateRead" TO app_user;
