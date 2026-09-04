-- ═══════════════════════════════════════════════════════════════════
-- Agentic — the REGISTRATION GATE.
--
-- Stage 1 created the register. This makes it load-bearing: a credential can
-- name the agent it speaks for, and a tenant can refuse MCP traffic from one
-- that names nothing.
--
-- ── Why the binding sits on the KEY ─────────────────────────────────────────
--
-- `TenantApiKey.agentId`, not `RegisteredAgent.apiKeyId`. Rotation is the
-- ordinary case: an agent needs a new credential issued while the old one is
-- still accepted, so the relation has to be many-keys-to-one-agent. A single
-- `apiKeyId` on the agent would make every rotation a window in which the agent
-- is, by the gate's own definition, unregistered — and the gate would refuse
-- exactly the traffic an operator was in the middle of migrating.
--
-- NULLABLE, and the null carries meaning rather than being an oversight: most
-- keys are ordinary integrations. A null is UNREGISTERED, and only the MCP
-- surface treats that as a refusal.
--
-- Composite FK to (id, tenantId) so a key can never name another tenant's
-- agent — the same shape stage 1 used for AgentProposal / WorkflowRun.
-- ON DELETE RESTRICT: an agent with live credentials cannot be deleted out from
-- under them.
--
-- ── Why the flag's DEFAULT and its BACKFILL disagree, on purpose ────────────
--
-- `TenantSecuritySettings.requireRegisteredAgent` defaults TRUE, and the
-- application reads an ABSENT settings row as TRUE too. So a tenant created
-- after this deploy is fail-closed whether or not anyone ever opens the
-- security-settings page — which is the only way "new tenants default ON" can
-- be true of a table whose rows are written lazily.
--
-- That same absence rule is what forces the second half of the backfill. An
-- existing tenant with no settings row would read as ENFORCING the moment this
-- deploys, and its running integrations would start getting 403s. So:
--
--   1. every EXISTING settings row is set to FALSE, and
--   2. every tenant WITHOUT a settings row gets one, also FALSE.
--
-- Step 2 is not tidiness. Without it the column default is doing the opposite
-- of what step 1 was written to achieve, for precisely the tenants nobody has
-- configured — i.e. the quiet ones, which is the worst population to break.
--
-- Ids are derived from the tenant id so a re-run is a no-op, matching the
-- convention the stage-1 backfill set.
-- ═══════════════════════════════════════════════════════════════════

-- ── Bind a credential to the agent principal it speaks for ─────────

ALTER TABLE "TenantApiKey" ADD COLUMN "agentId" TEXT;

CREATE INDEX "TenantApiKey_tenantId_agentId_idx" ON "TenantApiKey"("tenantId", "agentId");

ALTER TABLE "TenantApiKey"
    ADD CONSTRAINT "TenantApiKey_agentId_tenantId_fkey"
    FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── The per-tenant enforcement flag ────────────────────────────────

ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN "requireRegisteredAgent" BOOLEAN NOT NULL DEFAULT true;

-- Every tenant that already exists keeps today's behaviour. Turning the gate on
-- is a deliberate act by an operator who knows which of their agents are
-- registered, never a migration side effect.
UPDATE "TenantSecuritySettings" SET "requireRegisteredAgent" = false;

-- And the tenants with no settings row at all — for whom the absent-row default
-- would otherwise mean ENFORCING from the instant this lands.
INSERT INTO "TenantSecuritySettings" ("id", "tenantId", "requireRegisteredAgent", "createdAt", "updatedAt")
SELECT
    'tss_agentgate_' || t."id",
    t."id",
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Tenant" t
WHERE NOT EXISTS (
    SELECT 1 FROM "TenantSecuritySettings" s WHERE s."tenantId" = t."id"
);
