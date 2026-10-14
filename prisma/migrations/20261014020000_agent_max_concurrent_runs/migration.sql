-- #3484 — per-tenant cap on CONCURRENT agentic runs.
--
-- NULLABLE with no default, exactly as `agentMonthlyTokenBudget` was added and
-- for the same reason: this bounds something already authorised, so defaulting
-- every existing tenant to 0 would refuse every agentic run on deploy.
ALTER TABLE "TenantSecuritySettings"
  ADD COLUMN "agentMaxConcurrentRuns" INTEGER;

-- A negative cap is not "unlimited", it is a typo. NULL stays legal because
-- NULL is the configured meaning of "no cap"; a CHECK on a nullable column
-- passes for NULL.
--
-- ZERO IS LEGAL AND MEANINGFUL, which is the one difference from the budget's
-- constraint: a cap of 0 stops every agentic run for this tenant, readably,
-- without engaging a kill switch — and a kill switch is a different statement
-- with its own audit trail and its own lift.
ALTER TABLE "TenantSecuritySettings"
  ADD CONSTRAINT "TenantSecuritySettings_agentMaxConcurrentRuns_nonneg"
  CHECK ("agentMaxConcurrentRuns" IS NULL OR "agentMaxConcurrentRuns" >= 0);
