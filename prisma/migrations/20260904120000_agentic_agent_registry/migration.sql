-- ═══════════════════════════════════════════════════════════════════
-- Agentic — the AGENT REGISTER.
--
-- One row per autonomous agent a tenant runs, carrying the four properties
-- that decide how much authority it may hold: how autonomous it is
-- (`autonomyLevel`), how far into tenant data it reaches (`dataAccessScope`),
-- how hard its actions are to undo (`reversibility`), and whose code it is
-- (`provenance`). A later pass scores those into `riskTier`.
--
-- ── Why a SIBLING of AiSystem, not a discriminator on it ────────────────────
--
-- `AiSystem` is the EU AI Act register (Regulation (EU) 2024/1689): every one
-- of its columns is Act vocabulary — its `riskTier` is the Act's tier, its
-- `classificationClauseId` is the clause that produced that tier, its
-- `deploymentRole` is provider-vs-deployer. An agent's governing questions are
-- not Act questions and do not fit those columns. What settled it:
--
--   • `ownerUserId`. On a shared table it could only ever be a partial CHECK
--     (required for agent rows, optional for every other row), so Prisma would
--     type it `string | null` forever — and the downstream "the second approver
--     must not be the agent's registered owner" check would then have to read
--     `owner && owner === ctx.userId`, which PASSES when the owner is unknown.
--     That fail-open shape already ships in three places in this repo. Here the
--     column is NOT NULL with a real FK and the null is unrepresentable.
--   • House precedent: discriminators live on OPERATIONAL tables
--     (`Asset.type`, `Task.type`); principals get their own table
--     (`AuditorAccount`, `TenantDeviceToken`). An agent is a principal with a
--     kill switch, and a kill switch on a row in a regulatory register is a
--     category error.
--   • `POST /api/t/:slug/ai-systems` carries no `requirePermission` (only
--     `assertCanWrite`), so extending that table would have made a surface any
--     write-capable member can insert into the authorization subject for tool
--     exposure.
--
-- The link to `AiSystem` is nevertheless REQUIRED (NOT NULL + UNIQUE), because
-- every agent IS an AI system in the Act's sense: that keeps the conformity
-- path's `riskTier = 'HIGH'` branch reachable for agents and gives per-agent
-- framework coverage somewhere to hang (`AiSystemRequirementLink`).
-- `ON DELETE RESTRICT`, so deleting an AI system cannot silently delete the
-- agent that governs it — the delete is refused and the operator has to retire
-- the agent explicitly.
--
-- ── CHECK constraints, i.e. the refusals written in DDL ─────────────────────
--
--   • `autonomyLevel BETWEEN 0 AND 6` — the ladder is a spectrum and this
--     column is an Int, never a boolean. The scorer does arithmetic on it.
--   • `provenance <> 'THIRD_PARTY' OR vendorId IS NOT NULL` — third-party risk
--     you cannot attribute to a named supplier is not third-party risk, it is
--     an unattributed binary. Enforced here and not only at the usecase.
--   • `(riskTier IS NULL) = (riskTierScoredAt IS NULL)` — a tier can never be
--     read without knowing how stale it is. NULL means UNSCORED, and every
--     consumer must read UNSCORED as "deny", never as "low".
--
-- ── Class-A direct-scoped RLS ───────────────────────────────────────────────
--   tenant_isolation        (USING)
--   tenant_isolation_insert (FOR INSERT WITH CHECK)
--   superuser_bypass        (USING role != 'app_user')
-- plus FORCE ROW LEVEL SECURITY. Mirrors 20260703120000_ai_system_registry.
--
-- ── The backfill, and why it adopts nothing today ───────────────────────────
--
-- `AgentProposal.agentId` and `WorkflowRun.agentId` are added NULLABLE, because
-- the ALTER and the backfill run in the same transaction: there is a moment
-- where existing rows have no value, and a NOT NULL column with no sensible
-- default cannot be added to a populated table without inventing one. The
-- usecase layer requires the column on new writes; a NULL therefore means
-- "written before the register existed" and nothing else.
--
-- MEASURED: both tables are EMPTY in production, so this backfill adopts zero
-- rows today. It is written correctly anyway — a staging or self-hosted
-- deployment may not be empty, and a backfill that is only correct on the
-- database you happened to look at is not a backfill.
--
-- The synthetic row lands `status = 'SUSPENDED'` and `isLegacyPlaceholder =
-- true`, with `riskTier` NULL (unscored → deny) and the WORST value on every
-- exposure axis (`autonomyLevel = 6`, `EXTERNAL_EGRESS`, `TERMINAL`): an
-- unregistered agent's real properties are unknown, and the fail-closed reading
-- of unknown is "the most dangerous thing it could have been". `provenance` is
-- the one axis that cannot take its worst value — `THIRD_PARTY` needs a vendor
-- and there is no supplier to name — so it lands `FIRST_PARTY`, which is the
-- CHECK constraint above deciding, not a claim about the code's origin.
--
-- It also needs an `ownerUserId`, and the register refuses to invent one: the
-- tenant's OLDEST ACTIVE OWNER is used, and a tenant with no ACTIVE OWNER is
-- SKIPPED rather than failing the deploy. Those rows keep `agentId` NULL and
-- stay visible as unattributed — a deploy that dies on a tenant with a broken
-- membership graph is a worse outcome than a handful of unadopted rows.
--
-- Ids are derived deterministically from the tenant id, so a re-run produces
-- the same rows and the `NOT EXISTS` guards make it a no-op.
-- ═══════════════════════════════════════════════════════════════════

