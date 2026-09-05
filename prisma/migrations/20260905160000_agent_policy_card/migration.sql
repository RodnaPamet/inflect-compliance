-- Epic Agentic 5 — the POLICY CARD.
--
-- A machine-readable, versioned runtime policy per registered agent, evaluated
-- at the MCP tool boundary BEFORE the tool runs. Two tenant-scoped tables under
-- the canonical policy triple + FORCE ROW LEVEL SECURITY:
--
--   • "AgentPolicyCard"        — the MUTABLE head (which version is in force,
--                                plus the rolling per-day action window).
--   • "AgentPolicyCardVersion" — APPEND-ONLY policy. Never updated.
--
-- The append-only property is enforced twice, on purpose. `app_user` is granted
-- no UPDATE privilege on the version table, and a trigger refuses an UPDATE from
-- ANY role including the owner. The grant is the everyday control; the trigger
-- covers the privileged paths (migrations, scripts, a superuser session) that
-- the grant does not, which is exactly the split the AuditLog immutability
-- trigger already makes.
--
-- DELETE is deliberately NOT blocked, unlike AuditLog. A version row is deleted
-- only by CASCADE from its card, its agent or its tenant — i.e. only when the
-- thing it describes is itself gone — and a trigger refusing that would make
-- deleting a tenant impossible. Immutability here means "the record of what was
-- allowed cannot be rewritten", not "it outlives its subject".

-- ─── Tables ─────────────────────────────────────────────────────────
CREATE TABLE "AgentPolicyCard" (
    "id"              TEXT NOT NULL,
    "tenantId"        TEXT NOT NULL,
    "agentId"         TEXT NOT NULL,
    "currentVersion"  INTEGER NOT NULL DEFAULT 1,
    "usageWindowDate" DATE,
    "actionsInWindow" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentPolicyCard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentPolicyCardVersion" (
    "id"                 TEXT NOT NULL,
    "tenantId"           TEXT NOT NULL,
    "cardId"             TEXT NOT NULL,
    "version"            INTEGER NOT NULL,
    "permittedTools"     TEXT[],
    "maxDataScope"       "AgentDataAccessScope" NOT NULL,
    "maxAutonomyLevel"   INTEGER NOT NULL,
    "maxActionsPerRun"   INTEGER NOT NULL,
    "maxActionsPerDay"   INTEGER NOT NULL,
    "escalationTriggers" TEXT[],
    "approvalRung"       TEXT NOT NULL,
    "seeded"             BOOLEAN NOT NULL DEFAULT false,
    "seededFromTier"     "AgentRiskTier",
    "createdByUserId"    TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentPolicyCardVersion_pkey" PRIMARY KEY ("id")
);

-- ─── Value constraints ──────────────────────────────────────────────
-- The ladders live in `src/lib/agentic/policy-card.ts` and the usecase validates
-- against them. These CHECKs are the backstop for the paths the usecase does not
-- own — a script, a migration, a hand-edited row — and they pin only the bounds
-- that cannot move without a schema change anyway.
--
-- `maxAutonomyLevel` allows -1 (DENY_CEILING, below rung 0 so no tool reaches
-- it) even though the create path refuses an unscored agent outright: the value
-- is what `defaultPolicyCardForRiskTier` produces for an unscored tier, and a
-- constraint that made the fail-closed value unstorable would push a future
-- caller toward storing a permissive one instead.
ALTER TABLE "AgentPolicyCardVersion"
    ADD CONSTRAINT "AgentPolicyCardVersion_autonomy_range"
    CHECK ("maxAutonomyLevel" >= -1 AND "maxAutonomyLevel" <= 6);

ALTER TABLE "AgentPolicyCardVersion"
    ADD CONSTRAINT "AgentPolicyCardVersion_budgets_nonnegative"
    CHECK ("maxActionsPerRun" >= 0 AND "maxActionsPerDay" >= 0);

ALTER TABLE "AgentPolicyCardVersion"
    ADD CONSTRAINT "AgentPolicyCardVersion_version_positive"
    CHECK ("version" >= 1);

ALTER TABLE "AgentPolicyCard"
    ADD CONSTRAINT "AgentPolicyCard_window_nonnegative"
    CHECK ("actionsInWindow" >= 0);

