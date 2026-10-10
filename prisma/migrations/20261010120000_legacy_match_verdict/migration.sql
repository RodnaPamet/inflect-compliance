-- Step 6c: one model opinion about one resolution, under one model revision.
--
-- Two NEW types, so `CREATE TYPE` rather than `ADD VALUE` — the hazard that
-- rule guards against (a value committed outside the transaction, surviving a
-- rollback, then failing the re-run) cannot arise for a type that did not
-- previously exist.

CREATE TYPE "LegacyMatchVerdictClass" AS ENUM
    ('NOT_A_PERSON', 'NO_MATCH', 'AGREES', 'PROPOSES', 'UNSURE');

CREATE TYPE "LegacyMatchNonVerdictReason" AS ENUM
    ('NO_PROVIDER', 'NO_EVALUATION', 'MODEL_DRIFT', 'KILL_SWITCH', 'BREAKER_OPEN',
     'QUARANTINED', 'OVER_BUDGET', 'TIMEOUT', 'DEADLINE', 'PROVIDER_ERROR');

-- The composite unique Step 6c's FK targets. `references` must name a unique
-- criterion, and the tenant-safe shape every child in this subsystem uses is
-- (id, tenantId) rather than (id) alone — so a child row cannot point at a
-- parent in another tenant even if an id were guessed.
ALTER TABLE "LegacyAccountResolution"
    ADD CONSTRAINT "LegacyAccountResolution_id_tenantId_key" UNIQUE ("id", "tenantId");

CREATE TABLE "LegacyMatchVerdict" (
    "id"                TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "resolutionId"      TEXT NOT NULL,
    "modelId"           TEXT NOT NULL,
    "modelRevision"     TEXT NOT NULL,
    "verdict"           "LegacyMatchVerdictClass",
    "nonVerdictReason"  "LegacyMatchNonVerdictReason",
    "probabilitiesJson" JSONB,
    "personProbability" DOUBLE PRECISION,
    "topProbability"    DOUBLE PRECISION,
    "topMargin"         DOUBLE PRECISION,
    "latencyMs"         INTEGER,
    "inputTokens"       INTEGER,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyMatchVerdict_pkey" PRIMARY KEY ("id")
);

-- ONE ANSWER PER QUESTION. The revision is in the key, which is what makes a
-- model change an addition rather than a collision: "what did revision X say
-- about this account" stays answerable after a model change, and a re-run under
-- the SAME revision cannot produce a second, possibly different answer to the
-- same question.
CREATE UNIQUE INDEX "LegacyMatchVerdict_resolutionId_modelRevision_key"
    ON "LegacyMatchVerdict"("resolutionId", "modelRevision");

CREATE INDEX "LegacyMatchVerdict_tenantId_idx" ON "LegacyMatchVerdict"("tenantId");
CREATE INDEX "LegacyMatchVerdict_tenantId_verdict_idx"
    ON "LegacyMatchVerdict"("tenantId", "verdict");
CREATE INDEX "LegacyMatchVerdict_tenantId_nonVerdictReason_idx"
    ON "LegacyMatchVerdict"("tenantId", "nonVerdictReason");

ALTER TABLE "LegacyMatchVerdict"
    ADD CONSTRAINT "LegacyMatchVerdict_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LegacyMatchVerdict"
    ADD CONSTRAINT "LegacyMatchVerdict_resolutionId_tenantId_fkey"
    FOREIGN KEY ("resolutionId", "tenantId")
    REFERENCES "LegacyAccountResolution"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- EITHER a verdict OR a reason. Never both, never neither.
--
-- Both would make the queue ambiguous about whether a model actually spoke, and
-- neither is a question nobody asked — a row that records the asking without
-- recording any answer. Enforced here rather than only in the usecase because a
-- backfill, a repair script or a future caller are exactly the writers a usecase
-- check does not cover, and this is a permanent property of the data rather
-- than a completeness one.
ALTER TABLE "LegacyMatchVerdict"
    ADD CONSTRAINT "LegacyMatchVerdict_outcome_shape"
    CHECK (
        ("verdict" IS NOT NULL AND "nonVerdictReason" IS NULL)
        OR ("verdict" IS NULL AND "nonVerdictReason" IS NOT NULL)
    );

-- RLS, per global rule: every tenant table carries it, and a behavioural test
-- registered in tenant-isolation-forward-lock proves it rather than the
-- migration asserting it.
ALTER TABLE "LegacyMatchVerdict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegacyMatchVerdict" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "LegacyMatchVerdict";
CREATE POLICY tenant_isolation ON "LegacyMatchVerdict"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "LegacyMatchVerdict";
CREATE POLICY tenant_isolation_insert ON "LegacyMatchVerdict"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "LegacyMatchVerdict";
CREATE POLICY superuser_bypass ON "LegacyMatchVerdict"
    USING (current_setting('app.tenant_id', true) IS NULL
        OR current_setting('app.tenant_id', true) = '');
