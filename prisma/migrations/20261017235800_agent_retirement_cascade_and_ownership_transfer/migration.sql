-- Agent retirement cascade and two-step ownership transfer (#3698, step 2a of
-- the agentic IAM roadmap). Sections 1-4 are the retirement backstops; section 5
-- creates "AgentOwnershipTransfer".
--
-- `retireRegisteredAgent` now revokes the agent's credentials, drops its tool
-- grants, expires its PENDING proposals and freezes its policy card in one
-- transaction. The usecase is the primary control. These triggers are the
-- backstop for every write that can be in flight WHILE the agent is retired —
-- the agent queueing a proposal, a card edit, a human minting a key or a
-- scanner key or granting a tool — and for the one move that would undo
-- retirement: a status change out of RETIRED. Each in-flight insert takes
-- FOR SHARE on the agent row, which is what makes it serialise with the
-- retirement's status UPDATE instead of slipping in behind its cascade.
--
-- Every refusal raises with the prefix `AGENT_RETIRED:` and the DEFAULT SQLSTATE
-- (P0001, raise_exception), as the four-eyes triggers in 20260906120000 do —
-- deliberately NOT restrict_violation. Prisma renders 23001 as "Foreign key
-- constraint violated" and drops the message, so a refusal raised under it could
-- not be told apart from a real FK failure. `isAgentRetiredDbRefusal` in
-- src/lib/agentic/agent-retirement.ts matches the prefix and maps it back to the
-- usecase's typed error.
--
-- Triggers are invisible to Prisma's schema, so nothing here belongs in
-- prisma/fresh-db-schema-drift.expected.sql. The integration suite
-- tests/integration/agent-retirement-cascade.test.ts is their only guard.

-- ═══════════════════════════════════════════════════════════════════
-- 1. No PENDING proposal for a RETIRED agent
-- ═══════════════════════════════════════════════════════════════════
--
-- An agent writes its own proposals, and it is most likely to be mid-call at the
-- moment an operator retires it. `FOR SHARE` on the agent row is what makes the
-- race resolve: retirement's status UPDATE holds the row's FOR NO KEY UPDATE
-- lock until it commits, so this SELECT waits for that commit and then — under
-- READ COMMITTED — reads the committed status. An insert that took the share lock
-- first commits before the retirement's UPDATE can run, and the cascade then
-- expires it. Either way no PENDING row survives a retirement.
--
-- QUARANTINED rows are NOT refused: a quarantined proposal is the evidence that
-- an attempt was made, and it can never be approved.
CREATE OR REPLACE FUNCTION agent_retired_refuses_pending_proposal()
RETURNS TRIGGER AS $$
DECLARE
    agent_status "AgentStatus";
BEGIN
    IF NEW."agentId" IS NULL OR NEW."status" <> 'PENDING' THEN
        RETURN NEW;
    END IF;
    SELECT ra."status" INTO agent_status
      FROM "RegisteredAgent" ra
     WHERE ra."id" = NEW."agentId" AND ra."tenantId" = NEW."tenantId"
       FOR SHARE;
    IF agent_status = 'RETIRED' THEN
        RAISE EXCEPTION
            'AGENT_RETIRED: a retired agent cannot queue a proposal for review.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_proposal_agent_not_retired ON "AgentProposal";
CREATE TRIGGER agent_proposal_agent_not_retired
    BEFORE INSERT ON "AgentProposal"
    FOR EACH ROW
    EXECUTE FUNCTION agent_retired_refuses_pending_proposal();

-- ═══════════════════════════════════════════════════════════════════
-- 2. A RETIRED agent's policy card is frozen
-- ═══════════════════════════════════════════════════════════════════
--
-- No further "AgentPolicyCardVersion" for an agent that is RETIRED. The card
-- head and its history stay, readable; only a NEW version is refused. Same lock
-- discipline as above, taken on the agent row only (`FOR SHARE OF ra`), so the
-- card head an in-flight edit has already locked is not touched here.
CREATE OR REPLACE FUNCTION agent_retired_freezes_policy_card()
RETURNS TRIGGER AS $$
DECLARE
    agent_status "AgentStatus";
BEGIN
    SELECT ra."status" INTO agent_status
      FROM "AgentPolicyCard" c
      JOIN "RegisteredAgent" ra
        ON ra."id" = c."agentId" AND ra."tenantId" = c."tenantId"
     WHERE c."id" = NEW."cardId" AND c."tenantId" = NEW."tenantId"
       FOR SHARE OF ra;
    IF agent_status = 'RETIRED' THEN
        RAISE EXCEPTION
            'AGENT_RETIRED: a retired agent''s policy card is frozen; no further version can be written.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_policy_card_version_agent_not_retired ON "AgentPolicyCardVersion";
