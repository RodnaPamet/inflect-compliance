-- Epic Agentic 9 — THE KILL SWITCH at three scopes, and the drill that proves it.
-- (OWASP ASI08 cascading failure; ASI10 rogue agent.)
--
-- Three tables:
--
--   1. "AgentKillSwitch"         tenant-scoped, canonical policy triple + FORCE.
--                                agentId NULL = tenant-wide, non-NULL = one agent.
--   2. "PlatformAgentKillSwitch" GLOBAL. No tenantId, therefore no RLS; app_user
--                                gets SELECT and nothing else.
--   3. "AgentKillSwitchDrill"    tenant-scoped, canonical policy triple + FORCE.
--                                The recorded outcome of each scheduled drill.
--
-- ROLLING-DEPLOY SAFETY. All three tables are CREATED EMPTY and no already-running
-- container reads or writes them: an old container's tool boundary simply does not
-- ask the question, which is exactly the pre-change behaviour. There is no ALTER
-- TABLE on a populated table, no NOT NULL without a default added to existing
-- rows, and — deliberately — NO `CREATE TYPE` / `ALTER TYPE` anywhere.
--
-- NO POSTGRES ENUMS. `outcome` and the two scope arrays are TEXT with CHECK
-- constraints, the shape "McpToolManifestPin"."approvalSource" and
-- "AgentPolicyCardVersion"."approvalRung" already use, for the reason the
-- @@map("WorkItem*") pins record: an enum value added or renamed mid-rolling-deploy
-- makes still-running old containers fail with SQLSTATE 42704. A kill scope and a
-- drill outcome are both vocabularies that can grow; neither may become a type
-- somebody has to recreate a table to widen.

-- ═══════════════════════════════════════════════════════════════════
-- 1. AgentKillSwitch — tenant-scoped
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "AgentKillSwitch" (
    "id"              TEXT NOT NULL,
    "tenantId"        TEXT NOT NULL,
    -- NULL = every agent in this tenant. The scope is DERIVED from this column;
    -- there is deliberately no `scope` column to disagree with it.
    "agentId"         TEXT,
    "reason"          TEXT NOT NULL,
    "engagedByUserId" TEXT NOT NULL,
    "engagedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt"        TIMESTAMP(3),
    "liftedByUserId"  TEXT,
    "liftReason"      TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentKillSwitch_pkey" PRIMARY KEY ("id")
);

-- A lift must name WHO and WHEN together. Without this a half-written lift
-- (liftedAt set, liftedByUserId NULL) reads as "the kill ended and nobody ended
-- it", and the one question an incident review asks of this table — who turned
-- the agents back on — stops being answerable from the row.
ALTER TABLE "AgentKillSwitch"
    ADD CONSTRAINT "AgentKillSwitch_lift_accountability"
    CHECK (
        ("liftedAt" IS NULL AND "liftedByUserId" IS NULL)
        OR ("liftedAt" IS NOT NULL AND "liftedByUserId" IS NOT NULL)
    );

-- A kill with an empty reason is an outage nobody can review.
ALTER TABLE "AgentKillSwitch"
    ADD CONSTRAINT "AgentKillSwitch_reason_present"
    CHECK (length(btrim("reason")) > 0);

-- THE HOT-PATH INDEX. Every tool call asks
-- (tenantId = ?, liftedAt IS NULL, agentId IN (?, NULL)).
CREATE INDEX "AgentKillSwitch_tenantId_agentId_liftedAt_idx"
    ON "AgentKillSwitch"("tenantId", "agentId", "liftedAt");
CREATE INDEX "AgentKillSwitch_tenantId_engagedAt_idx"
    ON "AgentKillSwitch"("tenantId", "engagedAt");

-- AT MOST ONE kill in force per (tenant, target). A partial unique index rather
-- than a usecase check, because the usecase check is a read-then-write and two
-- concurrent engages would both pass it — leaving two rows that must then both be
-- lifted before agents resume, which is precisely the failure mode "lift the kill"
-- must not have. COALESCE folds the tenant-wide row (agentId NULL) into the same
-- uniqueness, since NULLs are distinct in a plain unique index and would let an
-- unbounded number of tenant-wide kills accumulate.
CREATE UNIQUE INDEX "AgentKillSwitch_one_in_force_per_target"
    ON "AgentKillSwitch"("tenantId", COALESCE("agentId", ''))
    WHERE "liftedAt" IS NULL;

ALTER TABLE "AgentKillSwitch"
    ADD CONSTRAINT "AgentKillSwitch_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- NOTE: "agentId" carries NO foreign key, on purpose. See the model docstring in
-- prisma/schema/agentic.prisma — a healthy register must not be a precondition
-- for stopping, a kill is history that has to outlive its agent, and the drill
-- needs a canary target no credential can resolve to.

