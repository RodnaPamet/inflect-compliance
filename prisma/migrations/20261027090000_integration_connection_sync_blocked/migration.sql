-- #4389: surface a connection whose sync cannot be ATTRIBUTED to anyone.

-- The scheduled SharePoint delta sync borrows an active Owner or Admin who may
-- upload evidence, so the evidence it creates names a real member. Since #4375
-- it skips a connection whose workspace has no such member, reporting
-- NO_ACTIVE_ADMIN or NO_ADMIN_WITH_EVIDENCE_UPLOAD in the dispatch result and a
-- warn log — neither of which an admin reads. The integrations page gave no
-- sign the connection had stopped syncing.

-- Writing an IntegrationExecution row instead would have made it WORSE:
-- getConnectionsHealth derives lastActivity from the most recent execution of
-- ANY status, so a row written every four hours for a connection that never
-- syncs would have cleared its stale flag and made it read as healthy.

-- A separate pair from authFailedAt / authFailureReason, for the same reason
-- that pair is separate from lastTestedAt / lastTestStatus: a revoked
-- credential and a permissions configuration are different facts with
-- different fixes, and sharing one field would let either paper over the other.

-- Two nullable columns, no default, no backfill: NULL means "no block
-- observed", the correct reading for every existing row. Additive and safe to
-- deploy ahead of the app — old containers ignore the columns.

-- Rollback: DROP COLUMN both. Nothing depends on them; the app treats NULL as
-- unblocked, so a rollback degrades to the pre-migration behaviour exactly.

ALTER TABLE "IntegrationConnection"
    ADD COLUMN "syncBlockedAt" TIMESTAMP(3),
    ADD COLUMN "syncBlockedReason" TEXT;
