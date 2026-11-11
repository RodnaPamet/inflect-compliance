-- Peer invitations (#3752; owner decisions 2026-11-11).
--
-- Connecting two workspaces over A2A took eight manual acts, four on each side.
-- An invitation makes it three: invite here, accept there (which pins this
-- workspace's card on that side), and one click here to approve the acceptor's
-- card. Additive: a new enum and a new table; nothing existing changes.
--
--   PeerInvitation  one code, single-use, expiring, stored only as a hash.

CREATE TYPE "PeerInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

CREATE TABLE "PeerInvitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codePrefix" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "riskTier" "AgentRiskTier" NOT NULL,
    "receivingAgentId" TEXT NOT NULL,
    "workflowKeys" TEXT[],
    "status" "PeerInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "acceptedPeerId" TEXT,
    "acceptedCardUrl" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PeerInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PeerInvitation_id_tenantId_key" ON "PeerInvitation"("id", "tenantId");
CREATE UNIQUE INDEX "PeerInvitation_tenantId_codeHash_key" ON "PeerInvitation"("tenantId", "codeHash");
CREATE INDEX "PeerInvitation_tenantId_status_createdAt_idx" ON "PeerInvitation"("tenantId", "status", "createdAt");
CREATE INDEX "PeerInvitation_tenantId_receivingAgentId_idx" ON "PeerInvitation"("tenantId", "receivingAgentId");

ALTER TABLE "PeerInvitation" ADD CONSTRAINT "PeerInvitation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PeerInvitation" ADD CONSTRAINT "PeerInvitation_receivingAgentId_tenantId_fkey"
    FOREIGN KEY ("receivingAgentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The shape of each state, held below the usecase: an accepted invitation names
-- the peer it produced, a revoked one who revoked it, and a pending one neither.
ALTER TABLE "PeerInvitation" ADD CONSTRAINT "PeerInvitation_shape" CHECK (
    ("status" = 'PENDING'  AND "acceptedAt" IS NULL AND "acceptedPeerId" IS NULL AND "revokedAt" IS NULL)
 OR ("status" = 'ACCEPTED' AND "acceptedAt" IS NOT NULL AND "acceptedPeerId" IS NOT NULL AND "acceptedCardUrl" IS NOT NULL AND "revokedAt" IS NULL)
 OR ("status" = 'REVOKED'  AND "revokedAt" IS NOT NULL AND "revokedByUserId" IS NOT NULL AND "acceptedAt" IS NULL)
);
ALTER TABLE "PeerInvitation" ADD CONSTRAINT "PeerInvitation_workflows_present"
    CHECK (cardinality("workflowKeys") BETWEEN 1 AND 16);

-- PENDING moves once and never back, and every other column is frozen: an
-- accepted or revoked invitation is a record of what was granted, and the code
-- hash must never be re-pointed at a new code.
CREATE OR REPLACE FUNCTION peer_invitation_is_one_way()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."status" <> 'PENDING' THEN
        RAISE EXCEPTION 'PEER_INVITATION_FINAL: an accepted or revoked invitation does not change.';
    END IF;
    IF NEW."codeHash" IS DISTINCT FROM OLD."codeHash"
       OR NEW."codePrefix" IS DISTINCT FROM OLD."codePrefix"
       OR NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId"
       OR NEW."vendorId" IS DISTINCT FROM OLD."vendorId"
       OR NEW."riskTier" IS DISTINCT FROM OLD."riskTier"
       OR NEW."receivingAgentId" IS DISTINCT FROM OLD."receivingAgentId"
       OR NEW."workflowKeys" IS DISTINCT FROM OLD."workflowKeys"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
       OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
        RAISE EXCEPTION 'PEER_INVITATION_FROZEN: what an invitation grants is fixed when it is created.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS peer_invitation_is_one_way ON "PeerInvitation";
CREATE TRIGGER peer_invitation_is_one_way
    BEFORE UPDATE ON "PeerInvitation"
    FOR EACH ROW EXECUTE FUNCTION peer_invitation_is_one_way();

-- An invitation is revoked, never deleted.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "PeerInvitation" TO app_user;
        REVOKE DELETE ON "PeerInvitation" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "PeerInvitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PeerInvitation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PeerInvitation";
CREATE POLICY tenant_isolation ON "PeerInvitation"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "PeerInvitation";
CREATE POLICY tenant_isolation_insert ON "PeerInvitation"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "PeerInvitation";
CREATE POLICY superuser_bypass ON "PeerInvitation"
    USING (current_setting('role') != 'app_user');
