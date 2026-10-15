-- #3473 — per-tenant cap on how many subagents ONE PARENT TURN may delegate to.
--
-- NOT NULL WITH A DEFAULT, which is the opposite shape to the two caps added
-- before it (`agentMonthlyTokenBudget`, `agentMaxConcurrentRuns`), and the
-- difference is load-bearing rather than stylistic.
--
-- Those two bound work that already runs, so defaulting every existing tenant
-- to a number would refuse it on deploy — hence nullable, with NULL meaning
-- "no cap". Delegation is the reverse: nothing can delegate today, because the
-- `task` tool has no valid target until a subagent is declared (#3569). A
-- default therefore restricts nothing that works, and the owner's decision was
-- a cap DEFAULTING LOW.
--
-- A nullable column could not deliver that honestly. NULL would have to mean
-- "the product default", and a NULL meaning "unlimited" one column up and "3"
-- here is how somebody reads the wrong one under pressure.
--
-- Safe on a populated table: Postgres 11+ adds a NOT NULL column with a
-- constant default without rewriting it.
ALTER TABLE "TenantSecuritySettings"
  ADD COLUMN "agentMaxSubagentsPerTurn" INTEGER NOT NULL DEFAULT 3;

-- A negative cap is not "unlimited", it is a typo.
--
-- ZERO IS LEGAL AND MEANINGFUL: a cap of 0 withdraws delegation for this
-- tenant readably, without retiring an agent or engaging a kill switch —
-- both of which say something larger and carry their own audit trail.
ALTER TABLE "TenantSecuritySettings"
  ADD CONSTRAINT "TenantSecuritySettings_agentMaxSubagentsPerTurn_nonneg"
  CHECK ("agentMaxSubagentsPerTurn" >= 0);