-- ── Enums ──────────────────────────────────────────────────────────

-- APPEND-ONLY, and the order is load-bearing: the scorer reads the ordinal.
CREATE TYPE "AgentDataAccessScope" AS ENUM ('NONE', 'READ_METADATA', 'READ_TENANT_DATA', 'WRITE_TENANT_DATA', 'EXTERNAL_EGRESS');
CREATE TYPE "AgentReversibility" AS ENUM ('REVERSIBLE', 'COMPENSABLE', 'TERMINAL');
CREATE TYPE "AgentProvenance" AS ENUM ('FIRST_PARTY', 'THIRD_PARTY');
CREATE TYPE "AgentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED');
-- A DIFFERENT taxonomy from "AiRiskTier": operational authority, not EU AI Act
-- classification. The two are independent axes and must never be read for one
-- another.
CREATE TYPE "AgentRiskTier" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'CRITICAL');

-- ── RegisteredAgent ────────────────────────────────────────────────

CREATE TABLE "RegisteredAgent" (
    "id"                  TEXT NOT NULL,
    "tenantId"            TEXT NOT NULL,
    "aiSystemId"          TEXT NOT NULL,
    "name"                TEXT NOT NULL,
    "description"         TEXT,
    "autonomyLevel"       INTEGER NOT NULL,
    "dataAccessScope"     "AgentDataAccessScope" NOT NULL,
    "reversibility"       "AgentReversibility" NOT NULL,
    "provenance"          "AgentProvenance" NOT NULL,
    "status"              "AgentStatus" NOT NULL DEFAULT 'DRAFT',
    "riskTier"            "AgentRiskTier",
    "riskTierScoredAt"    TIMESTAMP(3),
    "ownerUserId"         TEXT NOT NULL,
    "vendorId"            TEXT,
    "isLegacyPlaceholder" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId"     TEXT,
    "deletedAt"           TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegisteredAgent_pkey" PRIMARY KEY ("id")
);

