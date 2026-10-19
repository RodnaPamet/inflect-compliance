-- Step 4b (#3679): A2A messaging with a pinned peer, in both directions.
--
--   PeerAgentMessage            one signed A2A message, sent or received: the
--                               receipt both sides keep. Write-once; retained by
--                               the tenant purge (Regulatory artefact).
--   PeerAgentKillSwitch         a kill for one peer, read on every message in
--                               both directions. A sibling of AgentKillSwitch,
--                               never a scope on it: a NULL agentId there MEANS
--                               a tenant-wide kill.
--   PeerAgentInboundCredential  the bearer one peer presents inbound, hashed,
--                               bound to ONE receiving registered agent and an
--                               allowlist of workflow keys. Narrows; grants
--                               nothing (docs/a2a-mapping.md).
--   TenantA2aSigningKey         the tenant's own Ed25519 signing key (owner
--                               decision 2026-10-19): the seed encrypted under
--                               the tenant DEK, one in force per tenant,
--                               retired keys kept so old receipts verify.
--   PeerAgent.inboundMessagesPerHour
--                               the per-peer inbound quota, 1..1000, default 60.
--   WorkflowRun.inboundPeerId / inboundMessageId
--                               which peer's verified task started a run.
--                               Write-once; read by the R17 clamp and the R14
--                               refusal through RequestContext.a2aInbound.
--
-- Forward-only and additive: four new tables, two nullable columns and one
-- defaulted column, which the previous image never reads or writes (an insert
-- by the previous image takes the default quota).
--
-- ENCRYPTED COLUMNS AND THE WRITE-ONCE TRIGGERS. PeerAgentMessage.body,
-- PeerAgentKillSwitch.reason/liftReason and TenantA2aSigningKey.privateKeySeed
-- are in the Epic B manifest, and the tenant-DEK and master-KEK rotation sweeps
-- rewrite every such ciphertext in place with a raw UPDATE. So each trigger
-- below that freezes a row lets exactly one change through on those columns: a
-- ciphertext replaced by a v2 ciphertext, every other column unchanged. That is
-- a re-wrap, not an edit. A re-wrap that changed the plaintext of a receipt
-- body would stop the receipt verifying against its stored digest and
-- signature, which `verifyStoredA2aReceipt` reports; it cannot be made silent.

-- AlterTable
ALTER TABLE "PeerAgent" ADD COLUMN "inboundMessagesPerHour" INTEGER NOT NULL DEFAULT 60;

ALTER TABLE "PeerAgent" ADD CONSTRAINT "PeerAgent_inbound_quota_bounded"
    CHECK ("inboundMessagesPerHour" BETWEEN 1 AND 1000);

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN "inboundMessageId" TEXT,
ADD COLUMN "inboundPeerId" TEXT;

