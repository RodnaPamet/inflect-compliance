-- The tenant's monthly token ceiling for agentic runs.
--
-- NULLABLE, and NULL means NO BUDGET CONFIGURED = unlimited. That is the
-- opposite reading from the other switches on this table, and it is the
-- correct one here: they guard an AUTHORITY (safe end = "no"), this bounds
-- something already authorised. Defaulting every existing tenant to a budget
-- of zero would refuse every agentic run on deploy.
ALTER TABLE "TenantSecuritySettings"
  ADD COLUMN "agentMonthlyTokenBudget" INTEGER;

-- A negative budget is not "unlimited", it is a typo. NULL stays legal because
-- NULL is the configured meaning of "no budget"; a CHECK on a nullable column
-- passes for NULL, which is what we want.
--
-- Without this, a stored -1 would reach `normaliseBudget`, which floors it to 0
-- and refuses every run — a safe outcome, but one whose cause is invisible from
-- the database. Refusing the write is where the error belongs.
ALTER TABLE "TenantSecuritySettings"
  ADD CONSTRAINT "TenantSecuritySettings_agentMonthlyTokenBudget_nonneg"
  CHECK ("agentMonthlyTokenBudget" IS NULL OR "agentMonthlyTokenBudget" >= 0);
