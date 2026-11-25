-- #5854 item 3 (owner decision 2026-11-24, option 2 of
-- docs/implementation-notes/2026-11-23-fix-5854-run-claim.md) — A RETRIED
-- AGENT RUN CONTINUES ITS CONVERSATION.
--
-- One row per run. A Tool Runner run checkpoints its conversation at every
-- reply that asks for tools (in the transaction that records that reply's
-- MODEL_CALL step) and each call's result as it settles, so a retry or a lease
-- takeover of the same segment continues from the checkpoint instead of from
-- the opening message, and a call already made is not made again. The row also
-- carries an engine-neutral SEGMENT ANCHOR, which lets a retry on an engine
-- that cannot continue a conversation (Flue, Managed Agents) pause for a person
-- instead of restarting.
--
-- ADDITIVE AND FORWARD-ONLY: one new table, no enum value, nothing an existing
-- row means changes. An older container never reads or writes the table; a
-- run it executes restarts from its opening message on a retry, as it always
-- has. The writer and every reader ship in the same deploy.

-- ─── 1. The table ───────────────────────────────────────────────────

CREATE TABLE "WorkflowRunCheckpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "transcriptJson" TEXT,
    "transcriptHash" TEXT,
    "resultsJson" TEXT,
    "resultsHash" TEXT,
    "inFlightToolUseId" TEXT,
    "atSeq" INTEGER,
    "elapsedMs" INTEGER,
    "costTokens" INTEGER,
    "segmentKey" TEXT,
    "segmentFromSeq" INTEGER,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowRunCheckpoint_pkey" PRIMARY KEY ("id")
);

-- One row per run.
CREATE UNIQUE INDEX "WorkflowRunCheckpoint_tenantId_runId_key" ON "WorkflowRunCheckpoint"("tenantId", "runId");

ALTER TABLE "WorkflowRunCheckpoint" ADD CONSTRAINT "WorkflowRunCheckpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CASCADE from the run: a checkpoint of a run that no longer exists describes
-- nothing, and the transcript is the run's working state.
ALTER TABLE "WorkflowRunCheckpoint" ADD CONSTRAINT "WorkflowRunCheckpoint_runId_tenantId_fkey" FOREIGN KEY ("runId", "tenantId") REFERENCES "WorkflowRun"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 2. The shape ───────────────────────────────────────────────────
--
-- Content comes with its seal: a transcript with its hash, the anchor to which
-- results and an in-flight call belong; results and the in-flight marker only
-- beside a transcript. A SETTLED row holds no content at all (the clear is the
-- settlement); its hashes are kept, so what the run last checkpointed stays
-- provable.
ALTER TABLE "WorkflowRunCheckpoint"
    ADD CONSTRAINT "WorkflowRunCheckpoint_shape"
    CHECK (
        ("transcriptJson" IS NULL OR ("transcriptHash" IS NOT NULL AND "atSeq" IS NOT NULL
                                      AND "elapsedMs" IS NOT NULL AND "costTokens" IS NOT NULL))
        AND ("resultsJson" IS NULL OR ("transcriptJson" IS NOT NULL AND "resultsHash" IS NOT NULL))
        AND ("inFlightToolUseId" IS NULL OR "transcriptJson" IS NOT NULL)
        AND ("settledAt" IS NULL OR ("transcriptJson" IS NULL AND "resultsJson" IS NULL
                                     AND "inFlightToolUseId" IS NULL))
        AND ("transcriptHash" IS NULL OR "transcriptHash" ~ '^[0-9a-f]{64}$')
        AND ("resultsHash" IS NULL OR "resultsHash" ~ '^[0-9a-f]{64}$')
        AND ("inFlightToolUseId" IS NULL OR char_length("inFlightToolUseId") BETWEEN 1 AND 200)
        AND ("atSeq" IS NULL OR "atSeq" >= 0)
        AND ("elapsedMs" IS NULL OR "elapsedMs" >= 0)
        AND ("costTokens" IS NULL OR "costTokens" >= 0)
        AND (("segmentKey" IS NULL) = ("segmentFromSeq" IS NULL))
        AND ("segmentKey" IS NULL OR "segmentKey" ~ '^[0-9]{1,16}$')
        AND ("segmentFromSeq" IS NULL OR "segmentFromSeq" >= 0)
    );

-- ─── 3. A settled checkpoint never changes ──────────────────────────
--
-- Once the run ended, nothing is written to its checkpoint again: a run that
-- settled cannot be continued, and a write after the settlement would put
-- tenant content back into a row the settlement cleared. The rotation sweeps'
-- re-wrap never meets a settled row, which holds no ciphertext.
CREATE OR REPLACE FUNCTION workflow_run_checkpoint_settled_frozen()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."settledAt" IS NOT NULL AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
        RAISE EXCEPTION
            'WORKFLOW_RUN_CHECKPOINT_SETTLED: the run ended, so its checkpoint is cleared and never written again.';
    END IF;
    IF NEW."runId" IS DISTINCT FROM OLD."runId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
        RAISE EXCEPTION
            'WORKFLOW_RUN_CHECKPOINT_RUN_FIXED: a checkpoint belongs to one run.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_run_checkpoint_settled_frozen ON "WorkflowRunCheckpoint";
CREATE TRIGGER workflow_run_checkpoint_settled_frozen
    BEFORE UPDATE ON "WorkflowRunCheckpoint"
    FOR EACH ROW EXECUTE FUNCTION workflow_run_checkpoint_settled_frozen();

-- ─── 4. Grants and the RLS triple ───────────────────────────────────
--
-- No DELETE for `app_user`: a checkpoint goes with its run or its tenant, by
-- cascade, and nothing deletes one by hand.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "WorkflowRunCheckpoint" TO app_user;
        REVOKE DELETE ON "WorkflowRunCheckpoint" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "WorkflowRunCheckpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowRunCheckpoint" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "WorkflowRunCheckpoint";
CREATE POLICY tenant_isolation ON "WorkflowRunCheckpoint"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "WorkflowRunCheckpoint";
CREATE POLICY tenant_isolation_insert ON "WorkflowRunCheckpoint"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "WorkflowRunCheckpoint";
CREATE POLICY superuser_bypass ON "WorkflowRunCheckpoint"
    USING (current_setting('role') != 'app_user');
