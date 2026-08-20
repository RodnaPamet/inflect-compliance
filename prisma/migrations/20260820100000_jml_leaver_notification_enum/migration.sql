-- JML leaver offboarding — the notification types the disable path enqueues.
--
-- ALTER TYPE … ADD VALUE is forward-compatible: an old container still running
-- through a rolling deploy reads the enlarged type without error, and nothing
-- writes these values until the new image is serving. The reverse order (code
-- first, then the value) is what breaks, which is why the migration ships in
-- the same change as the writer.
--
-- IF NOT EXISTS so a re-run against a partially-migrated database is a no-op
-- rather than a failed deploy.

ALTER TYPE "EmailNotificationType" ADD VALUE IF NOT EXISTS 'IDENTITY_LEAVER_DISABLED';
ALTER TYPE "EmailNotificationType" ADD VALUE IF NOT EXISTS 'IDENTITY_LEAVER_UNCONFIRMED';
ALTER TYPE "EmailNotificationType" ADD VALUE IF NOT EXISTS 'IDENTITY_LEAVER_NEEDS_ACTION';
