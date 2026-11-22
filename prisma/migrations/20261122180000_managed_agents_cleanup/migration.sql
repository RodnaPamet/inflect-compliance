-- ManagedAgentsCleanup (Step 5c of docs/claude-managed-agents-design.md, #4166).
--
-- One row per remote clean-up of what Inflect created in a customer's Anthropic
-- workspace: the sessions to delete and the agents to archive, by recorded id,
-- and the named outcome. Written on tenant purge (once, never retried: owner
-- decision 7 keeps no key past the purge), on removal of an
-- anthropic-workspace connection and after a DSAR erasure (both retried by
-- data-lifecycle).
--
-- ADDITIVE ONLY. Ids and codes; no key, no ciphertext of one, no free text.
-- Retained by the tenant purge (a Regulatory artefact), so its only foreign key
-- is to the retained Tenant tombstone, RESTRICT, and app_user holds no DELETE.

-- CreateTable
CREATE TABLE "ManagedAgentsCleanup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "outcome" TEXT,
    "coversUntil" TIMESTAMP(3) NOT NULL,
    "pendingSessionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pendingAgentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deletedSessionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedAgentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ManagedAgentsCleanup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ManagedAgentsCleanup_trigger_known" CHECK (
        "trigger" IN ('TENANT_PURGE', 'CONNECTION_REMOVED', 'DSAR_ERASURE')
    ),
    CONSTRAINT "ManagedAgentsCleanup_status_known" CHECK (
        "status" IN ('OPEN', 'DONE', 'ABANDONED', 'PURGED_KEY_DESTROYED_UNFINISHED', 'SUPERSEDED_BY_PURGE')
    ),
    -- A purge record is written once, after its one attempt: it is never OPEN.
    CONSTRAINT "ManagedAgentsCleanup_purge_never_open" CHECK (
        "trigger" <> 'TENANT_PURGE' OR "status" IN ('DONE', 'PURGED_KEY_DESTROYED_UNFINISHED')
    ),
    -- The purge's own terminal outcome names only a purge.
    CONSTRAINT "ManagedAgentsCleanup_unfinished_is_purge" CHECK (
        "status" <> 'PURGED_KEY_DESTROYED_UNFINISHED' OR "trigger" = 'TENANT_PURGE'
    ),
    CONSTRAINT "ManagedAgentsCleanup_outcome_shape" CHECK (
        "outcome" IS NULL OR "outcome" ~ '^[A-Z][A-Z_]{1,63}$'
    ),
    CONSTRAINT "ManagedAgentsCleanup_closed_when_not_open" CHECK (
        ("status" = 'OPEN') = ("closedAt" IS NULL)
    )
);

-- CreateIndex
CREATE INDEX "ManagedAgentsCleanup_tenantId_status_idx" ON "ManagedAgentsCleanup"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ManagedAgentsCleanup_tenantId_connectionId_idx" ON "ManagedAgentsCleanup"("tenantId", "connectionId");

-- CreateIndex
CREATE INDEX "ManagedAgentsCleanup_status_createdAt_idx" ON "ManagedAgentsCleanup"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ManagedAgentsCleanup" ADD CONSTRAINT "ManagedAgentsCleanup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Retained: no DELETE for app_user.
GRANT SELECT, INSERT, UPDATE ON "ManagedAgentsCleanup" TO app_user;

ALTER TABLE "ManagedAgentsCleanup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManagedAgentsCleanup" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "ManagedAgentsCleanup";
CREATE POLICY tenant_isolation ON "ManagedAgentsCleanup"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "ManagedAgentsCleanup";
CREATE POLICY tenant_isolation_insert ON "ManagedAgentsCleanup"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "ManagedAgentsCleanup";
CREATE POLICY superuser_bypass ON "ManagedAgentsCleanup"
    USING (current_setting('role') != 'app_user');
