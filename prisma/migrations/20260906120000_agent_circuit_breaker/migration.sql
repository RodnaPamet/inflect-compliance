-- The agent behavioural CIRCUIT BREAKER (OWASP ASI08 cascading failure,
-- ASI10 rogue agents).
--
-- The action caps already on a policy card answer "is this agent doing too
-- MUCH". They cannot answer "is this agent doing something DIFFERENT", which is
-- the rogue-agent question — an agent that has read framework status every night
-- for a month and starts calling propose tools has exceeded no budget and never
-- will. Two tables:
--
--   1. "AgentBehaviourWindow" — one hour of one agent's observed behaviour,
--      written at the MCP tool boundary on the call that was authorized.
--   2. "AgentCircuitBreaker"  — the latch, plus the baseline epoch a human
--      advances when they deliberately change what an agent does.
--
-- ROLLING-DEPLOY SAFETY. Both tables are created EMPTY and no already-running
-- container writes or reads them; an old container serving traffic through the
-- unchanged `authorizeToolCall` is unaffected. There is no `ALTER TYPE`
-- anywhere and no new Postgres enum: `state`, `verdict`, `closeReason` and the
-- signal arrays are TEXT with CHECK constraints, for the reason the
-- `@@map("WorkItem*")` pins record — an enum rename or value add mid-deploy
-- makes still-running old containers fail with SQLSTATE 42704, and this
-- vocabulary is one a follow-up is likely to widen.

-- ═══════════════════════════════════════════════════════════════════
-- 1) The observation ledger
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "AgentBehaviourWindow" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT NOT NULL,
    "agentId"          TEXT NOT NULL,
    "windowStart"      TIMESTAMP(3) NOT NULL,
    "readCalls"        INTEGER NOT NULL DEFAULT 0,
    "proposeCalls"     INTEGER NOT NULL DEFAULT 0,
    "orchestrateCalls" INTEGER NOT NULL DEFAULT 0,
    "toolNames"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "anomalous"        BOOLEAN NOT NULL DEFAULT false,
    -- NULL means NOT YET JUDGED. Distinct from 'STEADY' on purpose: "nothing was
    -- found" and "nothing was looked at" are different facts, and a column that
    -- stores them identically stores the second one as the first.
    "verdict"          TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentBehaviourWindow_pkey" PRIMARY KEY ("id")
);

-- Counters are counts. A negative one can only come from a hand-written UPDATE,
-- and it would move a median silently rather than failing anything.
ALTER TABLE "AgentBehaviourWindow"
    ADD CONSTRAINT "AgentBehaviourWindow_counts_nonnegative"
    CHECK ("readCalls" >= 0 AND "proposeCalls" >= 0 AND "orchestrateCalls" >= 0);

ALTER TABLE "AgentBehaviourWindow"
    ADD CONSTRAINT "AgentBehaviourWindow_verdict_known"
    CHECK ("verdict" IS NULL OR "verdict" IN ('NO_BASELINE', 'STEADY', 'ARMED', 'TRIP'));

-- One row per (tenant, agent, hour). Tenant-leading, so it doubles as the
-- tenant-scoped lookup index AND as the "agentId" foreign-key index: every query
-- this table serves is a prefix of it (tenant; tenant+agent; tenant+agent+hour
-- range). A separate single-column index on either would be a duplicate of this
-- one's leading columns with nothing to serve.
CREATE UNIQUE INDEX "AgentBehaviourWindow_tenantId_agentId_windowStart_key"
    ON "AgentBehaviourWindow"("tenantId", "agentId", "windowStart");

ALTER TABLE "AgentBehaviourWindow"
    ADD CONSTRAINT "AgentBehaviourWindow_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FK to the agent's (id, tenantId) parent key — a window can never
