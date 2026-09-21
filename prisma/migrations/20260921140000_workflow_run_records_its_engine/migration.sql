-- WorkflowRun records WHICH ENGINE walked it.
--
-- NOT NULL with a DEFAULT rather than nullable, because this column can be
-- backfilled truthfully: `DRIVERS` maps only `static` and
-- `DRIVER_IMPLEMENTED.flue` has been false for the whole life of the
-- `AgentDriverMode` enum, so every existing run did execute on the static
-- engine. 'STATIC' is a fact about those rows, not a placeholder.
--
-- Postgres 11+ records the default in the catalogue rather than rewriting the
-- table, so this is a metadata-only change on a populated table.
ALTER TABLE "WorkflowRun"
    ADD COLUMN "driver" "AgentDriverMode" NOT NULL DEFAULT 'STATIC';
