-- #3759 (follow-up of #3754, Phase 4 #3659) — KEEP THE MODEL ENDPOINTS A `/2`
-- REPORT NAMES.
--
-- `inflect-agent-harness/2` carries, per agent, an optional `models[]` of
-- `{ endpoint, model }`: references to the model endpoints the agent calls. The
-- ingest verified them and stored nothing. The owner decided on 2026-10-19 that
-- they are stored, so the harness matrix can show which models each agent
-- calls.
--
-- NULL is NOT REPORTED: a `/1` scan, or a `/2` agent without `models`. `[]` is
-- reported empty. The two must stay distinct, which is why the column is
-- nullable and carries no default.
--
-- Additive and rolling-deploy safe: a nullable column with no default is a
-- catalogue change only, and an old container neither selects nor writes it.
-- No row changes. RLS on "AgentHarnessScanItem" already covers the column.

ALTER TABLE "AgentHarnessScanItem" ADD COLUMN "modelsJson" JSONB;