-- point at another tenant's agent. CASCADE: an agent's behavioural history is
-- about that agent, and it must not outlive it as an orphan somebody could
-- attribute to a re-registered one.
ALTER TABLE "AgentBehaviourWindow"
    ADD CONSTRAINT "AgentBehaviourWindow_agentId_tenantId_fkey"
    FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 2) The latch
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "AgentCircuitBreaker" (
    "id"                  TEXT NOT NULL,
    "tenantId"            TEXT NOT NULL,
    "agentId"             TEXT NOT NULL,
    "state"               TEXT NOT NULL DEFAULT 'CLOSED',
    "lastEvaluatedWindow" TEXT,
    "anomalousStreak"     INTEGER NOT NULL DEFAULT 0,
    "streakSignals"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "lastVerdict"         TEXT,
    "lastVerdictAt"       TIMESTAMP(3),
    "trippedAt"           TIMESTAMP(3),
    "trippedWindow"       TEXT,
    "trippedSignals"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "baselineEpoch"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt"            TIMESTAMP(3),
    "closedByUserId"      TEXT,
    "closeReason"         TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentCircuitBreaker_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AgentCircuitBreaker"
    ADD CONSTRAINT "AgentCircuitBreaker_state_known"
    CHECK ("state" IN ('CLOSED', 'OPEN'));

ALTER TABLE "AgentCircuitBreaker"
    ADD CONSTRAINT "AgentCircuitBreaker_close_reason_known"
    CHECK ("closeReason" IS NULL OR "closeReason" IN ('ACCEPTED_NEW_BASELINE', 'RESOLVED'));

-- The accountability invariant, at the database rather than only at the usecase.
-- A closed breaker MUST name the human who closed it and why: the whole value of
-- an un-trip being manual is that somebody's name is against it, and a write
-- path that forgot the actor would produce rows indistinguishable from a breaker
-- that had never tripped.
ALTER TABLE "AgentCircuitBreaker"
    ADD CONSTRAINT "AgentCircuitBreaker_close_accountability"
    CHECK (
        ("closedAt" IS NULL AND "closedByUserId" IS NULL AND "closeReason" IS NULL)
        OR ("closedAt" IS NOT NULL AND "closedByUserId" IS NOT NULL AND "closeReason" IS NOT NULL)
    );

-- An OPEN breaker must say when it tripped and on what. A latch with no basis is
-- a latch nobody can argue with, which is how a security control becomes
-- something operators route around rather than read.
ALTER TABLE "AgentCircuitBreaker"
    ADD CONSTRAINT "AgentCircuitBreaker_open_has_basis"
    CHECK (
        "state" <> 'OPEN'
        OR ("trippedAt" IS NOT NULL AND "trippedWindow" IS NOT NULL
            AND array_length("trippedSignals", 1) >= 1)
    );

ALTER TABLE "AgentCircuitBreaker"
    ADD CONSTRAINT "AgentCircuitBreaker_streak_nonnegative"
    CHECK ("anomalousStreak" >= 0);

CREATE UNIQUE INDEX "AgentCircuitBreaker_tenantId_agentId_key"
    ON "AgentCircuitBreaker"("tenantId", "agentId");
CREATE UNIQUE INDEX "AgentCircuitBreaker_agentId_tenantId_key"
    ON "AgentCircuitBreaker"("agentId", "tenantId");
CREATE INDEX "AgentCircuitBreaker_closedByUserId_idx"
    ON "AgentCircuitBreaker"("closedByUserId");

ALTER TABLE "AgentCircuitBreaker"
    ADD CONSTRAINT "AgentCircuitBreaker_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentCircuitBreaker"
    ADD CONSTRAINT "AgentCircuitBreaker_agentId_tenantId_fkey"
    FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE, and not SET NULL. The name against a close is the
-- evidence; deleting the user must not silently erase who un-trapped an agent,
-- and SET NULL would violate the accountability CHECK above rather than fail
-- loudly.
ALTER TABLE "AgentCircuitBreaker"
    ADD CONSTRAINT "AgentCircuitBreaker_closedByUserId_fkey"
    FOREIGN KEY ("closedByUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-Level Security (Epic A.1)
-- ═══════════════════════════════════════════════════════════════════
-- `tenantId` is NOT NULL on both tables, so the split USING / WITH CHECK form is
-- correct and the single-policy exception `UserSession` needs does not apply.

-- ─── AgentBehaviourWindow ───────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentBehaviourWindow" TO app_user;

ALTER TABLE "AgentBehaviourWindow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentBehaviourWindow" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AgentBehaviourWindow";
CREATE POLICY tenant_isolation ON "AgentBehaviourWindow"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentBehaviourWindow";
CREATE POLICY tenant_isolation_insert ON "AgentBehaviourWindow"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentBehaviourWindow";
CREATE POLICY superuser_bypass ON "AgentBehaviourWindow"
    USING (current_setting('role') != 'app_user');

-- ─── AgentCircuitBreaker ────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentCircuitBreaker" TO app_user;

ALTER TABLE "AgentCircuitBreaker" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentCircuitBreaker" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AgentCircuitBreaker";
CREATE POLICY tenant_isolation ON "AgentCircuitBreaker"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentCircuitBreaker";
CREATE POLICY tenant_isolation_insert ON "AgentCircuitBreaker"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentCircuitBreaker";
CREATE POLICY superuser_bypass ON "AgentCircuitBreaker"
    USING (current_setting('role') != 'app_user');