-- ─── Indexes ────────────────────────────────────────────────────────
-- Composite parent key, so versions can never point cross-tenant.
CREATE UNIQUE INDEX "AgentPolicyCard_id_tenantId_key" ON "AgentPolicyCard"("id", "tenantId");
-- One card per agent, declared twice. `[tenantId, agentId]` is the tenant-leading
-- lookup index; `[agentId, tenantId]` is the unique over the exact relation field
-- list Prisma requires before it will type the 1:1. Redundant at the database,
-- kept so neither half is deleted as obviously unnecessary on its own.
CREATE UNIQUE INDEX "AgentPolicyCard_tenantId_agentId_key" ON "AgentPolicyCard"("tenantId", "agentId");
CREATE UNIQUE INDEX "AgentPolicyCard_agentId_tenantId_key" ON "AgentPolicyCard"("agentId", "tenantId");

CREATE UNIQUE INDEX "AgentPolicyCardVersion_tenantId_cardId_version_key"
    ON "AgentPolicyCardVersion"("tenantId", "cardId", "version");
CREATE INDEX "AgentPolicyCardVersion_tenantId_cardId_idx"
    ON "AgentPolicyCardVersion"("tenantId", "cardId");

-- ─── Foreign keys ───────────────────────────────────────────────────
ALTER TABLE "AgentPolicyCard"
    ADD CONSTRAINT "AgentPolicyCard_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FK to the agent's (id, tenantId) parent key: a card can never name
-- another tenant's agent, and Postgres enforces it even though it runs FK checks
-- as the table owner and therefore bypasses row security.
ALTER TABLE "AgentPolicyCard"
    ADD CONSTRAINT "AgentPolicyCard_agentId_tenantId_fkey"
    FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentPolicyCardVersion"
    ADD CONSTRAINT "AgentPolicyCardVersion_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentPolicyCardVersion"
    ADD CONSTRAINT "AgentPolicyCardVersion_cardId_tenantId_fkey"
    FOREIGN KEY ("cardId", "tenantId") REFERENCES "AgentPolicyCard"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Append-only enforcement on "AgentPolicyCardVersion"
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION agent_policy_card_version_immutable_guard()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'IMMUTABLE_POLICY_CARD_VERSION: UPDATE on "AgentPolicyCardVersion" is '
        'forbidden. A policy-card version is pinned by the runs and proposals '
        'that executed under it; editing one rewrites what the rules WERE. '
        'Write a new version instead.'
        USING ERRCODE = 'restrict_violation';
    RETURN NULL; -- never reached
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_policy_card_version_immutable ON "AgentPolicyCardVersion";
CREATE TRIGGER agent_policy_card_version_immutable
    BEFORE UPDATE ON "AgentPolicyCardVersion"
    FOR EACH ROW
    EXECUTE FUNCTION agent_policy_card_version_immutable_guard();

-- ═══════════════════════════════════════════════════════════════════
-- Row-Level Security (Epic A.1)
-- ═══════════════════════════════════════════════════════════════════
-- `tenantId` is NOT NULL on both tables, so the split USING / WITH CHECK form is
-- correct and the single-policy exception UserSession needs does not apply.

-- 1) app_user grants. NOTE the asymmetry: no UPDATE on the version table. That
--    is the append-only property expressed as a privilege rather than only as a
--    trigger, so the ordinary application path cannot even attempt the write.
GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentPolicyCard" TO app_user;
GRANT SELECT, INSERT, DELETE ON "AgentPolicyCardVersion" TO app_user;

-- 2) Enable + FORCE RLS
ALTER TABLE "AgentPolicyCard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentPolicyCard" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AgentPolicyCardVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentPolicyCardVersion" FORCE ROW LEVEL SECURITY;

-- 3) tenant_isolation (USING) + tenant_isolation_insert (WITH CHECK)
DROP POLICY IF EXISTS tenant_isolation ON "AgentPolicyCard";
CREATE POLICY tenant_isolation ON "AgentPolicyCard"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentPolicyCard";
CREATE POLICY tenant_isolation_insert ON "AgentPolicyCard"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation ON "AgentPolicyCardVersion";
CREATE POLICY tenant_isolation ON "AgentPolicyCardVersion"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentPolicyCardVersion";
CREATE POLICY tenant_isolation_insert ON "AgentPolicyCardVersion"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- 4) superuser_bypass — non-app_user roles (postgres) keep full access
DROP POLICY IF EXISTS superuser_bypass ON "AgentPolicyCard";
CREATE POLICY superuser_bypass ON "AgentPolicyCard"
    USING (current_setting('role') != 'app_user');
DROP POLICY IF EXISTS superuser_bypass ON "AgentPolicyCardVersion";
CREATE POLICY superuser_bypass ON "AgentPolicyCardVersion"
    USING (current_setting('role') != 'app_user');
