-- A2A HOST CONSUMERS (#3861, ADR 0003) — a second kind of inbound principal.
--
-- Forward-only and additive: three new tables and two nullable columns. The
-- previous image never reads or writes any of them.
--
-- WHY THE TWO WorkflowRun COLUMNS ARE NOT A REUSE OF `inboundPeerId`.
-- `inboundPeerId`/`inboundMessageId` are plain ids, not foreign keys, so a
-- host-consumer id would have been accepted there without complaint — leaving
-- the column's own docblock false and every join to "PeerAgent" silently empty.
-- They carry the two narrowings that make this principal acceptable: a run an
-- inbound caller started never dispatches an external write above
-- PROPOSE_ONLY (threat-model R17, `clampForInboundA2a`) and never sends an
-- outbound A2A task (R14). `restoreA2aInbound` rebuilds that flag FROM THESE
-- COLUMNS, so a principal whose ids are not persisted keeps the clamp on its
-- first segment and loses it on a person's resume or a queued Flue segment —
-- a run that starts at PROPOSE_ONLY and resumes able to write. The existing
-- write-once trigger is EXTENDED below to cover them, rather than a second
-- trigger being added, so there is one place that says what is frozen.
--
-- ENCRYPTED COLUMN AND THE WRITE-ONCE TRIGGER. "HostConsumerMessage"."body"
-- and "HostConsumerKillSwitch"."reason"/"liftReason" join the Epic B manifest,
-- and the tenant-DEK and master-KEK rotation sweeps rewrite every such
-- ciphertext in place with a raw UPDATE. So the trigger that freezes a message
-- row lets exactly one change through: a ciphertext replaced by a v2
-- ciphertext, every other column unchanged. That is a re-wrap, not an edit.
--
-- WHAT THIS EVIDENCE IS NOT. A peer's row carries a signature over the body by
-- a key the peer cannot repudiate. This one carries the body, the client id and
-- the token's jti. It proves what arrived and under which token, NOT who
-- authored it. Threat-model R12 stays closed for peers and is open here, by
-- owner decision (#3860). Nothing in this migration should be read as making
-- the two equivalent.

-- CreateEnum
CREATE TYPE "HostConsumerStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'RETIRED');

-- AlterTable
-- The per-tenant half of the gate. Defaulted false, so the previous image and
-- every existing tenant are unchanged: admitting a host consumer takes a
-- deliberate act by the tenant that bears the weaker receipt guarantee.
ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN "a2aHostConsumersEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN "inboundHostConsumerId" TEXT,
ADD COLUMN "inboundHostMessageId" TEXT;

-- CreateTable
CREATE TABLE "HostConsumer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "clientSecretPrefix" TEXT NOT NULL,
    "receivingAgentId" TEXT NOT NULL,
    -- The accountable person, as "PeerAgent"."ownerUserId" is. A run this
    -- consumer starts carries their authority, so it cannot reach further than
    -- a named human could.
    "ownerUserId" TEXT NOT NULL,
    "workflowKeys" TEXT[],
    "status" "HostConsumerStatus" NOT NULL DEFAULT 'ACTIVE',
    "inboundMessagesPerHour" INTEGER NOT NULL DEFAULT 60,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,

    CONSTRAINT "HostConsumer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostConsumerMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "hostConsumerId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "tokenJti" TEXT NOT NULL,
    "method" TEXT,
    "body" TEXT NOT NULL,
    "bodyDigest" TEXT NOT NULL,
    "agentId" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostConsumerMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostConsumerKillSwitch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "hostConsumerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "engagedByUserId" TEXT NOT NULL,
    "engagedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt" TIMESTAMP(3),
    "liftedByUserId" TEXT,
    "liftReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostConsumerKillSwitch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HostConsumer_id_tenantId_key" ON "HostConsumer"("id", "tenantId");
CREATE UNIQUE INDEX "HostConsumer_tenantId_clientId_key" ON "HostConsumer"("tenantId", "clientId");
CREATE UNIQUE INDEX "HostConsumer_tenantId_clientSecretHash_key" ON "HostConsumer"("tenantId", "clientSecretHash");
CREATE INDEX "HostConsumer_tenantId_status_idx" ON "HostConsumer"("tenantId", "status");
CREATE INDEX "HostConsumer_tenantId_receivingAgentId_idx" ON "HostConsumer"("tenantId", "receivingAgentId");
CREATE INDEX "HostConsumer_tenantId_ownerUserId_idx" ON "HostConsumer"("tenantId", "ownerUserId");
CREATE INDEX "HostConsumer_tenantId_revokedAt_idx" ON "HostConsumer"("tenantId", "revokedAt");

CREATE UNIQUE INDEX "HostConsumerMessage_id_tenantId_key" ON "HostConsumerMessage"("id", "tenantId");
CREATE UNIQUE INDEX "HostConsumerMessage_replay_key" ON "HostConsumerMessage"("tenantId", "hostConsumerId", "tokenJti", "bodyDigest");
CREATE INDEX "HostConsumerMessage_tenantId_hostConsumerId_createdAt_idx" ON "HostConsumerMessage"("tenantId", "hostConsumerId", "createdAt");
CREATE INDEX "HostConsumerMessage_tenantId_runId_idx" ON "HostConsumerMessage"("tenantId", "runId");

CREATE INDEX "HostConsumerKillSwitch_tenantId_hostConsumerId_liftedAt_idx" ON "HostConsumerKillSwitch"("tenantId", "hostConsumerId", "liftedAt");
CREATE INDEX "HostConsumerKillSwitch_tenantId_engagedAt_idx" ON "HostConsumerKillSwitch"("tenantId", "engagedAt");

-- At most ONE kill in force per consumer, exactly as the peer switch has. Two
-- concurrent engages would otherwise both land, and lifting one would leave the
-- consumer still stopped with no visible reason.
CREATE UNIQUE INDEX "HostConsumerKillSwitch_one_in_force_per_consumer"
    ON "HostConsumerKillSwitch"("tenantId", "hostConsumerId")
    WHERE "liftedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "HostConsumer" ADD CONSTRAINT "HostConsumer_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HostConsumer" ADD CONSTRAINT "HostConsumer_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HostConsumer" ADD CONSTRAINT "HostConsumer_receivingAgentId_tenantId_fkey"
    FOREIGN KEY ("receivingAgentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HostConsumerMessage" ADD CONSTRAINT "HostConsumerMessage_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- NO foreign key from "HostConsumerMessage" to "HostConsumer", deliberately,
-- exactly as "PeerAgentMessage"."peerId" has none. The evidence must outlive the
-- principal: a consumer is revocable and the tenant purge deletes it, while the
-- record of what it sent is RETAINED. A RESTRICT relation would make those
-- retained rows block the purge of the consumer — a retention class turning
-- into a purge that fails halfway.

ALTER TABLE "HostConsumerKillSwitch" ADD CONSTRAINT "HostConsumerKillSwitch_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
--  Shapes the application must not be the only thing enforcing
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "HostConsumer" ADD CONSTRAINT "HostConsumer_inbound_quota_bounded"
    CHECK ("inboundMessagesPerHour" BETWEEN 1 AND 1000);

-- A secret hash is a hex SHA-256, and a consumer that names no workflow admits
-- nothing. DENY BY DEFAULT is the point: an empty allowlist must not read as
-- "any workflow", here or in the application.
ALTER TABLE "HostConsumer" ADD CONSTRAINT "HostConsumer_secret_shape"
    CHECK (
        "clientSecretHash" ~ '^[0-9a-f]{64}$'
        AND length(btrim("clientId")) > 0
        AND length(btrim("clientSecretPrefix")) > 0
        AND length(btrim("name")) > 0
    );

ALTER TABLE "HostConsumerMessage" ADD CONSTRAINT "HostConsumerMessage_digest_shape"
    CHECK (
        "bodyDigest" ~ '^[0-9a-f]{64}$'
        AND length(btrim("tokenJti")) > 0
        AND length(btrim("clientId")) > 0
    );

ALTER TABLE "HostConsumerKillSwitch" ADD CONSTRAINT "HostConsumerKillSwitch_reason_present"
    CHECK (length(btrim("reason")) > 0);

ALTER TABLE "HostConsumerKillSwitch" ADD CONSTRAINT "HostConsumerKillSwitch_lift_is_complete"
    CHECK (
        ("liftedAt" IS NULL AND "liftedByUserId" IS NULL AND "liftReason" IS NULL)
        OR ("liftedAt" IS NOT NULL AND "liftedByUserId" IS NOT NULL AND length(btrim("liftReason")) > 0)
    );

-- ═══════════════════════════════════════════════════════════════════
--  Write-once
-- ═══════════════════════════════════════════════════════════════════

-- The evidence row. The app has no UPDATE privilege; this is the backstop for a
-- privileged writer that forgets. The one change admitted is the rotation
-- sweeps' re-wrap of the encrypted body: ciphertext to v2 ciphertext, nothing
-- else — the same exception `peer_agent_message_is_immutable` carries.
CREATE OR REPLACE FUNCTION host_consumer_message_is_immutable() RETURNS trigger AS $$
BEGIN
    IF (to_jsonb(NEW) - 'body') = (to_jsonb(OLD) - 'body')
        AND OLD."body" ~ '^v[12]:' AND NEW."body" ~ '^v2:' THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A host-consumer request record is write-once and cannot be changed'
        USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS host_consumer_message_is_immutable ON "HostConsumerMessage";
CREATE TRIGGER host_consumer_message_is_immutable
    BEFORE UPDATE ON "HostConsumerMessage"
    FOR EACH ROW EXECUTE FUNCTION host_consumer_message_is_immutable();

-- EXTENDED, not duplicated. One function says what a run's inbound origin is,
-- so a reader asking "can this be lifted later?" has one place to look. Adding a
-- second trigger for the host columns would let the two drift.
CREATE OR REPLACE FUNCTION workflow_run_inbound_origin_is_final() RETURNS trigger AS $$
BEGIN
    IF NEW."inboundPeerId" IS DISTINCT FROM OLD."inboundPeerId"
        OR NEW."inboundMessageId" IS DISTINCT FROM OLD."inboundMessageId"
        OR NEW."inboundHostConsumerId" IS DISTINCT FROM OLD."inboundHostConsumerId"
        OR NEW."inboundHostMessageId" IS DISTINCT FROM OLD."inboundHostMessageId" THEN
        RAISE EXCEPTION 'A run''s A2A inbound origin is written once, at creation'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A run has ONE inbound origin or none. Both pairs set would mean two
-- principals started one run, and the clamp would be attributed to whichever
-- the reader looked at first.
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_one_inbound_origin"
    CHECK (
        NOT (
            ("inboundPeerId" IS NOT NULL OR "inboundMessageId" IS NOT NULL)
            AND ("inboundHostConsumerId" IS NOT NULL OR "inboundHostMessageId" IS NOT NULL)
        )
    );

-- Each pair is all-or-nothing, because `restoreA2aInbound` needs both ids to
-- rebuild the narrowing and a half-written origin would silently restore none.
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_host_origin_is_whole"
    CHECK (("inboundHostConsumerId" IS NULL) = ("inboundHostMessageId" IS NULL));

-- ═══════════════════════════════════════════════════════════════════
--  Row-level security
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "HostConsumer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HostConsumer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "HostConsumer";
CREATE POLICY tenant_isolation ON "HostConsumer"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "HostConsumer";
CREATE POLICY tenant_isolation_insert ON "HostConsumer"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "HostConsumer";
CREATE POLICY superuser_bypass ON "HostConsumer"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "HostConsumerMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HostConsumerMessage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "HostConsumerMessage";
CREATE POLICY tenant_isolation ON "HostConsumerMessage"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "HostConsumerMessage";
CREATE POLICY tenant_isolation_insert ON "HostConsumerMessage"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "HostConsumerMessage";
CREATE POLICY superuser_bypass ON "HostConsumerMessage"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "HostConsumerKillSwitch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HostConsumerKillSwitch" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "HostConsumerKillSwitch";
CREATE POLICY tenant_isolation ON "HostConsumerKillSwitch"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "HostConsumerKillSwitch";
CREATE POLICY tenant_isolation_insert ON "HostConsumerKillSwitch"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "HostConsumerKillSwitch";
CREATE POLICY superuser_bypass ON "HostConsumerKillSwitch"
    USING (current_setting('role') != 'app_user');
