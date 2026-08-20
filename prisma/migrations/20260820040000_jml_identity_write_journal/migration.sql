-- One attempted write to a customer's directory, with the state it replaced.
--
-- Disabling an account destroys the evidence of what it was: on-prem AD packs
-- the answer into a single userAccountControl integer whose other bits are gone
-- once overwritten. "Undo the offboarding" is answerable only if the answer was
-- written down first, so a row here is committed BEFORE the provider call —
-- never after, because a capture that happens after a successful write does not
-- exist for the write that crashed halfway.
--
-- Append-only, and a journal rather than a column on IdentityAccountLink: a
-- single priorState would be overwritten by the next disable, and
-- rehire -> disable -> rehire is an ordinary sequence.

CREATE TYPE "IdentityWriteOutcome" AS ENUM ('PENDING', 'APPLIED', 'FAILED', 'REVERTED');
CREATE TYPE "IdentityWriteAction" AS ENUM ('DISABLE_ACCOUNT', 'ENABLE_ACCOUNT', 'CREATE_ACCOUNT', 'ASSIGN_GROUP', 'REMOVE_GROUP');

CREATE TABLE "IdentityWriteJournal" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL,
    "linkId"         TEXT,
    "provider"       TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "action"         "IdentityWriteAction" NOT NULL,
    "mode"           "IdentityWriteMode" NOT NULL,
    "priorStateJson" JSONB NOT NULL,
    "outcome"        "IdentityWriteOutcome" NOT NULL DEFAULT 'PENDING',
    "detail"         TEXT,
    "attemptedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt"      TIMESTAMP(3),
    "actorUserId"    TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityWriteJournal_pkey" PRIMARY KEY ("id")
);

-- The restore lookup: "what did we last do to this account?"
CREATE INDEX "IdentityWriteJournal_tenantId_provider_externalUserId_idx"
    ON "IdentityWriteJournal"("tenantId", "provider", "externalUserId");
-- The operator sweep: "what is still PENDING and needs a human to look?"
CREATE INDEX "IdentityWriteJournal_tenantId_outcome_idx"
    ON "IdentityWriteJournal"("tenantId", "outcome");
CREATE INDEX "IdentityWriteJournal_tenantId_attemptedAt_idx"
    ON "IdentityWriteJournal"("tenantId", "attemptedAt");
CREATE INDEX "IdentityWriteJournal_linkId_idx" ON "IdentityWriteJournal"("linkId");

ALTER TABLE "IdentityWriteJournal"
    ADD CONSTRAINT "IdentityWriteJournal_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL, not CASCADE: the journal must OUTLIVE the link. An employee row
-- deleted for privacy must not erase the record that their access was revoked,
-- which is frequently the evidence an auditor asks for.
ALTER TABLE "IdentityWriteJournal"
    ADD CONSTRAINT "IdentityWriteJournal_linkId_fkey"
    FOREIGN KEY ("linkId") REFERENCES "IdentityAccountLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE "IdentityWriteJournal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityWriteJournal" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "IdentityWriteJournal";
CREATE POLICY tenant_isolation ON "IdentityWriteJournal"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "IdentityWriteJournal";
CREATE POLICY tenant_isolation_insert ON "IdentityWriteJournal"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "IdentityWriteJournal";
CREATE POLICY superuser_bypass ON "IdentityWriteJournal"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "IdentityWriteJournal" TO app_user;
