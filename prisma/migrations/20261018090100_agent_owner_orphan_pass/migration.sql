-- Agentic IAM 2b (#3670) — the owner-orphan pass, and the database half of the
-- rule that an OWNER_DEPARTED kill lifts only after a completed transfer.
--
-- Forward-only. Two columns on TenantSecuritySettings, one column on
-- AgentKillSwitch, one CHECK and one trigger. Nothing is renamed or dropped,
-- and every existing row is valid under the new constraint (reasonCode is NULL
-- on all of them), so a container from the previous release keeps reading and
-- writing both tables unchanged.

-- ─── The pass's mode, on the identity ladder's shape ─────────────────────────
--
-- The same enum type the leaver and joiner columns use, so the one translation
-- `coerceStoredMode` applies (a stored PROPOSE reads as DRY_RUN) applies here
-- too. A fast default: no table rewrite on Postgres 11+.
ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN IF NOT EXISTS "agentOrphanPassMode" "IdentityWriteMode" NOT NULL DEFAULT 'DISABLED',
    ADD COLUMN IF NOT EXISTS "agentOrphanPassDryRunSince" TIMESTAMP(3);

-- ─── A structured kill reason only the system can write ─────────────────────
ALTER TABLE "AgentKillSwitch" ADD COLUMN IF NOT EXISTS "reasonCode" TEXT;

-- The code is pinned to its writer. `OWNER_DEPARTED` is representable only on
-- an AGENT-scope row engaged by the owner-orphan pass's system actor, whose id
-- no `User` row can have. A person engaging a kill through the route writes
-- `engagedByUserId = <their user id>`, so no human-engaged kill can carry the
-- code — which matters because the code excludes a kill from the incident
-- count and blocks its lift until an ownership transfer completes. The literal
-- is `ORPHAN_PASS_ACTOR` in src/lib/agentic/owner-orphan.ts.
ALTER TABLE "AgentKillSwitch"
    ADD CONSTRAINT "AgentKillSwitch_reasonCode_shape"
    CHECK (
        "reasonCode" IS NULL
        OR (
            "reasonCode" = 'OWNER_DEPARTED'
            AND "engagedByUserId" = 'system:agent-owner-orphan-pass'
            AND "agentId" IS NOT NULL
        )
    );

-- ─── The lift rule, held below the usecase ──────────────────────────────────
--
-- Two refusals, both on UPDATE and only for a row that carries a code:
--
--   1. The code is IMMUTABLE. Nulling it would turn an OWNER_DEPARTED kill
--      into an ordinary one that anybody holding the kill key can lift.
--   2. An OWNER_DEPARTED kill moves from in force to lifted only when a
--      COMPLETED ownership transfer of that agent, to the person lifting it,
--      completed AFTER the kill was engaged. `liftKillSwitch` asks the same
--      question first and refuses with a sentence; this is the backstop for
--      any writer that does not go through it.
--
-- The `WHEN` clause keeps every ordinary kill — every human kill and every
-- drill canary — off the trigger entirely.
--
-- Invoker rights, under RLS: inside a tenant transaction the SELECT sees only
-- that tenant's transfers, which is the tenant the kill row belongs to.
CREATE OR REPLACE FUNCTION agent_kill_switch_reason_code_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode" THEN
        RAISE EXCEPTION
            'AGENT_KILL_REASON_CODE_IMMUTABLE: a kill''s reason code is written once, when it is engaged.';
    END IF;
    IF OLD."reasonCode" = 'OWNER_DEPARTED'
       AND OLD."liftedAt" IS NULL
       AND NEW."liftedAt" IS NOT NULL THEN
        IF NEW."liftedByUserId" IS NULL OR NOT EXISTS (
            SELECT 1
              FROM "AgentOwnershipTransfer" t
             WHERE t."tenantId" = OLD."tenantId"
               AND t."agentId" = OLD."agentId"
               AND t."status" = 'COMPLETED'
               AND t."completedAt" > OLD."engagedAt"
               AND t."toOwnerUserId" = NEW."liftedByUserId"
        ) THEN
            RAISE EXCEPTION
                'AGENT_OWNER_DEPARTED_LIFT_REFUSED: an OWNER_DEPARTED kill is lifted only by the new owner, after a two-step ownership transfer of the agent completed.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_kill_switch_reason_code_guard ON "AgentKillSwitch";
CREATE TRIGGER agent_kill_switch_reason_code_guard
    BEFORE UPDATE ON "AgentKillSwitch"
    FOR EACH ROW
    WHEN (OLD."reasonCode" IS NOT NULL OR NEW."reasonCode" IS NOT NULL)
    EXECUTE FUNCTION agent_kill_switch_reason_code_guard();
