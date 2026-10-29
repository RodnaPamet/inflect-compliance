-- ONE DELIVERY DECISION PER PEER REPLY (#3744).
--
-- A peer's reply to a task Inflect sent is kept as a receipted
-- `PeerAgentMessage`. This table records whether that reply was handed to the
-- sending run as input, or refused, and why.
--
-- A SIBLING TABLE RATHER THAN A COLUMN. `PeerAgentMessage` carries
-- `peer_agent_message_is_immutable` and `app_user` holds no UPDATE or DELETE on
-- it, so a mutable `deliveredAt` there is unrepresentable. `PeerAgentKillSwitch`
-- is a sibling of the same table for the same reason.
--
-- PLAIN IDS, NO FOREIGN KEYS, for `messageId` and `runId` — as the kill switch
-- keys its peer. The tenant purge RETAINS `PeerAgentMessage`, so an FK from a
-- row the purge does not retain would make the pair a delete cycle. It is also
-- correct for a delivery record to outlive its run: "was this answered" stays
-- answerable after the run is gone.
--
-- INSERT-ONLY, AND IT TAKES AN EXPLICIT REVOKE TO SAY SO. A delivery decision
-- is made once and never amended.
--
-- A narrow `GRANT SELECT, INSERT` does NOT achieve that, and measured here
-- before this comment was written: this database carries
--
--     ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO app_user
--
-- (`pg_default_acl` reads `{app_user=arwd/test}`), so EVERY new table starts
-- with UPDATE and DELETE already granted and a narrower GRANT adds nothing.
-- The first version of this migration granted SELECT and INSERT, said
-- "insert-only" in this comment, and left a table `app_user` could rewrite and
-- empty. `PeerAgentKillSwitch` and `AgentHarnessAcceptance` both read
-- DELETE=false because their migrations REVOKE; that is the only mechanism
-- that works.
--
-- No trigger is needed on top, and no DEK re-wrap exception either, because no
-- column here is encrypted — `reason` is a CODE from a closed vocabulary, never
-- prose about a person, and the CHECK below pins it to that vocabulary.

CREATE TABLE "PeerAgentReplyDelivery" (
    "id"          TEXT         NOT NULL,
    "tenantId"    TEXT         NOT NULL,
    "messageId"   TEXT         NOT NULL,
    "runId"       TEXT         NOT NULL,
    "peerId"      TEXT         NOT NULL,
    "outcome"     TEXT         NOT NULL,
    "refusalCode" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "decidedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeerAgentReplyDelivery_pkey" PRIMARY KEY ("id")
);

-- The database refusing to deliver one reply twice, rather than a
-- read-then-write hoping nothing raced it.
CREATE UNIQUE INDEX "PeerAgentReplyDelivery_tenantId_messageId_key"
    ON "PeerAgentReplyDelivery"("tenantId", "messageId");

CREATE INDEX "PeerAgentReplyDelivery_tenantId_runId_outcome_idx"
    ON "PeerAgentReplyDelivery"("tenantId", "runId", "outcome");
CREATE INDEX "PeerAgentReplyDelivery_tenantId_decidedAt_idx"
    ON "PeerAgentReplyDelivery"("tenantId", "decidedAt");

ALTER TABLE "PeerAgentReplyDelivery"
    ADD CONSTRAINT "PeerAgentReplyDelivery_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Two states, pinned. An enum would need the two-deploy dance a Prisma client
-- that predates a new value forces — the lesson the `PROPOSE` rung and
-- `AI_ADMIN` both record.
ALTER TABLE "PeerAgentReplyDelivery"
    ADD CONSTRAINT "PeerAgentReplyDelivery_outcome_known"
    CHECK ("outcome" IN ('DELIVERED', 'REFUSED'));

-- A refusal NAMES ITS REASON and delivers nothing; a delivery carries no reason
-- and records when it happened. Without this a row could say REFUSED with no
-- reason, which is the state the issue exists to prevent: a reply silently not
-- acted on.
ALTER TABLE "PeerAgentReplyDelivery"
    ADD CONSTRAINT "PeerAgentReplyDelivery_outcome_shape"
    CHECK (
        ("outcome" = 'DELIVERED' AND "refusalCode" IS NULL     AND "deliveredAt" IS NOT NULL)
     OR ("outcome" = 'REFUSED'   AND "refusalCode" IS NOT NULL AND "deliveredAt" IS NULL)
    );

-- The closed vocabulary. A new code widens this CHECK in a migration; never
-- repurpose one, as the workpaper dissent codes are pinned.
--
-- NAMED `refusalCode`, NOT `reason`, and that is load-bearing. `reason` is a
-- manifest field name on `PeerAgentKillSwitch`, and the encryption
-- middleware's fan-out path (`modelName === '*'`) encrypts by FIELD NAME
-- across every manifest model. A plaintext `reason` column here was therefore
-- encrypted on write and then refused by this very CHECK — measured: every
-- REFUSED insert failed while DELIVERED, whose value is NULL, succeeded.
ALTER TABLE "PeerAgentReplyDelivery"
    ADD CONSTRAINT "PeerAgentReplyDelivery_reason_known"
    CHECK (
        "refusalCode" IS NULL
     OR "refusalCode" IN (
            'RUN_ENDED',        -- the run had already ended; the reply is kept
            'RUN_NOT_FOUND',    -- no such run in this tenant
            'RUN_MISMATCH',     -- the reply relates to a message from another run
            'PEER_MISMATCH',    -- not the peer the task was sent to
            'GUARD_REFUSED'     -- the AI Guard refused the content outright
        )
    );

ALTER TABLE "PeerAgentReplyDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PeerAgentReplyDelivery" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PeerAgentReplyDelivery";
CREATE POLICY tenant_isolation ON "PeerAgentReplyDelivery"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "PeerAgentReplyDelivery";
CREATE POLICY tenant_isolation_insert ON "PeerAgentReplyDelivery"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "PeerAgentReplyDelivery";
CREATE POLICY superuser_bypass ON "PeerAgentReplyDelivery"
    USING (current_setting('role') != 'app_user');

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT ON "PeerAgentReplyDelivery" TO app_user;
        -- The load-bearing half. See the header: the default privileges on this
        -- database already granted these, so without the REVOKE the table is
        -- fully writable whatever the GRANT above says.
        REVOKE UPDATE, DELETE ON "PeerAgentReplyDelivery" FROM app_user;
    END IF;
END
$$;
