-- ═══════════════════════════════════════════════════════════════════
-- C2 — TenantCalendarConsent: a tenant admin's one-time authorisation
-- for a calendar provider (Microsoft; Google is per-user).
-- ═══════════════════════════════════════════════════════════════════
--
-- Class A RLS, same shape as the two calendar tables before it.
-- `tenantId` NOT NULL for the same reason stated there.
--
-- Idempotent — safe to re-run.

CREATE TABLE "TenantCalendarConsent" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT NOT NULL,
    "provider"         TEXT NOT NULL,
    "externalTenantId" TEXT,
    "grantedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedByUserId"  TEXT NOT NULL,
    "revokedAt"        TIMESTAMP(3),
    "revokedReason"    TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantCalendarConsent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantCalendarConsent_tenantId_provider_key"
    ON "TenantCalendarConsent"("tenantId", "provider");
CREATE INDEX "TenantCalendarConsent_tenantId_idx"
    ON "TenantCalendarConsent"("tenantId");
CREATE INDEX "TenantCalendarConsent_grantedByUserId_idx"
    ON "TenantCalendarConsent"("grantedByUserId");

ALTER TABLE "TenantCalendarConsent"
    ADD CONSTRAINT "TenantCalendarConsent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT, not CASCADE, and deliberately unlike UserCalendarConnection.
-- That table cascades because a deleted user's TOKEN must go with them. This
-- row is an AUDIT FACT about a tenant-wide authorisation — who opened the door,
-- and when. Deleting the admin must not erase it; an access review asking "who
-- authorised this" needs an answer that survives their offboarding.
ALTER TABLE "TenantCalendarConsent"
    ADD CONSTRAINT "TenantCalendarConsent_grantedByUserId_fkey"
    FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── RLS ────────────────────────────────────────────────────────────
ALTER TABLE "TenantCalendarConsent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantCalendarConsent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "TenantCalendarConsent";
CREATE POLICY tenant_isolation ON "TenantCalendarConsent"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "TenantCalendarConsent";
CREATE POLICY tenant_isolation_insert ON "TenantCalendarConsent"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "TenantCalendarConsent";
CREATE POLICY superuser_bypass ON "TenantCalendarConsent"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "TenantCalendarConsent" TO app_user;