CREATE TRIGGER agent_policy_card_version_agent_not_retired
    BEFORE INSERT ON "AgentPolicyCardVersion"
    FOR EACH ROW
    EXECUTE FUNCTION agent_retired_freezes_policy_card();

-- ═══════════════════════════════════════════════════════════════════
-- 3. RETIRED is terminal
-- ═══════════════════════════════════════════════════════════════════
--
-- Retirement revoked the agent's credentials, dropped its grants and froze its
-- card. A move back to ACTIVE would put that register row into service again and
-- lift the freeze; a move to SUSPENDED would make the permanent state reversible
-- through the kill switch's route. `RegisteredAgentRepository.setStatus` already
-- matches no RETIRED row; this refuses the same move from any writer, any role.
--
-- `UPDATE OF "status"` plus the WHEN clause, so every other column of a retired
-- agent (its soft-delete, its name) stays writable and this fires only on the
-- one transition it exists to refuse.
CREATE OR REPLACE FUNCTION registered_agent_retirement_is_terminal()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'AGENT_RETIRED: retirement is permanent; a retired agent cannot change status.';
    RETURN NULL; -- never reached
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS registered_agent_retirement_is_terminal ON "RegisteredAgent";
CREATE TRIGGER registered_agent_retirement_is_terminal
    BEFORE UPDATE OF "status" ON "RegisteredAgent"
    FOR EACH ROW
    WHEN (OLD."status" = 'RETIRED' AND NEW."status" IS DISTINCT FROM 'RETIRED')
    EXECUTE FUNCTION registered_agent_retirement_is_terminal();

-- ═══════════════════════════════════════════════════════════════════
-- 4. No credential and no grant is minted for a RETIRED agent
-- ═══════════════════════════════════════════════════════════════════
--
-- Retirement revokes every "TenantApiKey" and "AgentHarnessScannerKey" bound to
-- the agent and deletes every "RegisteredAgentTool" grant. "Every" has to hold
-- of rows another request is writing AT THAT MOMENT, and the usecases that
-- write them cannot make it hold: `createApiKey`, `grantAgentTool` and
-- `addHarnessScannerKey` each read the agent's status with a plain SELECT and
-- then insert. Under READ COMMITTED nothing makes that insert wait for a
-- retirement — its foreign-key check takes FOR KEY SHARE, which does not
-- conflict with the FOR NO KEY UPDATE retirement's status UPDATE holds, and the
-- cascade's own UPDATE/DELETE cannot see a row that is not yet committed. So a
-- key minted at the moment of retirement would survive it, unrevoked, bound to
-- a RETIRED agent, and authenticate.
--
-- The fix is section 1's lock discipline: take FOR SHARE on the agent row. It
-- conflicts with retirement's status UPDATE, so either this insert took it
-- first — then retirement's UPDATE waits for this insert to COMMIT, and its
-- cascade then sees, revokes or deletes the row and lists it — or retirement
-- took the row first, and this insert waits for that commit and then reads
-- RETIRED and is refused. The usecases map the refusal to the typed error they
-- would have raised had they seen the status themselves.
--
-- A key or scanner key inserted ALREADY revoked is not refused: it confers
-- nothing, and is history. For "TenantApiKey" a re-bind is covered too
-- (`UPDATE OF "agentId"`) — no usecase does one, but a writer that did would
-- open the same hole. A grant is refused unconditionally: it has no revoked
-- state, a row IS the authority. For a grant written by Prisma's upsert the
-- BEFORE INSERT trigger fires even when ON CONFLICT then updates the existing
-- row; a grant row that exists when retirement runs is deleted by it.
CREATE OR REPLACE FUNCTION agent_retired_refuses_authority()
RETURNS TRIGGER AS $$
DECLARE
    agent_status "AgentStatus";
BEGIN
    SELECT ra."status" INTO agent_status
      FROM "RegisteredAgent" ra
     WHERE ra."id" = NEW."agentId" AND ra."tenantId" = NEW."tenantId"
       FOR SHARE;
    IF agent_status = 'RETIRED' THEN
        RAISE EXCEPTION
            'AGENT_RETIRED: a retired agent cannot be given a credential or a tool grant (%).',
            TG_TABLE_NAME;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_api_key_agent_not_retired ON "TenantApiKey";
