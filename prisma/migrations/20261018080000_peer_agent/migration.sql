-- Step 2e (#3673): A2A peer registration and agent-card pinning.
--
--   PeerAgent  an agent in ANOTHER organisation this tenant may exchange tasks
--              with (step 4b). Admission facts only: owner, supplier, tier,
--              signing key, the approved card pin and a status. No authority
--              column of any kind: docs/a2a-mapping.md, "No second authority
--              model".
--
-- Forward-only and additive: a new enum type and a new table, which the
-- previous image never reads.

-- CreateEnum
CREATE TYPE "PeerAgentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'RETIRED');

-- CreateTable
CREATE TABLE "PeerAgent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cardUrl" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "riskTier" "AgentRiskTier",
    "riskTierScoredAt" TIMESTAMP(3),
    "signingPublicKey" TEXT NOT NULL,
    "signingKeyFingerprint" TEXT NOT NULL,
    "status" "PeerAgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "observedCardHash" TEXT,
    "observedAt" TIMESTAMP(3),
    "pinnedCardHash" TEXT,
    "pinnedTextHash" TEXT,
    "pinnedEndpointHash" TEXT,
    "pinnedOtherHash" TEXT,
    "pinRevision" INTEGER NOT NULL DEFAULT 0,
    "pinnedByUserId" TEXT,
    "pinnedAt" TIMESTAMP(3),
    "previousCardHash" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PeerAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PeerAgent_tenantId_status_idx" ON "PeerAgent"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PeerAgent_tenantId_ownerUserId_idx" ON "PeerAgent"("tenantId", "ownerUserId");

-- CreateIndex
CREATE INDEX "PeerAgent_tenantId_vendorId_idx" ON "PeerAgent"("tenantId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "PeerAgent_id_tenantId_key" ON "PeerAgent"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PeerAgent_tenantId_cardUrl_key" ON "PeerAgent"("tenantId", "cardUrl");

-- AddForeignKey
ALTER TABLE "PeerAgent" ADD CONSTRAINT "PeerAgent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerAgent" ADD CONSTRAINT "PeerAgent_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerAgent" ADD CONSTRAINT "PeerAgent_vendorId_tenantId_fkey" FOREIGN KEY ("vendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A card is fetched over https only. The usecase checks it too; this is the
-- backstop for any writer that forgets.
ALTER TABLE "PeerAgent" ADD CONSTRAINT "PeerAgent_card_url_https"
    CHECK ("cardUrl" LIKE 'https://%');

-- The pin is all-or-nothing: never approved (every pin column NULL, revision
-- 0) or approved (every one set, revision >= 1). A half-written pin would read
-- as approved to one check and unapproved to another.
ALTER TABLE "PeerAgent" ADD CONSTRAINT "PeerAgent_pin_all_or_nothing"
    CHECK (
        (
            "pinnedCardHash" IS NULL AND "pinnedTextHash" IS NULL
            AND "pinnedEndpointHash" IS NULL AND "pinnedOtherHash" IS NULL
            AND "pinnedByUserId" IS NULL AND "pinnedAt" IS NULL
            AND "previousCardHash" IS NULL AND "pinRevision" = 0
        )
        OR (
            "pinnedCardHash" IS NOT NULL AND "pinnedTextHash" IS NOT NULL
            AND "pinnedEndpointHash" IS NOT NULL AND "pinnedOtherHash" IS NOT NULL
            AND "pinnedByUserId" IS NOT NULL AND "pinnedAt" IS NOT NULL
            AND "pinRevision" >= 1
        )
    );

-- A tier and the moment it was scored travel together.
ALTER TABLE "PeerAgent" ADD CONSTRAINT "PeerAgent_tier_scored_pairing"
    CHECK (("riskTier" IS NULL) = ("riskTierScoredAt" IS NULL));

-- RETIRED is one-way, held below the usecase too.
CREATE OR REPLACE FUNCTION peer_agent_retired_is_final() RETURNS trigger AS $$
BEGIN
    IF OLD."status" = 'RETIRED' AND NEW."status" <> 'RETIRED' THEN
        RAISE EXCEPTION 'A retired peer agent cannot be reactivated'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS peer_agent_retired_is_final ON "PeerAgent";
CREATE TRIGGER peer_agent_retired_is_final
    BEFORE UPDATE OF "status" ON "PeerAgent"
    FOR EACH ROW EXECUTE FUNCTION peer_agent_retired_is_final();

-- Privileges and row-level security. `app_user` may read, register and
-- update a peer, and may NOT delete one: a peer is retired, never deleted, so
-- the record of who approved which card survives. A tenant purge runs
-- privileged and a referential CASCADE runs as the table owner. Default
-- privileges grant DELETE to `app_user` (20260323180000), so it is revoked
-- explicitly, as 20261017235800 does for AgentOwnershipTransfer.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "PeerAgent" TO app_user;
        REVOKE DELETE ON "PeerAgent" FROM app_user;
    END IF;
END
$$;
ALTER TABLE "PeerAgent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PeerAgent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PeerAgent";
CREATE POLICY tenant_isolation ON "PeerAgent"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "PeerAgent";
CREATE POLICY tenant_isolation_insert ON "PeerAgent"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "PeerAgent";
CREATE POLICY superuser_bypass ON "PeerAgent"
    USING (current_setting('role') != 'app_user');
