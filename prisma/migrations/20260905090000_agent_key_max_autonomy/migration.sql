-- Epic Agentic 2 — the MAXIMUM AUTONOMY a credential may exercise.
--
-- Before this column, an agent's authority travelled entirely with whoever held
-- one of its keys: every key bound to an agent could drive that agent to the
-- full extent of its registered `autonomyLevel`. The effective ceiling is now
-- `min(TenantApiKey."maxAutonomyLevel", RegisteredAgent."autonomyLevel")`, so a
-- key can only ever NARROW — which is what makes the authority a property of
-- the AGENT rather than of the bearer.
--
-- NULLABLE, and the null means NO KEY-LEVEL NARROWING rather than "deny". Every
-- existing key keeps exactly the reach it has today (the agent term still
-- bounds it), so this migration changes no behaviour on its own. Note the
-- deliberate asymmetry with `RegisteredAgent."riskTier"`, where NULL means
-- UNSCORED and every consumer must read it as DENY: an absent narrowing is not
-- an absent assessment, and reading either one like the other is a hole.
--
-- NO BACKFILL. Writing a plausible ceiling onto existing keys would invent an
-- operator decision nobody made, and the value would then look deliberate.

ALTER TABLE "TenantApiKey" ADD COLUMN "maxAutonomyLevel" INTEGER;

-- The ladder is 0-6, the same range `RegisteredAgent."autonomyLevel"` pins.
ALTER TABLE "TenantApiKey"
    ADD CONSTRAINT "TenantApiKey_maxAutonomyLevel_range"
    CHECK (
        "maxAutonomyLevel" IS NULL
        OR ("maxAutonomyLevel" >= 0 AND "maxAutonomyLevel" <= 6)
    );

-- A ceiling on a key bound to NO agent has no agent term to be the lower of,
-- so it would read as the whole of the authority rather than a narrowing of it
-- — precisely the state this column exists to end. Unrepresentable, not merely
-- discouraged, on the same principle as the `provenance = 'THIRD_PARTY'`
-- ⇒ vendor CHECK on RegisteredAgent.
ALTER TABLE "TenantApiKey"
    ADD CONSTRAINT "TenantApiKey_maxAutonomy_requires_agent"
    CHECK ("maxAutonomyLevel" IS NULL OR "agentId" IS NOT NULL);
