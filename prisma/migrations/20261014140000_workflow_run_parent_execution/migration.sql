-- #3537 — which automation-rule firing caused this agentic run.
--
-- NULLABLE with no default and no backfill. A run that already exists either
-- had no parent (a person or an MCP credential started it) or had one that was
-- never recorded, and those two are not distinguishable from here. Writing any
-- value would make the second look like the first; NULL keeps "we do not know"
-- and "there was none" the same shape, which is honest because this column
-- cannot tell them apart for historical rows and the audit trail can.
ALTER TABLE "WorkflowRun"
  ADD COLUMN "parentExecutionId" TEXT;

-- NO FOREIGN KEY to "AutomationExecution", deliberately: executions are pruned
-- on a retention schedule and a run must outlive its parent without being
-- cascade-deleted or silently nulled. The join is on a value.
--
-- The index is the CANVAS query — every run one rule firing started, for one
-- tenant — and it is composite with tenantId because every read on this table
-- is tenant-scoped by RLS and a bare parentExecutionId index would be unused.
CREATE INDEX "WorkflowRun_tenantId_parentExecutionId_idx"
  ON "WorkflowRun" ("tenantId", "parentExecutionId");
