-- The worker <-> directory-account pairing, observed during healthy syncs and
-- READ at termination.
--
-- The leaver flow must answer "which accounts belong to the person Workday
-- just marked terminated?". Computing that at termination is the worst moment
-- to compute it: the account may already be renamed, its mail attribute
-- cleared, its UPN changed. This table records the answer while both sides are
-- healthy so the disable path reads a previously-verified fact.

CREATE TYPE "IdentityLinkMethod" AS ENUM ('EMAIL_EXACT', 'EXTERNAL_ID', 'MANUAL');

CREATE TABLE "IdentityAccountLink" (
    "id"                 TEXT NOT NULL,
    "tenantId"           TEXT NOT NULL,
    "employeeId"         TEXT NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "matchMethod"        "IdentityLinkMethod" NOT NULL,
    "firstLinkedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt"     TIMESTAMP(3) NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityAccountLink_pkey" PRIMARY KEY ("id")
);

-- An account belongs to AT MOST ONE worker. Two workers claiming one account
-- makes "whose account is this?" unanswerable at exactly the moment it must be
-- answered, so the database refuses the state outright.
CREATE UNIQUE INDEX "IdentityAccountLink_connectedAccountId_key"
    ON "IdentityAccountLink"("connectedAccountId");

-- Deliberately NOT unique: one worker legitimately holds several accounts
-- (Entra + Okta + on-prem AD), and disabling all of them is the point.
CREATE INDEX "IdentityAccountLink_tenantId_employeeId_idx"
    ON "IdentityAccountLink"("tenantId", "employeeId");

-- Staleness queries: "links not re-verified since <date>" is how the leaver
-- path refuses to act on evidence it has not seen recently.
CREATE INDEX "IdentityAccountLink_tenantId_lastVerifiedAt_idx"
    ON "IdentityAccountLink"("tenantId", "lastVerifiedAt");

ALTER TABLE "IdentityAccountLink"
    ADD CONSTRAINT "IdentityAccountLink_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE on both sides: a link is a statement ABOUT two rows and is
-- meaningless once either is gone. Leaving an orphan would leave the leaver
-- path holding a pairing pointing at nothing.
ALTER TABLE "IdentityAccountLink"
    ADD CONSTRAINT "IdentityAccountLink_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IdentityAccountLink"
    ADD CONSTRAINT "IdentityAccountLink_connectedAccountId_fkey"
    FOREIGN KEY ("connectedAccountId") REFERENCES "ConnectedIdentityAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE "IdentityAccountLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityAccountLink" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "IdentityAccountLink";
CREATE POLICY tenant_isolation ON "IdentityAccountLink"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "IdentityAccountLink";
CREATE POLICY tenant_isolation_insert ON "IdentityAccountLink"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "IdentityAccountLink";
CREATE POLICY superuser_bypass ON "IdentityAccountLink"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "IdentityAccountLink" TO app_user;
