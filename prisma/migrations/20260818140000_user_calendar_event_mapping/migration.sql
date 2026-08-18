-- ═══════════════════════════════════════════════════════════════════
-- C5 — UserCalendarEventMapping: one row per (user, provider, deadline)
-- holding the remote event id.
-- ═══════════════════════════════════════════════════════════════════
--
-- Class A RLS, same shape as 20260818120000_user_calendar_connection.
-- `tenantId` NOT NULL for the same reason stated there.
--
-- Idempotent — safe to re-run.

CREATE TYPE "CalendarEventSyncState" AS ENUM ('PUSHED', 'PENDING_DELETE', 'FAILED');

CREATE TABLE "UserCalendarEventMapping" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "provider"       TEXT NOT NULL,
    "sourceKey"      TEXT NOT NULL,
    "sourceEntityId" TEXT NOT NULL,
    "remoteEventId"  TEXT NOT NULL,
    "clientEventId"  TEXT NOT NULL,
    "contentHash"    TEXT NOT NULL,
    "state"          "CalendarEventSyncState" NOT NULL DEFAULT 'PUSHED',
    "lastError"      TEXT,
    "lastPushedAt"   TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCalendarEventMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserCalendarEventMapping_identity_key"
    ON "UserCalendarEventMapping"("tenantId", "userId", "provider", "sourceKey", "sourceEntityId");
CREATE INDEX "UserCalendarEventMapping_tenantId_idx"
    ON "UserCalendarEventMapping"("tenantId");
CREATE INDEX "UserCalendarEventMapping_userId_idx"
    ON "UserCalendarEventMapping"("userId");
-- Backs the sweep: everything this user still has pushed, and everything
-- awaiting deletion.
CREATE INDEX "UserCalendarEventMapping_tenantId_userId_provider_state_idx"
    ON "UserCalendarEventMapping"("tenantId", "userId", "provider", "state");

ALTER TABLE "UserCalendarEventMapping"
    ADD CONSTRAINT "UserCalendarEventMapping_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ON DELETE CASCADE mirrors the connection table. Note the consequence,
-- deliberately accepted: deleting a User drops the record that events were
-- pushed, so anything still in their calendar is orphaned. The alternative —
-- RESTRICT — would block user deletion on a third party's API being reachable,
-- which is worse. The disconnect path is what must clean up, and it runs first.
ALTER TABLE "UserCalendarEventMapping"
    ADD CONSTRAINT "UserCalendarEventMapping_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── RLS ────────────────────────────────────────────────────────────
ALTER TABLE "UserCalendarEventMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserCalendarEventMapping" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "UserCalendarEventMapping";
CREATE POLICY tenant_isolation ON "UserCalendarEventMapping"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "UserCalendarEventMapping";
CREATE POLICY tenant_isolation_insert ON "UserCalendarEventMapping"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "UserCalendarEventMapping";
CREATE POLICY superuser_bypass ON "UserCalendarEventMapping"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "UserCalendarEventMapping" TO app_user;
