-- #3700 — per-agent evidence that retiring an agent withdraws (step 2a-evidence).
--
-- Until now every `AgenticEvidenceArtefact` was a tenant-wide aggregate keyed
-- `(tenant, control, kind, period)`, and the retirement cascade could withdraw
-- none of them without retracting true evidence about every other agent. This
-- migration adds the artefact a retirement CAN withdraw:
--
--   1. `AgenticEvidenceArtefact.agentId` and two PER-AGENT kinds,
--      `AGENT_ACTION_RECEIPTS_PER_AGENT` and `AI_DECISION_RECORDS_PER_AGENT`,
--      paired by CHECK: a per-agent kind always names its agent and a
--      tenant-wide kind never does.
--   2. The identity widened to `(tenant, control, kind, period, agent)`,
--      NULLS NOT DISTINCT, so the tenant-wide rows (agent NULL) keep exactly the
--      uniqueness they had.
--   3. A new withdrawal reason, `AGENT_RETIRED`, admitted on a per-agent row
--      only: a tenant-wide artefact cannot be withdrawn for a retirement.
--   4. A trigger that refuses any CURRENT write of a per-agent artefact for a
--      RETIRED agent, taking FOR SHARE on the agent row — the same discipline
--      as the retirement migration's insert triggers, so an emitter tick racing
--      a retirement either commits first (and is withdrawn by the cascade) or
--      waits and is refused. Nothing resurrects a retired agent's evidence.
--   5. `AiDecisionLog.agentId`, stamped at insert from the writing request's
--      registered agent, and added to the append-only trigger so it can never be
--      re-attributed. Receipts need no column: `AgentActionReceipt.mcpKeyId`
--      already names the submitting credential, whose agent binding is the
--      attribution.
--
-- FORWARD-ONLY, ADDITIVE. Every column is nullable with no default (a
-- catalogue-only ADD, no table rewrite); every CHECK is DROP + ADD under its
-- existing NAME, in this one implicit transaction, so there is no instant at
-- which a column carries no CHECK. Every existing artefact row holds one of the
-- four older kinds, an older reason (or none) and a NULL agent, so each new
-- CHECK is a strict superset of what is stored and re-validates cleanly.
--
-- COORDINATION. The kind CHECK lists EVERY kind `AGENTIC_ARTEFACT_KINDS` holds:
-- 20261017235500 (#3687) re-created it with AGENT_HARNESS_SCANS and
-- 20261018001000 (#3672) with INTEGRATION_PASSPORTS, and a CHECK naming only the
-- kinds one branch knew would refuse rows already written. Likewise the reason
-- CHECK re-lists every reason since 20260906150000.
--
-- ROLLING-DEPLOY SAFETY. A container built before this migration:
--   • writes only the four older kinds with no `agentId`, which the pairing
--     CHECK admits and the new identity keeps unique (NULLS NOT DISTINCT), and a
--     lost insert race still surfaces to it as P2002;
--   • looks an artefact up by the four-column identity, which can only match
--     the tenant-wide row of a kind it knows — per-agent rows are other kinds;
--   • skips the per-agent kinds in its withdrawal sweep (`isKnownKind`), so it
--     neither withdraws nor rewrites them;
--   • never writes `AiDecisionLog.agentId`, so its rows land NULL (unattributed)
--     and its humanOutcome stamps leave the column unchanged, which the widened
--     trigger accepts.
-- A container built after it that runs BEFORE it is applied fails its first
-- `AiDecisionLog` insert on the missing column; apply the migration first, as
-- every deploy does.
--
-- ROLLBACK. Redeploy the prior image; the migration stays. Narrowing any CHECK
-- would fail once a per-agent row or an AGENT_RETIRED withdrawal exists, and
-- the artefacts are evidence that is withdrawn, never deleted — so this is
-- forward-fix only.

-- ═══════════════════════════════════════════════════════════════════
-- 1. The agent column and the per-agent kinds
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE "AgenticEvidenceArtefact" ADD COLUMN "agentId" TEXT;

ALTER TABLE "AgenticEvidenceArtefact" DROP CONSTRAINT IF EXISTS "AgenticEvidenceArtefact_kind_known";
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_kind_known"
    CHECK ("kind" IN (
        'AGENT_ACTION_RECEIPTS',
        'AI_DECISION_RECORDS',
        'AGENT_HARNESS_SCANS',
        'INTEGRATION_PASSPORTS',
        'AGENT_ACTION_RECEIPTS_PER_AGENT',
        'AI_DECISION_RECORDS_PER_AGENT'
    ));

-- A per-agent kind names its agent; a tenant-wide kind never does. This is what
-- makes "retirement leaves the tenant-wide artefacts alone" a property of the
-- data rather than of a WHERE clause: the cascade withdraws by `agentId`, and no
-- tenant-wide row can carry one.
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_agent_scope"
    CHECK (
        ("agentId" IS NOT NULL)
        = ("kind" IN ('AGENT_ACTION_RECEIPTS_PER_AGENT', 'AI_DECISION_RECORDS_PER_AGENT'))
    );

CREATE INDEX "AgenticEvidenceArtefact_tenantId_agentId_idx"
    ON "AgenticEvidenceArtefact"("tenantId", "agentId");

-- Composite, so a per-agent artefact can never name another tenant's agent.
-- CASCADE, matching the table's other two parents: no usecase hard-deletes a
-- register row, so only a tenant purge reaches it, and the purge deletes the
-- `Evidence` these rows are in any case.
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_agentId_tenantId_fkey"
    FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 2. The identity, widened to the agent
-- ═══════════════════════════════════════════════════════════════════
-- NULLS NOT DISTINCT (PostgreSQL 15+; production runs postgres:16-alpine). With
-- the default semantics two NULL agent ids are distinct, so the index would let
-- a second tenant-wide row into the same (tenant, control, kind, period) — the
-- duplication by construction the identity exists to prevent. A partial-index
-- pair would say the same thing in two objects Prisma cannot see either.
-- Dropped and created in this one transaction: there is no instant without it.
DROP INDEX IF EXISTS "AgenticEvidenceArtefact_tenantId_controlId_kind_periodStart_key";
CREATE UNIQUE INDEX "AgenticEvidenceArtefact_identity_key"
    ON "AgenticEvidenceArtefact"("tenantId", "controlId", "kind", "periodStart", "agentId")
    NULLS NOT DISTINCT;

-- ═══════════════════════════════════════════════════════════════════
-- 3. AGENT_RETIRED — a per-agent row only
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE "AgenticEvidenceArtefact" DROP CONSTRAINT IF EXISTS "AgenticEvidenceArtefact_withdrawn_reason_known";
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_withdrawn_reason_known"
    CHECK ("withdrawnReason" IS NULL
           OR "withdrawnReason" IN (
                'CONTROL_REMOVED',
                'SOURCE_UNVERIFIABLE',
                'OBLIGATION_UNMAPPED',
                -- The agent the artefact is about was retired while its period
                -- was open (#3700). Closed periods keep their evidence.
                'AGENT_RETIRED'
           ));

-- A tenant-wide artefact describes every agent; retiring one of them makes none
-- of it untrue, so it can never be withdrawn for that reason.
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_agent_retired_is_per_agent"
    CHECK ("withdrawnReason" IS DISTINCT FROM 'AGENT_RETIRED' OR "agentId" IS NOT NULL);

-- ═══════════════════════════════════════════════════════════════════
-- 4. Nothing is written CURRENT for a retired agent
-- ═══════════════════════════════════════════════════════════════════
-- The emitter plans in one transaction and writes each artefact in its own, so
-- a retirement can commit between the two. Without this, the write that
-- follows would CREATE a current artefact the cascade never saw, or rewrite the
-- one it had just withdrawn back to CURRENT. FOR SHARE on the agent row
-- conflicts with retirement's status UPDATE: either this write took the row
-- first — retirement then waits for its commit and its cascade withdraws what
-- it wrote — or retirement did, and this write waits, reads RETIRED, and is
-- refused. The usecase takes the same lock itself before writing, so this is the
-- backstop for a writer that forgets. Withdrawing (status WITHDRAWN) is never
-- refused. The `AGENT_RETIRED:` prefix and the DEFAULT SQLSTATE match every
-- other retirement trigger (`isAgentRetiredDbRefusal`).
CREATE OR REPLACE FUNCTION agentic_evidence_artefact_refuses_retired_agent()
RETURNS TRIGGER AS $$
DECLARE
    agent_status "AgentStatus";
BEGIN
    IF NEW."agentId" IS NULL OR NEW."status" <> 'CURRENT' THEN
        RETURN NEW;
    END IF;
    SELECT ra."status" INTO agent_status
      FROM "RegisteredAgent" ra
     WHERE ra."id" = NEW."agentId" AND ra."tenantId" = NEW."tenantId"
       FOR SHARE;
    IF agent_status = 'RETIRED' THEN
        RAISE EXCEPTION
            'AGENT_RETIRED: a retired agent''s evidence artefact cannot be written as CURRENT (%).',
            TG_TABLE_NAME;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agentic_evidence_artefact_refuses_retired_agent_trg ON "AgenticEvidenceArtefact";
CREATE TRIGGER agentic_evidence_artefact_refuses_retired_agent_trg
    BEFORE INSERT OR UPDATE ON "AgenticEvidenceArtefact"
    FOR EACH ROW EXECUTE FUNCTION agentic_evidence_artefact_refuses_retired_agent();

-- ═══════════════════════════════════════════════════════════════════
-- 5. AiDecisionLog.agentId — stamped once, never re-attributed
-- ═══════════════════════════════════════════════════════════════════
-- No foreign key, like `userId` and `sessionRef`: the decision log survives a
-- tenant purge and is never DML'd by it, so an FK to the purgeable register
-- would either block the purge or require rewriting a row the trigger below
-- keeps immutable. NULL is "unattributed" — every row written before this
-- migration, and every row a person, an unbound key or a job writes.
ALTER TABLE "AiDecisionLog" ADD COLUMN "agentId" TEXT;

-- The append-only trigger, re-created column for column with `agentId` added to
-- the set no UPDATE may change. Same name, same messages, same humanOutcome
-- one-way stamp. An older container's humanOutcome stamp leaves `agentId` as it
-- is, so it is accepted unchanged.
CREATE OR REPLACE FUNCTION ai_decision_log_immutable() RETURNS trigger AS $$
BEGIN
    -- Every column EXCEPT humanOutcome must be unchanged.
    IF ROW(NEW."id", NEW."tenantId", NEW."feature", NEW."aiSystemId", NEW."provider",
           NEW."model", NEW."inputDigest", NEW."outputSummary", NEW."latencyMs",
           NEW."tokensIn", NEW."tokensOut", NEW."guardVerdict", NEW."sessionRef",
           NEW."userId", NEW."agentId", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."feature", OLD."aiSystemId", OLD."provider",
           OLD."model", OLD."inputDigest", OLD."outputSummary", OLD."latencyMs",
           OLD."tokensIn", OLD."tokensOut", OLD."guardVerdict", OLD."sessionRef",
           OLD."userId", OLD."agentId", OLD."createdAt")
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
