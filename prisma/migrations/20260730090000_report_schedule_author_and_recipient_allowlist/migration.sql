-- Scheduled-report delivery hardening.
--
-- Two columns, both additive and both nullable, so this migration is safe to
-- apply ahead of the code that reads them.
--
-- 1. ReportSchedule.createdByUserId — who authored the recurring outbound feed.
--    The delivery cron previously executed every schedule as the tenant's
--    OLDEST ACTIVE OWNER/ADMIN and stamped ReportRun.requestedBy with that
--    admin's id, so an EDITOR's scheduled export was logged against an owner
--    who had never seen it. Deliberately NOT a foreign key: a departed author
--    must not block the row, and requestedBy is FK-free for the same reason.
--
--    No backfill is possible — the authorship of existing rows was never
--    recorded anywhere, and inventing one (e.g. the tenant owner) would write
--    the very fiction this column exists to end. Pre-existing schedules keep
--    NULL and their runs record NULL rather than a borrowed identity.
--
-- 2. TenantSecuritySettings.reportRecipientAllowlistJson — external recipients
--    a schedule may deliver to. NULL means "members only", which is the
--    fail-closed default for every existing tenant.

ALTER TABLE "ReportSchedule" ADD COLUMN "createdByUserId" TEXT;

ALTER TABLE "TenantSecuritySettings" ADD COLUMN "reportRecipientAllowlistJson" JSONB;
