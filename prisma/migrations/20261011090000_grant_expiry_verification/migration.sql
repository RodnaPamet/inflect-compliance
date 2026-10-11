-- #3416 — verify that a time-bounded grant actually expired.
--
-- NOT a new `ExternalWriteOutcome` value. That enum describes what happened to
-- OUR WRITE, and the write succeeded: the row is already `APPLIED`. Expiry is a
-- later lifecycle event of the thing the write created, so folding it into
-- `outcome` would overload "what happened to the request" with "what happened to
-- the grant". The enum's own docblock earns `RECORDED_ONLY` its value on exactly
-- this test — whether the question is a query over those rows — and this question
-- is not.
ALTER TABLE "ExternalWriteJournal" ADD COLUMN "expiryVerifiedAt" TIMESTAMP(3);

-- The sweep's whole query: unconfirmed grants for one tenant and one tool.
-- `expiryVerifiedAt` last, because it is the selective term — a confirmed row
-- leaves the population permanently, so this index shrinks as the sweep works
-- rather than growing with the journal.
CREATE INDEX "ExternalWriteJournal_tenantId_advertisedToolName_expiryVerifiedAt_idx"
    ON "ExternalWriteJournal" ("tenantId", "advertisedToolName", "expiryVerifiedAt");

-- The dedup key for the escalation, and a durable record that we escalated.
--
-- NOT a TaskLink: `TaskLinkEntityType` has no value for a journal row, and
-- `assertLinkTargetInTenant` requires a real row of a supported model — so the
-- link-based idempotency `retention-notifications` uses is not available here
-- without a second enum value and a model mapping. Keeping the dedup state on
-- the row it is about is both cheaper and more direct, and it leaves "which
-- grants outlived their window" as a query over exactly these rows.
ALTER TABLE "ExternalWriteJournal" ADD COLUMN "expiryRaisedAt" TIMESTAMP(3);

-- The provenance for the task this sweep raises. Its own member rather than
-- reusing INTEGRATION: a grant outliving its window is a control that failed,
-- and `tests/guardrails/task-source-valid.test.ts` exists because free strings
-- were once used here ('kri_breach', 'risk_appetite_breach') and silently were
-- not enum members. Same shape as the migration that added RISK_MONITOR.
ALTER TYPE "WorkItemSource" ADD VALUE IF NOT EXISTS 'GRANT_EXPIRY';
