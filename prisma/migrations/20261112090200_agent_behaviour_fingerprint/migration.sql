-- Agent behaviour fingerprint (Morpheus roadmap Phase 1, D-L1-3): the CPU
-- detector's two tenant-scoped tables.
--
--   AgentBehaviourBaseline — one row per agent per ACTIVE UTC day: the day's
--                            counts and the verdict the nightly job reached.
--                            The rolling baseline IS these rows.
--   AgentBehaviourAnomaly  — one row per anomalous agent-day: the driving
--                            features (names and numbers) and what it did.
--
-- Additive only: two new tables, no change to an existing one. Counts and
-- identifiers only; no column here can hold content.

CREATE TABLE "AgentBehaviourBaseline" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT NOT NULL,
    "agentId"          TEXT NOT NULL,
    "day"              DATE NOT NULL,
    "readCalls"        INTEGER NOT NULL DEFAULT 0,
    "proposeCalls"     INTEGER NOT NULL DEFAULT 0,
    "orchestrateCalls" INTEGER NOT NULL DEFAULT 0,
    "activeHours"      INTEGER NOT NULL DEFAULT 0,
    "proposals"        INTEGER NOT NULL DEFAULT 0,
    "guardFlags"       INTEGER NOT NULL DEFAULT 0,
    "modelCalls"       INTEGER NOT NULL DEFAULT 0,
    "tokens"           INTEGER NOT NULL DEFAULT 0,
    "verdict"          TEXT NOT NULL,
    "score"            DOUBLE PRECISION,
    "baselineDays"     INTEGER NOT NULL DEFAULT 0,
    "inBaseline"       BOOLEAN NOT NULL DEFAULT true,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentBehaviourBaseline_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AgentBehaviourBaseline"
    ADD CONSTRAINT "AgentBehaviourBaseline_counts_nonnegative"
    CHECK ("readCalls" >= 0 AND "proposeCalls" >= 0 AND "orchestrateCalls" >= 0
       AND "activeHours" >= 0 AND "activeHours" <= 24 AND "proposals" >= 0
       AND "guardFlags" >= 0 AND "modelCalls" >= 0 AND "tokens" >= 0
       AND "baselineDays" >= 0);

ALTER TABLE "AgentBehaviourBaseline"
    ADD CONSTRAINT "AgentBehaviourBaseline_verdict_known"
    CHECK ("verdict" IN ('LEARNING', 'STEADY', 'ANOMALOUS'));

-- LEARNING judged nothing, so it has no score; a judged day always has one.
-- An anomalous day never enters a later baseline: the detector must not learn
-- from the anomaly.
ALTER TABLE "AgentBehaviourBaseline"
    ADD CONSTRAINT "AgentBehaviourBaseline_verdict_shape"
    CHECK (
        ("verdict" = 'LEARNING' AND "score" IS NULL AND "inBaseline")
        OR ("verdict" = 'STEADY' AND "score" IS NOT NULL AND "inBaseline")
        OR ("verdict" = 'ANOMALOUS' AND "score" IS NOT NULL AND NOT "inBaseline")
    );

CREATE UNIQUE INDEX "AgentBehaviourBaseline_tenantId_agentId_day_key"
    ON "AgentBehaviourBaseline"("tenantId", "agentId", "day");
CREATE INDEX "AgentBehaviourBaseline_tenantId_day_idx"
    ON "AgentBehaviourBaseline"("tenantId", "day");

ALTER TABLE "AgentBehaviourBaseline"
    ADD CONSTRAINT "AgentBehaviourBaseline_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentBehaviourBaseline"
    ADD CONSTRAINT "AgentBehaviourBaseline_agentId_tenantId_fkey"
    FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentBehaviourAnomaly" (
    "id"          TEXT NOT NULL,
    "tenantId"    TEXT NOT NULL,
    "agentId"     TEXT NOT NULL,
    "day"         DATE NOT NULL,
    "score"       DOUBLE PRECISION NOT NULL,
    "tier"        TEXT NOT NULL,
    "driversJson" JSONB NOT NULL,
    "findingId"   TEXT,
    "latchedAt"   TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentBehaviourAnomaly_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AgentBehaviourAnomaly"
    ADD CONSTRAINT "AgentBehaviourAnomaly_tier_known"
    CHECK ("tier" IN ('FINDING', 'LATCH'));

-- Only a threshold-B day can have latched the breaker.
ALTER TABLE "AgentBehaviourAnomaly"
    ADD CONSTRAINT "AgentBehaviourAnomaly_latch_needs_tier"
    CHECK ("latchedAt" IS NULL OR "tier" = 'LATCH');

-- The "why" is a list of feature readings, never an object or a string.
ALTER TABLE "AgentBehaviourAnomaly"
    ADD CONSTRAINT "AgentBehaviourAnomaly_drivers_array"
    CHECK (jsonb_typeof("driversJson") = 'array' AND jsonb_array_length("driversJson") >= 1);

CREATE UNIQUE INDEX "AgentBehaviourAnomaly_tenantId_agentId_day_key"
    ON "AgentBehaviourAnomaly"("tenantId", "agentId", "day");
CREATE INDEX "AgentBehaviourAnomaly_tenantId_day_idx"
    ON "AgentBehaviourAnomaly"("tenantId", "day");

ALTER TABLE "AgentBehaviourAnomaly"
    ADD CONSTRAINT "AgentBehaviourAnomaly_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentBehaviourAnomaly"
    ADD CONSTRAINT "AgentBehaviourAnomaly_agentId_tenantId_fkey"
    FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Row-level security ──────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentBehaviourBaseline" TO app_user;

ALTER TABLE "AgentBehaviourBaseline" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentBehaviourBaseline" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AgentBehaviourBaseline";
CREATE POLICY tenant_isolation ON "AgentBehaviourBaseline"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentBehaviourBaseline";
CREATE POLICY tenant_isolation_insert ON "AgentBehaviourBaseline"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentBehaviourBaseline";
CREATE POLICY superuser_bypass ON "AgentBehaviourBaseline"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentBehaviourAnomaly" TO app_user;

ALTER TABLE "AgentBehaviourAnomaly" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentBehaviourAnomaly" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AgentBehaviourAnomaly";
CREATE POLICY tenant_isolation ON "AgentBehaviourAnomaly"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentBehaviourAnomaly";
CREATE POLICY tenant_isolation_insert ON "AgentBehaviourAnomaly"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentBehaviourAnomaly";
CREATE POLICY superuser_bypass ON "AgentBehaviourAnomaly"
    USING (current_setting('role') != 'app_user');
