-- #5191 — the Art 14 stamp on the proposal path lands on ONE proposal's row.
--
-- `recordDecisionOutcomeForDigest` stamped
--   WHERE "tenantId" = ? AND "inputDigest" = ? AND "humanOutcome" = 'PENDING'
-- and the digest is `computeProposalDigest({ kind, payload, rationale })`, a
-- pure function of a proposal's CONTENT. Nothing de-duplicates proposals, so
-- two PENDING proposals with identical content share it: approving the first
-- stamped BOTH decision rows ACCEPTED, and rejecting the second afterwards
-- matched nothing (the miss was swallowed). The EU AI Act Art 12 register then
-- recorded ACCEPTED for a decision a human REJECTED, or that nobody reviewed.
--
-- The digest is a content fingerprint, not an identity, and no existing column
-- names the proposal a row records: `sessionRef` is the proposal's optional
-- `proposedBySessionRef`, shared by every proposal one session raised. So the
-- row now carries the proposal's id, written by `createAgentProposal` at
-- insert, and the stamp keys on it.
--
-- SAFE TO ADD: a nullable column with no default is a catalogue-only change —
-- no rewrite, no backfill. NULL is the truthful value for every existing row:
-- the link was never recorded, and a backfill could only re-derive it from the
-- digest, which is the ambiguous join this migration exists to stop trusting.
-- Legacy proposal rows are stamped by the usecase's fallback instead, and only
-- when exactly ONE pending row carries the digest.
--
-- No foreign key, like `agentId` / `userId` / `sessionRef`: this table is
-- retained through a tenant purge and never DML'd by it, so an FK to the
-- purgeable `AgentProposal` would block the purge or rewrite a row the trigger
-- below keeps immutable.
ALTER TABLE "AiDecisionLog" ADD COLUMN "agentProposalId" TEXT;

-- One decision row per proposal, and the stamp's lookup. NULLs are distinct,
-- so every non-proposal row and every legacy proposal row is unaffected.
CREATE UNIQUE INDEX "AiDecisionLog_tenantId_agentProposalId_key"
    ON "AiDecisionLog"("tenantId", "agentProposalId");

-- The append-only trigger, re-created column for column with `agentProposalId`
-- added to the set no UPDATE may change: set at INSERT, frozen after, so a
-- decision row can never be moved onto another proposal. Same name, same
-- messages, and `humanOutcome` stays the only column that may move, once, out
-- of PENDING. An older container's stamp leaves `agentProposalId` as it is, so
-- it is accepted unchanged during a rolling deploy.
CREATE OR REPLACE FUNCTION ai_decision_log_immutable() RETURNS trigger AS $$
BEGIN
    -- Every column EXCEPT humanOutcome must be unchanged.
    IF ROW(NEW."id", NEW."tenantId", NEW."feature", NEW."aiSystemId", NEW."provider",
           NEW."model", NEW."inputDigest", NEW."outputSummary", NEW."latencyMs",
           NEW."tokensIn", NEW."tokensOut", NEW."guardVerdict", NEW."sessionRef",
           NEW."userId", NEW."agentId", NEW."agentProposalId", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."feature", OLD."aiSystemId", OLD."provider",
           OLD."model", OLD."inputDigest", OLD."outputSummary", OLD."latencyMs",
           OLD."tokensIn", OLD."tokensOut", OLD."guardVerdict", OLD."sessionRef",
           OLD."userId", OLD."agentId", OLD."agentProposalId", OLD."createdAt")
    THEN
        RAISE EXCEPTION 'AiDecisionLog is append-only; only humanOutcome may transition';
    END IF;

    -- humanOutcome is a one-way stamp: it may leave PENDING exactly once.
    IF NEW."humanOutcome" IS DISTINCT FROM OLD."humanOutcome"
       AND OLD."humanOutcome" <> 'PENDING' THEN
        RAISE EXCEPTION 'AiDecisionLog.humanOutcome already recorded (append-only)';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
