-- #2861 — what an agent changed in a system that is not ours.
--
-- The Art 12 / Art 14 record for an autonomous change to a customer's
-- third-party system. Owner decision 2026-09-27: mirror `IdentityWriteJournal`
-- rather than invent a format — actor, agent, connection, tool, arguments sent,
-- prior state, outcome, and the rung it ran under. That shape has already
-- survived a real regulator-facing directory disable, and it reuses a surface
-- operators know.
--
-- ROLLBACK IS CAPTURE, NOT AUTO-REVERT, also decided 2026-09-27. This table
-- records what a write REPLACED so a human can re-apply it in the far system;
-- nothing here re-sends anything, exactly as `DirectoryWriter` declares no
-- `enable()` verb. Hence no REVERTED outcome: nothing could set it, and #2241 is
-- the record of what a value that enforces nothing costs. Appending an enum value
-- later is safe; dropping one is the hazard.
--
-- TEXT, NOT JSONB, for `argumentsJson` and `priorStateJson`. `encrypted-fields.ts`
-- encrypts STRING fields only — which is why `AgentProposal.payloadJson` and
-- `WorkflowStep.inputJson` are strings despite their names, and why
-- `IdentityWriteJournal.priorStateJson` is jsonb and "cannot be" encrypted. These
-- hold whatever an arbitrary third-party system returns for the object being
-- changed; the first writable far end here is an HRIS, where that is a person's
-- work email, personal email and phone numbers. The identity journal's decision
-- to leave its prior state in the clear turned on CONTENT — directory flags, not
-- credentials — so it does not transfer to different content. No jsonb querying
-- is lost that anything needs: the journal is read a row at a time, and the dwell
-- counts rows by `mode` and `outcome`.
--
-- `priorStateJson` IS NOT NULL, and that is owner decision 2 made structural.
-- Reading prior state is a PRECONDITION of dispatching and unreadability is a
-- refusal, so a row without it could only exist if something wrote blind. The
-- column makes that unrepresentable rather than merely discouraged.
--
-- CreateEnum
CREATE TYPE "ExternalWriteOutcome" AS ENUM ('PENDING', 'RECORDED_ONLY', 'APPLIED', 'FAILED', 'INDETERMINATE');

-- CreateTable
CREATE TABLE "ExternalWriteJournal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT,
    "connectionName" TEXT NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "advertisedToolName" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "argumentsJson" TEXT NOT NULL,
    "priorStateJson" TEXT NOT NULL,
    "outcome" "ExternalWriteOutcome" NOT NULL DEFAULT 'PENDING',
    "detail" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "agentId" TEXT,
    "runId" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalWriteJournal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalWriteJournal_tenantId_connectionId_attemptedAt_idx"
    ON "ExternalWriteJournal"("tenantId", "connectionId", "attemptedAt");
CREATE INDEX "ExternalWriteJournal_tenantId_outcome_idx"
    ON "ExternalWriteJournal"("tenantId", "outcome");
CREATE INDEX "ExternalWriteJournal_tenantId_mode_attemptedAt_idx"
    ON "ExternalWriteJournal"("tenantId", "mode", "attemptedAt");
CREATE INDEX "ExternalWriteJournal_connectionId_idx"
    ON "ExternalWriteJournal"("connectionId");

-- AddForeignKey
ALTER TABLE "ExternalWriteJournal"
    ADD CONSTRAINT "ExternalWriteJournal_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL, not CASCADE: the journal must OUTLIVE the connection. Deleting an
-- integration must not erase the record that we changed somebody's system
-- through it, which is usually the evidence being asked for. The denormalised
-- `connectionName` and `endpointUrl` are what keep the row readable afterwards.
--
-- The composite reference is #2356 batch 3's shape: ([connectionId, tenantId]) ->
-- ([id, tenantId]) makes a cross-tenant reference unrepresentable rather than
-- merely filtered.
--
-- COLUMN-SCOPED `SET NULL ("connectionId")`, and that is not optional — it is the
-- rule `20260913020000_tenant_fks_setnull_batch3b` states: "A composite FK
-- carrying `tenantId` cannot use plain SET NULL: Postgres nulls EVERY referencing
-- column, `tenantId` is NOT NULL", so the parent delete fails outright. Written
-- the plain way first here, and the RLS suite's outlives-the-connection test
-- caught it as a null-constraint violation on `DELETE FROM
-- "IntegrationConnection"` — which is the whole reason that test deletes a real
-- connection instead of asserting the constraint text.
ALTER TABLE "ExternalWriteJournal"
    ADD CONSTRAINT "ExternalWriteJournal_connectionId_tenantId_fkey"
    FOREIGN KEY ("connectionId", "tenantId") REFERENCES "IntegrationConnection"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("connectionId");

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE "ExternalWriteJournal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalWriteJournal" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "ExternalWriteJournal";
CREATE POLICY tenant_isolation ON "ExternalWriteJournal"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "ExternalWriteJournal";
CREATE POLICY tenant_isolation_insert ON "ExternalWriteJournal"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "ExternalWriteJournal";
CREATE POLICY superuser_bypass ON "ExternalWriteJournal"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "ExternalWriteJournal" TO app_user;