-- CreateTable
CREATE TABLE "PeerAgentMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "method" TEXT,
    "messageId" TEXT NOT NULL,
    "relatesToMessageId" TEXT,
    "receiptJson" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signerKeyFingerprint" TEXT NOT NULL,
    "signerPublicKey" TEXT NOT NULL,
    "bodyDigest" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "agentId" TEXT,
    "runId" TEXT,
    "journalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeerAgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeerAgentKillSwitch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "engagedByUserId" TEXT NOT NULL,
    "engagedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt" TIMESTAMP(3),
    "liftedByUserId" TEXT,
    "liftReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PeerAgentKillSwitch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeerAgentInboundCredential" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "receivingAgentId" TEXT NOT NULL,
    "workflowKeys" TEXT[],
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PeerAgentInboundCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantA2aSigningKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "privateKeySeed" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    "retiredByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantA2aSigningKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantA2aSigningKey_tenantId_retiredAt_idx" ON "TenantA2aSigningKey"("tenantId", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "TenantA2aSigningKey_id_tenantId_key" ON "TenantA2aSigningKey"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantA2aSigningKey_tenantId_fingerprint_key" ON "TenantA2aSigningKey"("tenantId", "fingerprint");

-- AddForeignKey
ALTER TABLE "TenantA2aSigningKey" ADD CONSTRAINT "TenantA2aSigningKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "PeerAgentMessage_tenantId_peerId_direction_createdAt_idx" ON "PeerAgentMessage"("tenantId", "peerId", "direction", "createdAt");

-- CreateIndex
CREATE INDEX "PeerAgentMessage_tenantId_runId_idx" ON "PeerAgentMessage"("tenantId", "runId");

-- CreateIndex
CREATE INDEX "PeerAgentMessage_tenantId_journalId_idx" ON "PeerAgentMessage"("tenantId", "journalId");

-- CreateIndex
CREATE UNIQUE INDEX "PeerAgentMessage_id_tenantId_key" ON "PeerAgentMessage"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PeerAgentMessage_tenantId_peerId_direction_messageId_key" ON "PeerAgentMessage"("tenantId", "peerId", "direction", "messageId");

-- CreateIndex
CREATE INDEX "PeerAgentKillSwitch_tenantId_peerId_liftedAt_idx" ON "PeerAgentKillSwitch"("tenantId", "peerId", "liftedAt");

-- CreateIndex
CREATE INDEX "PeerAgentKillSwitch_tenantId_engagedAt_idx" ON "PeerAgentKillSwitch"("tenantId", "engagedAt");

-- CreateIndex
CREATE INDEX "PeerAgentInboundCredential_tenantId_peerId_revokedAt_idx" ON "PeerAgentInboundCredential"("tenantId", "peerId", "revokedAt");

-- CreateIndex
CREATE INDEX "PeerAgentInboundCredential_tenantId_receivingAgentId_idx" ON "PeerAgentInboundCredential"("tenantId", "receivingAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "PeerAgentInboundCredential_id_tenantId_key" ON "PeerAgentInboundCredential"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "PeerAgentMessage" ADD CONSTRAINT "PeerAgentMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerAgentKillSwitch" ADD CONSTRAINT "PeerAgentKillSwitch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerAgentInboundCredential" ADD CONSTRAINT "PeerAgentInboundCredential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerAgentInboundCredential" ADD CONSTRAINT "PeerAgentInboundCredential_peerId_tenantId_fkey" FOREIGN KEY ("peerId", "tenantId") REFERENCES "PeerAgent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerAgentInboundCredential" ADD CONSTRAINT "PeerAgentInboundCredential_receivingAgentId_tenantId_fkey" FOREIGN KEY ("receivingAgentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- NOTE: PeerAgentMessage.peerId / runId / journalId and PeerAgentKillSwitch.peerId
-- carry NO foreign key, on purpose. A receipt and a kill are retained evidence
-- that must outlive the peer, the run and the journal row they were about, and a
-- retained table must never be reached by a cascade from a purged one
-- (tests/guardrails/tenant-purge-retained-never-cascades.test.ts). The drill also
-- engages a kill against a canary peer id no peer can have.

-- ═══════════════════════════════════════════════════════════════════
-- PeerAgentMessage — the receipt
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "PeerAgentMessage" ADD CONSTRAINT "PeerAgentMessage_direction_known"
    CHECK ("direction" IN ('INBOUND', 'OUTBOUND'));

-- A TASK carries the method it asked for and answers nothing; a RESULT answers
-- exactly one TASK and asks for nothing.
ALTER TABLE "PeerAgentMessage" ADD CONSTRAINT "PeerAgentMessage_kind_shape"
    CHECK (
        ("kind" = 'TASK' AND "method" IN ('message/send', 'tasks/get') AND "relatesToMessageId" IS NULL)
        OR ("kind" = 'RESULT' AND "method" IS NULL AND "relatesToMessageId" IS NOT NULL)
    );

ALTER TABLE "PeerAgentMessage" ADD CONSTRAINT "PeerAgentMessage_digest_shape"
    CHECK (
        "bodyDigest" ~ '^[0-9a-f]{64}$'
        AND "signerKeyFingerprint" ~ '^[0-9a-f]{64}$'
        AND "signerPublicKey" ~ '^[0-9a-f]{64}$'
        AND length(btrim("messageId")) > 0
    );

-- Write-once. The app has no UPDATE privilege; this is the backstop for a
-- privileged writer that forgets, because an edited receipt is a forged one.
-- The one change it admits is the key-rotation sweeps' re-wrap of the
-- encrypted body (see the header): ciphertext to v2 ciphertext, nothing else.
CREATE OR REPLACE FUNCTION peer_agent_message_is_immutable() RETURNS trigger AS $$
BEGIN
    IF (to_jsonb(NEW) - 'body') = (to_jsonb(OLD) - 'body')
        AND OLD."body" ~ '^v[12]:' AND NEW."body" ~ '^v2:' THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'An A2A message receipt is write-once and cannot be changed'
        USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS peer_agent_message_is_immutable ON "PeerAgentMessage";
CREATE TRIGGER peer_agent_message_is_immutable
    BEFORE UPDATE ON "PeerAgentMessage"
    FOR EACH ROW EXECUTE FUNCTION peer_agent_message_is_immutable();

-- ═══════════════════════════════════════════════════════════════════
-- PeerAgentKillSwitch — the per-peer kill
-- ═══════════════════════════════════════════════════════════════════

-- At most ONE kill in force per peer. Two concurrent engages would otherwise both
-- land, and lifting one would leave the peer still stopped with no visible reason.
CREATE UNIQUE INDEX "PeerAgentKillSwitch_one_in_force_per_peer"
    ON "PeerAgentKillSwitch"("tenantId", "peerId")
    WHERE "liftedAt" IS NULL;

ALTER TABLE "PeerAgentKillSwitch" ADD CONSTRAINT "PeerAgentKillSwitch_reason_present"
    CHECK (length(btrim("reason")) > 0 AND length(btrim("peerId")) > 0);

-- Lifted only by a person with a reason: the three lift columns travel together,
-- and the reason is not blank.
ALTER TABLE "PeerAgentKillSwitch" ADD CONSTRAINT "PeerAgentKillSwitch_lift_accountability"
    CHECK (
        ("liftedAt" IS NULL AND "liftedByUserId" IS NULL AND "liftReason" IS NULL)
        OR (
            "liftedAt" IS NOT NULL AND "liftedByUserId" IS NOT NULL
            AND "liftReason" IS NOT NULL AND length(btrim("liftReason")) > 0
        )
    );

-- The engagement is history and the lift is final: a lifted kill cannot be
-- re-engaged by un-lifting it (a new kill is a new row), and nothing about who
-- stopped the peer, when and why can be rewritten afterwards.
CREATE OR REPLACE FUNCTION peer_agent_kill_switch_history_is_final() RETURNS trigger AS $$
BEGIN
    -- The key-rotation sweeps' re-wrap of an encrypted reason (see the header).
    IF (to_jsonb(NEW) - 'reason' - 'liftReason') = (to_jsonb(OLD) - 'reason' - 'liftReason')
        AND (NEW."reason" IS NOT DISTINCT FROM OLD."reason"
             OR (OLD."reason" ~ '^v[12]:' AND NEW."reason" ~ '^v2:'))
        AND (NEW."liftReason" IS NOT DISTINCT FROM OLD."liftReason"
             OR (OLD."liftReason" ~ '^v[12]:' AND NEW."liftReason" ~ '^v2:')) THEN
        RETURN NEW;
    END IF;
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
        OR NEW."peerId" IS DISTINCT FROM OLD."peerId"
        OR NEW."reason" IS DISTINCT FROM OLD."reason"
        OR NEW."engagedByUserId" IS DISTINCT FROM OLD."engagedByUserId"
        OR NEW."engagedAt" IS DISTINCT FROM OLD."engagedAt" THEN
        RAISE EXCEPTION 'A peer kill''s engagement cannot be changed'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD."liftedAt" IS NOT NULL AND (
        NEW."liftedAt" IS DISTINCT FROM OLD."liftedAt"
        OR NEW."liftedByUserId" IS DISTINCT FROM OLD."liftedByUserId"
        OR NEW."liftReason" IS DISTINCT FROM OLD."liftReason"
    ) THEN
        RAISE EXCEPTION 'A lifted peer kill is final'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS peer_agent_kill_switch_history_is_final ON "PeerAgentKillSwitch";
CREATE TRIGGER peer_agent_kill_switch_history_is_final
    BEFORE UPDATE ON "PeerAgentKillSwitch"
    FOR EACH ROW EXECUTE FUNCTION peer_agent_kill_switch_history_is_final();

-- ═══════════════════════════════════════════════════════════════════
-- PeerAgentInboundCredential — the inbound bearer
-- ═══════════════════════════════════════════════════════════════════

-- At most one live credential per peer, so "which credential does this peer
-- hold" has one answer and a rotation is revoke-then-issue.
CREATE UNIQUE INDEX "PeerAgentInboundCredential_one_live_per_peer"
    ON "PeerAgentInboundCredential"("tenantId", "peerId")
    WHERE "revokedAt" IS NULL;

ALTER TABLE "PeerAgentInboundCredential" ADD CONSTRAINT "PeerAgentInboundCredential_shape"
    CHECK (
        "keyHash" ~ '^[0-9a-f]{64}$'
        AND cardinality("workflowKeys") >= 1
        AND (("revokedAt" IS NULL) = ("revokedByUserId" IS NULL))
    );

-- What the credential binds is fixed at issue, and revocation is final. A
-- re-binding is a new credential, so the peer must be handed a new token.
CREATE OR REPLACE FUNCTION peer_agent_inbound_credential_is_final() RETURNS trigger AS $$
BEGIN
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
        OR NEW."peerId" IS DISTINCT FROM OLD."peerId"
        OR NEW."receivingAgentId" IS DISTINCT FROM OLD."receivingAgentId"
        OR NEW."workflowKeys" IS DISTINCT FROM OLD."workflowKeys"
        OR NEW."keyHash" IS DISTINCT FROM OLD."keyHash"
        OR NEW."keyPrefix" IS DISTINCT FROM OLD."keyPrefix"
        OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId" THEN
        RAISE EXCEPTION 'An A2A inbound credential''s binding cannot be changed; issue a new one'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD."revokedAt" IS NOT NULL AND (
        NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
        OR NEW."revokedByUserId" IS DISTINCT FROM OLD."revokedByUserId"
    ) THEN
        RAISE EXCEPTION 'A revoked A2A inbound credential stays revoked'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS peer_agent_inbound_credential_is_final ON "PeerAgentInboundCredential";
CREATE TRIGGER peer_agent_inbound_credential_is_final
    BEFORE UPDATE ON "PeerAgentInboundCredential"
    FOR EACH ROW EXECUTE FUNCTION peer_agent_inbound_credential_is_final();

-- No live credential for a RETIRED agent (owner decision 2026-10-19). The
-- retirement cascade revokes every live credential bound to the agent in its
-- own transaction; this is the backstop for an issue in flight at that moment,
-- in the shape of the retirement migration's insert triggers
-- (20261017235800): FOR SHARE on the agent row serialises the insert with the
-- retirement's status UPDATE, so it either committed first and is revoked by
-- the cascade, or waits, reads RETIRED, and is refused with the prefix
-- `isAgentRetiredDbRefusal` matches.
CREATE OR REPLACE FUNCTION agent_retired_refuses_peer_inbound_credential()
RETURNS TRIGGER AS $$
DECLARE
    agent_status "AgentStatus";
BEGIN
    IF NEW."revokedAt" IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT ra."status" INTO agent_status
      FROM "RegisteredAgent" ra
     WHERE ra."id" = NEW."receivingAgentId" AND ra."tenantId" = NEW."tenantId"
       FOR SHARE;
    IF agent_status = 'RETIRED' THEN
        RAISE EXCEPTION
            'AGENT_RETIRED: a retired agent cannot receive A2A tasks, so no credential can bind a peer to it.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_retired_refuses_peer_inbound_credential ON "PeerAgentInboundCredential";
CREATE TRIGGER agent_retired_refuses_peer_inbound_credential
    BEFORE INSERT ON "PeerAgentInboundCredential"
    FOR EACH ROW EXECUTE FUNCTION agent_retired_refuses_peer_inbound_credential();

-- ═══════════════════════════════════════════════════════════════════
-- TenantA2aSigningKey — the tenant's own signing key
-- ═══════════════════════════════════════════════════════════════════

-- One key in force per tenant, so "which key signs" has one answer and a
-- rotation is retire-then-create in one transaction.
CREATE UNIQUE INDEX "TenantA2aSigningKey_one_in_force_per_tenant"
    ON "TenantA2aSigningKey"("tenantId")
    WHERE "retiredAt" IS NULL;

-- A key in force holds its seed; a retired key holds none and names who
-- retired it. So a retired key can verify and can never sign again.
ALTER TABLE "TenantA2aSigningKey" ADD CONSTRAINT "TenantA2aSigningKey_shape"
    CHECK (
        "publicKey" ~ '^[0-9a-f]{64}$'
        AND "fingerprint" ~ '^[0-9a-f]{64}$'
        AND (("retiredAt" IS NULL) = ("retiredByUserId" IS NULL))
        AND (("retiredAt" IS NULL) = ("privateKeySeed" IS NOT NULL))
    );

-- A key's identity is fixed at birth, and retirement is final. The seed may
-- change in exactly two ways: re-wrapped by a key-rotation sweep while the key
-- is in force (ciphertext to v2 ciphertext), or cleared by the retirement.
CREATE OR REPLACE FUNCTION tenant_a2a_signing_key_is_final() RETURNS trigger AS $$
BEGIN
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
        OR NEW."publicKey" IS DISTINCT FROM OLD."publicKey"
        OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
        OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'An A2A signing key''s identity cannot be changed; rotate to a new key'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD."retiredAt" IS NOT NULL AND (
        NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt"
        OR NEW."retiredByUserId" IS DISTINCT FROM OLD."retiredByUserId"
        OR NEW."privateKeySeed" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'A retired A2A signing key stays retired'
            USING ERRCODE = 'P0001';
    END IF;
    IF NEW."privateKeySeed" IS NOT NULL
        AND NEW."privateKeySeed" IS DISTINCT FROM OLD."privateKeySeed"
        AND NOT (OLD."privateKeySeed" ~ '^v[12]:' AND NEW."privateKeySeed" ~ '^v2:') THEN
        RAISE EXCEPTION 'An A2A signing key''s seed cannot be replaced; rotate to a new key'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_a2a_signing_key_is_final ON "TenantA2aSigningKey";
CREATE TRIGGER tenant_a2a_signing_key_is_final
    BEFORE UPDATE ON "TenantA2aSigningKey"
    FOR EACH ROW EXECUTE FUNCTION tenant_a2a_signing_key_is_final();

-- ═══════════════════════════════════════════════════════════════════
-- WorkflowRun — the inbound origin is write-once
-- ═══════════════════════════════════════════════════════════════════

-- R17 (no external write above PROPOSE_ONLY) and R14 (no outbound A2A send) are
-- keyed on these two columns. An UPDATE that cleared them would lift both rules
-- for a run a peer started, so they are written in the run's INSERT and never
-- again — NULL -> value included, because a later fill could only be a
-- reconstruction.
CREATE OR REPLACE FUNCTION workflow_run_inbound_origin_is_final() RETURNS trigger AS $$
BEGIN
    IF NEW."inboundPeerId" IS DISTINCT FROM OLD."inboundPeerId"
        OR NEW."inboundMessageId" IS DISTINCT FROM OLD."inboundMessageId" THEN
        RAISE EXCEPTION 'A run''s A2A inbound origin is written once, at creation'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_run_inbound_origin_is_final ON "WorkflowRun";
CREATE TRIGGER workflow_run_inbound_origin_is_final
    BEFORE UPDATE OF "inboundPeerId", "inboundMessageId" ON "WorkflowRun"
    FOR EACH ROW EXECUTE FUNCTION workflow_run_inbound_origin_is_final();

ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_inbound_origin_pairing"
    CHECK (("inboundPeerId" IS NULL) = ("inboundMessageId" IS NULL));

-- ═══════════════════════════════════════════════════════════════════
-- Privileges and row-level security (Epic A.1). tenantId is NOT NULL on all
-- four, so the split policy form is correct.
-- ═══════════════════════════════════════════════════════════════════
--
-- Default privileges grant every verb to app_user (20260323180000), so the
-- verbs a table must not allow are revoked explicitly:
--   PeerAgentMessage            SELECT, INSERT          — write-once, never deleted
--   PeerAgentKillSwitch         SELECT, INSERT, UPDATE  — lifting is an UPDATE
--   PeerAgentInboundCredential  SELECT, INSERT, UPDATE  — revoking is an UPDATE
--   TenantA2aSigningKey         SELECT, INSERT, UPDATE  — retiring is an UPDATE
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT ON "PeerAgentMessage" TO app_user;
        REVOKE UPDATE, DELETE ON "PeerAgentMessage" FROM app_user;
        GRANT SELECT, INSERT, UPDATE ON "PeerAgentKillSwitch" TO app_user;
        REVOKE DELETE ON "PeerAgentKillSwitch" FROM app_user;
        GRANT SELECT, INSERT, UPDATE ON "PeerAgentInboundCredential" TO app_user;
        REVOKE DELETE ON "PeerAgentInboundCredential" FROM app_user;
        GRANT SELECT, INSERT, UPDATE ON "TenantA2aSigningKey" TO app_user;
        REVOKE DELETE ON "TenantA2aSigningKey" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "PeerAgentMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PeerAgentMessage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PeerAgentMessage";
CREATE POLICY tenant_isolation ON "PeerAgentMessage"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "PeerAgentMessage";
CREATE POLICY tenant_isolation_insert ON "PeerAgentMessage"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "PeerAgentMessage";
CREATE POLICY superuser_bypass ON "PeerAgentMessage"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "PeerAgentKillSwitch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PeerAgentKillSwitch" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PeerAgentKillSwitch";
CREATE POLICY tenant_isolation ON "PeerAgentKillSwitch"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "PeerAgentKillSwitch";
CREATE POLICY tenant_isolation_insert ON "PeerAgentKillSwitch"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "PeerAgentKillSwitch";
CREATE POLICY superuser_bypass ON "PeerAgentKillSwitch"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "PeerAgentInboundCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PeerAgentInboundCredential" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PeerAgentInboundCredential";
CREATE POLICY tenant_isolation ON "PeerAgentInboundCredential"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "PeerAgentInboundCredential";
CREATE POLICY tenant_isolation_insert ON "PeerAgentInboundCredential"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "PeerAgentInboundCredential";
CREATE POLICY superuser_bypass ON "PeerAgentInboundCredential"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "TenantA2aSigningKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantA2aSigningKey" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TenantA2aSigningKey";
CREATE POLICY tenant_isolation ON "TenantA2aSigningKey"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TenantA2aSigningKey";
CREATE POLICY tenant_isolation_insert ON "TenantA2aSigningKey"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "TenantA2aSigningKey";
CREATE POLICY superuser_bypass ON "TenantA2aSigningKey"
    USING (current_setting('role') != 'app_user');
