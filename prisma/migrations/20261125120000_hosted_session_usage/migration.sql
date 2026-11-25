-- Hosted session time, per tenant (#4173, owner decision 4 of 2026-11-25;
-- docs/claude-managed-agents-design.md, MA-C1 "Inflect pays").
--
-- A Managed Agents session in INFLECT's own Anthropic workspace is billed to
-- Inflect by the second it runs (`usage.active_seconds` on the session object,
-- the figure Anthropic says the runtime cost is priced on). Tokens were already
-- recorded per tenant (`WorkflowRun.costTokens` on a run marked
-- `hostedManagedAgents`); this records the session time beside them:
--
--   "hostedSessionSeconds"     the sum of `usage.active_seconds` over the
--                              run's hosted sessions whose usage was read at
--                              settle; NULL while none was (never a zero that
--                              means "not known").
--   "hostedSessionsUnmetered"  hosted sessions the run created whose usage was
--                              NOT read (the read failed, the session was still
--                              running, or a dead worker left it): above zero,
--                              the seconds are a lower bound and the rest is
--                              unknown.
--
-- Both are written only by src/lib/agentic/managed-agents/session-usage.ts, and
-- only on a hosted run: the CHECK below refuses either on a run in the tenant's
-- own workspace, whose cost is the customer's.
--
-- Nothing here can be reached while HOSTED_MANAGED_AGENTS_ACTIVE is false: no
-- run is marked hosted, so no row can carry either value.
--
-- ADDITIVE ONLY: one nullable column and one with a default (no rewrite on
-- Postgres 11+), and three CHECKs every existing row satisfies (the new
-- columns hold NULL and 0 on every row). Old containers never select the new
-- columns, so a rolling deploy is safe in both directions.

ALTER TABLE "WorkflowRun" ADD COLUMN "hostedSessionSeconds" DOUBLE PRECISION;
ALTER TABLE "WorkflowRun" ADD COLUMN "hostedSessionsUnmetered" INTEGER NOT NULL DEFAULT 0;

-- A run in the tenant's own workspace records no hosted session time.
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_hosted_session_usage_hosted_only" CHECK (
    "hostedManagedAgents" OR ("hostedSessionSeconds" IS NULL AND "hostedSessionsUnmetered" = 0)
);
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_hosted_session_seconds_nonnegative" CHECK (
    "hostedSessionSeconds" IS NULL OR "hostedSessionSeconds" >= 0
);
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_hosted_sessions_unmetered_nonnegative" CHECK (
    "hostedSessionsUnmetered" >= 0
);