-- The composite parent key, so child tables that attribute work to an agent can
-- never point cross-tenant. Mirrors AiSystem's own shape.
CREATE UNIQUE INDEX "RegisteredAgent_id_tenantId_key" ON "RegisteredAgent"("id", "tenantId");
-- One agent per AI-system register entry (the 1:1 half of the required link).
CREATE UNIQUE INDEX "RegisteredAgent_aiSystemId_key" ON "RegisteredAgent"("aiSystemId");
-- Implied by the line above; declared because Prisma requires a unique over the
-- exact relation field list before it will type the composite relation as 1:1.
CREATE UNIQUE INDEX "RegisteredAgent_aiSystemId_tenantId_key" ON "RegisteredAgent"("aiSystemId", "tenantId");
CREATE INDEX "RegisteredAgent_tenantId_status_idx" ON "RegisteredAgent"("tenantId", "status");
CREATE INDEX "RegisteredAgent_tenantId_riskTier_idx" ON "RegisteredAgent"("tenantId", "riskTier");
CREATE INDEX "RegisteredAgent_tenantId_deletedAt_idx" ON "RegisteredAgent"("tenantId", "deletedAt");
CREATE INDEX "RegisteredAgent_tenantId_createdAt_idx" ON "RegisteredAgent"("tenantId", "createdAt");
CREATE INDEX "RegisteredAgent_tenantId_ownerUserId_idx" ON "RegisteredAgent"("tenantId", "ownerUserId");
CREATE INDEX "RegisteredAgent_tenantId_vendorId_idx" ON "RegisteredAgent"("tenantId", "vendorId");

ALTER TABLE "RegisteredAgent"
    ADD CONSTRAINT "RegisteredAgent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FK to AiSystem(id, tenantId): an agent can never point at another
-- tenant's system. RESTRICT, not CASCADE — deleting the AI system must not
-- silently delete the agent governing it.
ALTER TABLE "RegisteredAgent"
    ADD CONSTRAINT "RegisteredAgent_aiSystemId_tenantId_fkey"
    FOREIGN KEY ("aiSystemId", "tenantId") REFERENCES "AiSystem"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RegisteredAgent"
    ADD CONSTRAINT "RegisteredAgent_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RegisteredAgent"
    ADD CONSTRAINT "RegisteredAgent_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── CHECK constraints — the refusals, in DDL ───────────────────────

-- The autonomy ladder is 0-6. An Int, never a boolean.
ALTER TABLE "RegisteredAgent"
    ADD CONSTRAINT "RegisteredAgent_autonomyLevel_range_check"
    CHECK ("autonomyLevel" BETWEEN 0 AND 6);

-- A third-party agent must name its supplier.
ALTER TABLE "RegisteredAgent"
    ADD CONSTRAINT "RegisteredAgent_thirdParty_requires_vendor_check"
    CHECK ("provenance" <> 'THIRD_PARTY' OR "vendorId" IS NOT NULL);

-- A tier and the time it was scored move together. NULL on both means UNSCORED.
ALTER TABLE "RegisteredAgent"
    ADD CONSTRAINT "RegisteredAgent_riskTier_scoredAt_paired_check"
    CHECK (("riskTier" IS NULL) = ("riskTierScoredAt" IS NULL));

-- ── Row Level Security — RegisteredAgent ───────────────────────────

ALTER TABLE "RegisteredAgent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RegisteredAgent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "RegisteredAgent";
CREATE POLICY tenant_isolation ON "RegisteredAgent"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "RegisteredAgent";
CREATE POLICY tenant_isolation_insert ON "RegisteredAgent"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "RegisteredAgent";
CREATE POLICY superuser_bypass ON "RegisteredAgent"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "RegisteredAgent" TO app_user;

-- ── Attribute existing agentic work to an agent ────────────────────

ALTER TABLE "AgentProposal" ADD COLUMN "agentId" TEXT;
ALTER TABLE "WorkflowRun"   ADD COLUMN "agentId" TEXT;

CREATE INDEX "AgentProposal_tenantId_agentId_idx" ON "AgentProposal"("tenantId", "agentId");
CREATE INDEX "WorkflowRun_tenantId_agentId_idx"   ON "WorkflowRun"("tenantId", "agentId");