CREATE TRIGGER tenant_api_key_agent_not_retired
    BEFORE INSERT OR UPDATE OF "agentId" ON "TenantApiKey"
    FOR EACH ROW
    WHEN (NEW."agentId" IS NOT NULL AND NEW."revokedAt" IS NULL)
    EXECUTE FUNCTION agent_retired_refuses_authority();

DROP TRIGGER IF EXISTS agent_harness_scanner_key_agent_not_retired ON "AgentHarnessScannerKey";
CREATE TRIGGER agent_harness_scanner_key_agent_not_retired
    BEFORE INSERT ON "AgentHarnessScannerKey"
    FOR EACH ROW
    WHEN (NEW."revokedAt" IS NULL)
    EXECUTE FUNCTION agent_retired_refuses_authority();

DROP TRIGGER IF EXISTS registered_agent_tool_agent_not_retired ON "RegisteredAgentTool";
CREATE TRIGGER registered_agent_tool_agent_not_retired
    BEFORE INSERT ON "RegisteredAgentTool"
    FOR EACH ROW
    EXECUTE FUNCTION agent_retired_refuses_authority();

-- ═══════════════════════════════════════════════════════════════════
-- 5. AgentOwnershipTransfer — the two-step handover of an agent's owner
-- ═══════════════════════════════════════════════════════════════════
--
-- Step one records who should become the accountable owner; only that person
-- completes it, and the person who started it never can. Both steps are
-- `requirePermission('admin.tenant_lifecycle')` at the route (step 0e of the
-- agentic IAM roadmap). `RegisteredAgent.ownerUserId` moves only through the
-- completion of a row here — the register's PATCH refuses the field.
--
-- The base DDL below is Prisma's own output for the model (generated with
-- `prisma migrate diff --to-schema`), so the fresh-database drift gate stays
-- green. Everything after it — the CHECKs, the partial unique index, the
-- one-way trigger and the privileges — is invisible to Prisma, and
-- tests/integration/agent-ownership-transfer.test.ts is its only guard.

-- CreateTable
CREATE TABLE "AgentOwnershipTransfer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "fromOwnerUserId" TEXT NOT NULL,
    "toOwnerUserId" TEXT NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentOwnershipTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentOwnershipTransfer_tenantId_agentId_createdAt_idx" ON "AgentOwnershipTransfer"("tenantId", "agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentOwnershipTransfer_id_tenantId_key" ON "AgentOwnershipTransfer"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "AgentOwnershipTransfer" ADD CONSTRAINT "AgentOwnershipTransfer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- NO ACTION, not CASCADE: removing an agent is a soft delete, and a transfer is
-- the record of who was handed its accountability — it must not vanish with a
-- hard delete of the row it describes. A tenant purge removes both in one
-- statement, which NO ACTION (checked at statement end) permits.
ALTER TABLE "AgentOwnershipTransfer" ADD CONSTRAINT "AgentOwnershipTransfer_agentId_tenantId_fkey" FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- The four states, pinned so a fifth cannot appear silently. TEXT + CHECK
-- rather than a Postgres enum for the reason the PROPOSE rung records: a value
-- can be added to a CHECK in one forward migration, while dropping an enum value
-- means recreating the type under every running container.
ALTER TABLE "AgentOwnershipTransfer"
    ADD CONSTRAINT "AgentOwnershipTransfer_status_known"
    CHECK ("status" IN ('PENDING', 'COMPLETED', 'CANCELLED', 'EXPIRED'));

-- A transfer moves ownership somewhere. Proposing the current owner is refused
-- by the usecase too; here it is unrepresentable.
ALTER TABLE "AgentOwnershipTransfer"
    ADD CONSTRAINT "AgentOwnershipTransfer_moves_ownership"
    CHECK ("fromOwnerUserId" <> "toOwnerUserId");

-- THE TWO-PERSON RULE, first half: whoever starts a transfer is not the person
-- it names.
ALTER TABLE "AgentOwnershipTransfer"
    ADD CONSTRAINT "AgentOwnershipTransfer_initiator_is_not_recipient"
    CHECK ("initiatedByUserId" <> "toOwnerUserId");

-- THE TWO-PERSON RULE, second half: a COMPLETED row carries both completion
-- columns, any other row carries neither, and the completer is the recipient.
-- With the CHECK above that makes "the initiator completed it" unrepresentable,
-- whatever any writer does.
ALTER TABLE "AgentOwnershipTransfer"
    ADD CONSTRAINT "AgentOwnershipTransfer_completion_shape"
    CHECK (
        (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL))
        AND (("completedAt" IS NULL) = ("completedByUserId" IS NULL))
        AND ("completedByUserId" IS NULL OR "completedByUserId" = "toOwnerUserId")
    );

