-- ═══════════════════════════════════════════════════════════════════
-- C1 — UserCalendarConnection: per-user consent to push a user's own
-- compliance deadlines into their own Google / Outlook calendar.
-- ═══════════════════════════════════════════════════════════════════
--
-- Class A RLS (direct `tenantId` column), matching
-- `20260422180000_enable_rls_coverage` and
-- `20260506000000_epic_g3_vendor_template_rls`: ENABLE + FORCE + the three
-- canonical policies + the app_user grant.
--
-- `tenantId` is NOT NULL deliberately. A nullable tenant column would force the
-- D.1 asymmetric SINGLE-policy form plus a SINGLE_POLICY_EXCEPTIONS entry,
-- because the split-policy shape below is unsafe on a nullable column: a
-- permissive INSERT sibling lets `app_user` UPDATE a row's tenantId to NULL and
-- promote a private row into every tenant's view. That is not hypothetical —
-- `rls-coverage.test.ts` records it happening to `Control`.
--
-- Idempotent — safe to re-run.

CREATE TABLE "UserCalendarConnection" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "provider"       TEXT NOT NULL,
    "tokenEncrypted" TEXT NOT NULL,
    "scopesGranted"  TEXT[],
    "connectedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"      TIMESTAMP(3),
    "revokedReason"  TEXT,
    "lastPushedAt"   TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCalendarConnection_pkey" PRIMARY KEY ("id")
);

-- One connection per (tenant, user, provider). The tenant leads so the index
-- also serves tenant-scoped lookups.
CREATE UNIQUE INDEX "UserCalendarConnection_tenantId_userId_provider_key"
    ON "UserCalendarConnection"("tenantId", "userId", "provider");
CREATE INDEX "UserCalendarConnection_tenantId_idx"
    ON "UserCalendarConnection"("tenantId");
CREATE INDEX "UserCalendarConnection_userId_idx"
    ON "UserCalendarConnection"("userId");
-- Backs the push fan-out's "every live connection for this provider" scan.
CREATE INDEX "UserCalendarConnection_tenantId_provider_revokedAt_idx"
    ON "UserCalendarConnection"("tenantId", "provider", "revokedAt");

ALTER TABLE "UserCalendarConnection"
    ADD CONSTRAINT "UserCalendarConnection_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ON DELETE CASCADE: deleting the User must take their tokens with it. A
-- lingering encrypted refresh token for a deleted user is a credential nothing
-- will ever revoke.
ALTER TABLE "UserCalendarConnection"
    ADD CONSTRAINT "UserCalendarConnection_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── RLS ────────────────────────────────────────────────────────────
ALTER TABLE "UserCalendarConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserCalendarConnection" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "UserCalendarConnection";
CREATE POLICY tenant_isolation ON "UserCalendarConnection"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "UserCalendarConnection";
CREATE POLICY tenant_isolation_insert ON "UserCalendarConnection"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "UserCalendarConnection";
CREATE POLICY superuser_bypass ON "UserCalendarConnection"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "UserCalendarConnection" TO app_user;
