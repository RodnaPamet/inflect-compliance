-- #5848 — a tenant purge cannot complete while an AI decision row names an AI system.
--
-- The purge deletes `AiSystem` and retains `AiDecisionLog` (the EU AI Act Art 12
-- record). The FK between them is column-scoped, the shape a retained table's
-- FK to a purged one must have:
--
--   FOREIGN KEY ("aiSystemId", "tenantId") REFERENCES "AiSystem"("id", "tenantId")
--   ON UPDATE CASCADE ON DELETE SET NULL ("aiSystemId")      -- 20260913000000
--
-- but the append-only trigger lists `aiSystemId` among the columns no UPDATE
-- may change, so the FK's own SET NULL was refused ("AiDecisionLog is
-- append-only; only humanOutcome may transition") and the purge's per-tenant
-- transaction rolled back. Every registered agent's decision rows name an AI
-- system, so any tenant that ever ran an agent could not be purged.
--
-- The schema already chose to keep the record and drop the link; the trigger
-- now admits exactly that write and nothing else:
--
--   * `aiSystemId` goes from a value to NULL,
--   * every OTHER column — `humanOutcome` included — is unchanged, and
--   * the UPDATE is issued by a trigger (`pg_trigger_depth() > 1`), which is
--     what the FK's referential action is: Postgres runs ON DELETE SET NULL
--     from the RI trigger on "AiSystem", so the row trigger below fires one
--     level deep. A person's direct `UPDATE … SET "aiSystemId" = NULL` runs at
--     depth 1 and is still refused. No trigger in this schema issues DML
--     against "AiDecisionLog", so the FK action is the only nested writer.
--
-- Everything the trigger refused before is still refused, with the same
-- messages: a re-point (value to another value, including the FK's ON UPDATE
-- CASCADE), NULL to a value, a NULL that moves any other column, and the
-- one-way `humanOutcome` stamp. The column list is the one 20261114120000
-- installed (`agentId` and `agentProposalId` included), unchanged.
--
-- SAFE FOR A ROLLING DEPLOY: a plain CREATE OR REPLACE FUNCTION. The trigger
-- binding, the table and every enum are untouched, and no application code
-- issues the newly admitted write, so an older container behaves exactly as
-- before.
CREATE OR REPLACE FUNCTION ai_decision_log_immutable() RETURNS trigger AS $$
BEGIN
    -- The FK's own ON DELETE SET NULL ("aiSystemId") when the AI system is
    -- deleted (#5848): the link goes, the record stays exactly as written.
    IF pg_trigger_depth() > 1
       AND OLD."aiSystemId" IS NOT NULL
       AND NEW."aiSystemId" IS NULL
       AND ROW(NEW."id", NEW."tenantId", NEW."feature", NEW."provider",
               NEW."model", NEW."inputDigest", NEW."outputSummary", NEW."latencyMs",
               NEW."tokensIn", NEW."tokensOut", NEW."guardVerdict", NEW."humanOutcome",
               NEW."sessionRef", NEW."userId", NEW."agentId", NEW."agentProposalId",
               NEW."createdAt")
           IS NOT DISTINCT FROM
           ROW(OLD."id", OLD."tenantId", OLD."feature", OLD."provider",
               OLD."model", OLD."inputDigest", OLD."outputSummary", OLD."latencyMs",
               OLD."tokensIn", OLD."tokensOut", OLD."guardVerdict", OLD."humanOutcome",
               OLD."sessionRef", OLD."userId", OLD."agentId", OLD."agentProposalId",
               OLD."createdAt")
    THEN
        RETURN NEW;
    END IF;

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