ALTER TABLE "AgentProposal"
    ADD CONSTRAINT "AgentProposal_agentId_tenantId_fkey"
    FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkflowRun"
    ADD CONSTRAINT "WorkflowRun_agentId_tenantId_fkey"
    FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Backfill ───────────────────────────────────────────────────────
--
-- Step 1: the synthetic AiSystem the placeholder agent must link to. The link
-- is NOT NULL, so adopting legacy rows means creating a register entry for
-- them too — that is the required link doing its job, not an accident of it.
-- Free-text columns (`purpose`, `useContext`) are left NULL on purpose: they
-- are encrypted by the Prisma extension on write, which raw SQL bypasses, and a
-- plaintext value in a ciphertext column is worse than no value.
INSERT INTO "AiSystem" (
    "id", "tenantId", "name", "purpose", "useContext", "provider",
    "deploymentRole", "riskTier", "classificationClauseId", "classificationRationale",
    "ownerUserId", "status", "createdByUserId", "createdAt", "updatedAt"
)
SELECT
    'aisys_legacyagent_' || t."id",
    t."id",
    'Unregistered legacy agent activity',
    NULL, NULL, NULL,
    'DEPLOYER', 'MINIMAL', NULL, NULL,
    owner."userId",
    'ACTIVE',
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN LATERAL (
    SELECT m."userId"
    FROM "TenantMembership" m
    WHERE m."tenantId" = t."id"
      AND m."role" = 'OWNER'
      AND m."status" = 'ACTIVE'
    ORDER BY m."createdAt" ASC, m."id" ASC
    LIMIT 1
) owner
WHERE (
        EXISTS (SELECT 1 FROM "AgentProposal" p WHERE p."tenantId" = t."id")
     OR EXISTS (SELECT 1 FROM "WorkflowRun"   r WHERE r."tenantId" = t."id")
      )
  AND NOT EXISTS (
        SELECT 1 FROM "AiSystem" s WHERE s."id" = 'aisys_legacyagent_' || t."id"
      );

-- Step 2: the placeholder agent itself. SUSPENDED, unscored, and worst-case on
-- every exposure axis the CHECK constraints allow — see the header.
INSERT INTO "RegisteredAgent" (
    "id", "tenantId", "aiSystemId", "name", "description",
    "autonomyLevel", "dataAccessScope", "reversibility", "provenance",
    "status", "riskTier", "riskTierScoredAt",
    "ownerUserId", "vendorId", "isLegacyPlaceholder", "createdByUserId",
    "createdAt", "updatedAt"
)
SELECT
    'agent_legacy_' || s."tenantId",
    s."tenantId",
    s."id",
    'Unregistered legacy agent',
    NULL,
    6, 'EXTERNAL_EGRESS', 'TERMINAL', 'FIRST_PARTY',
    'SUSPENDED', NULL, NULL,
    s."ownerUserId",
    NULL, true, NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "AiSystem" s
WHERE s."id" = 'aisys_legacyagent_' || s."tenantId"
  AND s."ownerUserId" IS NOT NULL
  AND NOT EXISTS (
        SELECT 1 FROM "RegisteredAgent" a WHERE a."id" = 'agent_legacy_' || s."tenantId"
      );

-- Step 3: point the pre-register rows at it. A tenant that was SKIPPED above
-- (no ACTIVE OWNER) has no placeholder, so its rows keep agentId NULL and stay
-- visible as unattributed rather than being adopted by someone else's agent.
UPDATE "AgentProposal" p
SET "agentId" = a."id"
FROM "RegisteredAgent" a
WHERE a."id" = 'agent_legacy_' || p."tenantId"
  AND p."agentId" IS NULL;

UPDATE "WorkflowRun" r
SET "agentId" = a."id"
FROM "RegisteredAgent" a
WHERE a."id" = 'agent_legacy_' || r."tenantId"
  AND r."agentId" IS NULL;