-- ─── RLS (Epic A.1). tenantId is NOT NULL, so the split form is correct. ───
GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentKillSwitch" TO app_user;
ALTER TABLE "AgentKillSwitch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentKillSwitch" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AgentKillSwitch";
CREATE POLICY tenant_isolation ON "AgentKillSwitch"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentKillSwitch";
CREATE POLICY tenant_isolation_insert ON "AgentKillSwitch"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentKillSwitch";
CREATE POLICY superuser_bypass ON "AgentKillSwitch"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- 2. PlatformAgentKillSwitch — GLOBAL
-- ═══════════════════════════════════════════════════════════════════
-- No tenantId, so no RLS: there is no tenant to isolate to. The authority to stop
-- every agent in the deployment is not a tenant role and no PermissionSet key can
-- express it — `requirePermission` resolves a tenant role. It is gated by
-- PLATFORM_ADMIN_API_KEY at the route.
CREATE TABLE "PlatformAgentKillSwitch" (
    "id"           TEXT NOT NULL,
    "reason"       TEXT NOT NULL,
    -- Not a User id: the platform-admin key is not a person, and inventing an
    -- actor is worse than recording the reference the operator supplied.
    "engagedByRef" TEXT NOT NULL,
    "engagedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt"     TIMESTAMP(3),
    "liftedByRef"  TEXT,
    "liftReason"   TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformAgentKillSwitch_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PlatformAgentKillSwitch"
    ADD CONSTRAINT "PlatformAgentKillSwitch_lift_accountability"
    CHECK (
        ("liftedAt" IS NULL AND "liftedByRef" IS NULL)
        OR ("liftedAt" IS NOT NULL AND "liftedByRef" IS NOT NULL)
    );

ALTER TABLE "PlatformAgentKillSwitch"
    ADD CONSTRAINT "PlatformAgentKillSwitch_reason_present"
    CHECK (length(btrim("reason")) > 0 AND length(btrim("engagedByRef")) > 0);

CREATE INDEX "PlatformAgentKillSwitch_liftedAt_idx"
    ON "PlatformAgentKillSwitch"("liftedAt");

-- At most ONE platform kill in force at a time, enforced at the database. Two
-- concurrent engages would otherwise both succeed and lifting one would leave the
-- platform still dark with no visible reason.
CREATE UNIQUE INDEX "PlatformAgentKillSwitch_one_in_force"
    ON "PlatformAgentKillSwitch"((TRUE))
    WHERE "liftedAt" IS NULL;

-- SELECT only. The boundary reads this on the superuser session (the base Prisma
-- client), exactly like policy-card-store.ts; the grant exists so a read that
-- happens to run inside a tenant transaction cannot silently return zero rows and
-- report "not killed". No write grant: nothing an app_user session does may stop
-- or start the platform.
GRANT SELECT ON "PlatformAgentKillSwitch" TO app_user;

-- ═══════════════════════════════════════════════════════════════════
-- 3. AgentKillSwitchDrill — tenant-scoped
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "AgentKillSwitchDrill" (
    "id"                    TEXT NOT NULL,
    "tenantId"              TEXT NOT NULL,
    "jobRunId"              TEXT NOT NULL,
    "startedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"           TIMESTAMP(3),
    "outcome"               TEXT NOT NULL,
    "scopesHonoured"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "scopesFailed"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "toolCallsAfterKill"    INTEGER NOT NULL DEFAULT 0,
    "boundaryRefusalReason" TEXT,
    "detail"                TEXT NOT NULL,
    "evidenceId"            TEXT,
    "findingId"             TEXT,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentKillSwitchDrill_pkey" PRIMARY KEY ("id")
);

-- The outcome vocabulary, pinned so a typo cannot create a fourth silent class
-- that no dashboard counts. ERROR is deliberately distinct from FAILED: a drill
-- that could not RUN has proved nothing, and reporting it as "the control is
-- broken" would raise a Finding about the wrong thing.
ALTER TABLE "AgentKillSwitchDrill"
    ADD CONSTRAINT "AgentKillSwitchDrill_outcome_known"
    CHECK ("outcome" IN ('PASSED', 'FAILED', 'ERROR'));

-- A PASSED drill in which a tool call got through after the kill is a
-- contradiction, and it is the exact contradiction this table exists to make
-- impossible to record. If the two ever disagree the row must not be writable.
ALTER TABLE "AgentKillSwitchDrill"
    ADD CONSTRAINT "AgentKillSwitchDrill_passed_means_nothing_got_through"
    CHECK ("outcome" <> 'PASSED' OR ("toolCallsAfterKill" = 0 AND cardinality("scopesFailed") = 0));

CREATE INDEX "AgentKillSwitchDrill_tenantId_startedAt_idx"
    ON "AgentKillSwitchDrill"("tenantId", "startedAt");
CREATE INDEX "AgentKillSwitchDrill_tenantId_outcome_idx"
    ON "AgentKillSwitchDrill"("tenantId", "outcome");

ALTER TABLE "AgentKillSwitchDrill"
    ADD CONSTRAINT "AgentKillSwitchDrill_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentKillSwitchDrill" TO app_user;
ALTER TABLE "AgentKillSwitchDrill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentKillSwitchDrill" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AgentKillSwitchDrill";
CREATE POLICY tenant_isolation ON "AgentKillSwitchDrill"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentKillSwitchDrill";
CREATE POLICY tenant_isolation_insert ON "AgentKillSwitchDrill"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentKillSwitchDrill";
CREATE POLICY superuser_bypass ON "AgentKillSwitchDrill"
    USING (current_setting('role') != 'app_user');