ALTER TABLE "AgentOwnershipTransfer"
    ADD CONSTRAINT "AgentOwnershipTransfer_cancellation_shape"
    CHECK (
        (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL))
        AND (("cancelledAt" IS NULL) = ("cancelledByUserId" IS NULL))
    );

-- A transfer with no window could never be completed.
ALTER TABLE "AgentOwnershipTransfer"
    ADD CONSTRAINT "AgentOwnershipTransfer_window_positive"
    CHECK ("expiresAt" > "createdAt");

-- At most ONE open transfer per agent. PARTIAL, so an agent can be handed on
-- any number of times over its life. Prisma cannot declare a partial index:
-- the model carries a comment saying not to add a @@unique for it, because the
-- next `migrate dev` would replace this with an unconditional one.
CREATE UNIQUE INDEX "AgentOwnershipTransfer_one_open_per_agent"
    ON "AgentOwnershipTransfer"("tenantId", "agentId")
    WHERE "status" = 'PENDING';

-- ONE WAY OUT OF PENDING, AND NONE AFTER. A COMPLETED row is what 2b's
-- OWNER_DEPARTED lift reads as proof that accountability moved, so it must not
-- be rewritable by any role, the owner included. A CANCELLED or EXPIRED row is
-- history in the same sense. Same default SQLSTATE and prefix discipline as the
-- retirement triggers above (`AGENT_OWNERSHIP_TRANSFER_CLOSED:`).
CREATE OR REPLACE FUNCTION agent_ownership_transfer_one_way()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'AGENT_OWNERSHIP_TRANSFER_CLOSED: a transfer that has left PENDING is history and cannot be changed.';
    RETURN NULL; -- never reached
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_ownership_transfer_one_way ON "AgentOwnershipTransfer";
CREATE TRIGGER agent_ownership_transfer_one_way
    BEFORE UPDATE ON "AgentOwnershipTransfer"
    FOR EACH ROW
    WHEN (OLD."status" <> 'PENDING')
    EXECUTE FUNCTION agent_ownership_transfer_one_way();

-- NO TRANSFER OPENS ON A RETIRED AGENT. Retirement cancels the agent's open
-- transfer in its cascade; this closes the race in which a proposal is being
-- inserted while the agent is being retired. The lock discipline is section 1's:
-- `FOR SHARE` waits on the retirement's status UPDATE and then reads RETIRED, or
-- it is taken first, in which case the retirement waits for this insert to commit
-- and its cascade then sees — and cancels — the row. Same `AGENT_RETIRED:` prefix,
-- so `isAgentRetiredDbRefusal` maps it to the usecase's own conflict.
CREATE OR REPLACE FUNCTION agent_retired_refuses_ownership_transfer()
RETURNS TRIGGER AS $$
DECLARE
    agent_status "AgentStatus";
BEGIN
    SELECT ra."status" INTO agent_status
      FROM "RegisteredAgent" ra
     WHERE ra."id" = NEW."agentId" AND ra."tenantId" = NEW."tenantId"
       FOR SHARE;
    IF agent_status = 'RETIRED' THEN
        RAISE EXCEPTION
            'AGENT_RETIRED: a retired agent''s ownership cannot be transferred.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_ownership_transfer_agent_not_retired ON "AgentOwnershipTransfer";
CREATE TRIGGER agent_ownership_transfer_agent_not_retired
    BEFORE INSERT ON "AgentOwnershipTransfer"
    FOR EACH ROW
    EXECUTE FUNCTION agent_retired_refuses_ownership_transfer();

-- Privileges and RLS. `app_user` may read, open and close a transfer, and may
-- NOT delete one: the app never does, a tenant purge runs privileged, and a
-- referential CASCADE runs as the table owner. Default privileges grant DELETE
-- to `app_user` (20260323180000), so it is revoked explicitly — the
-- 20260906120000 precedent.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "AgentOwnershipTransfer" TO app_user;
        REVOKE DELETE ON "AgentOwnershipTransfer" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "AgentOwnershipTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentOwnershipTransfer" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AgentOwnershipTransfer";
CREATE POLICY tenant_isolation ON "AgentOwnershipTransfer"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentOwnershipTransfer";
CREATE POLICY tenant_isolation_insert ON "AgentOwnershipTransfer"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "AgentOwnershipTransfer";
CREATE POLICY superuser_bypass ON "AgentOwnershipTransfer"
    USING (current_setting('role') != 'app_user');
