-- The workspace default language (#5868, owner decision 2026-11-24).
--
-- The language of text the PRODUCT writes into a workspace's records on its
-- behalf — first, the titles of the tasks a NIS2 gap-assessment dispatch
-- creates. Those are editable records, so they cannot be re-worded on read the
-- way stock notifications are (#5929); the language is chosen when the record
-- is written. It is not anybody's interface language, which stays a
-- per-browser cookie.
--
-- ADDITIVE ONLY. A NOT NULL column with a constant default is a catalogue
-- change in Postgres 11+, with no table rewrite, and 'en' is exactly what
-- every workspace has written until now, so no backfill is needed and no
-- workspace's behaviour changes on deploy. A still-running old container
-- never names the column, and an INSERT it makes takes the default, so a
-- rolling deploy is safe in both directions.
--
-- TEXT + CHECK rather than a Postgres enum, on purpose: Prisma casts enum
-- parameters by type name, so an ALTER TYPE mid-rolling-deploy fails the old
-- containers (SQLSTATE 42704), the lesson the @@map("WorkItem*") pins record.
-- Supporting a new language is a widened CHECK, nothing more.
ALTER TABLE "Tenant"
  ADD COLUMN "defaultLocale" TEXT NOT NULL DEFAULT 'en';

-- The supported locales, SUPPORTED_LOCALES in src/lib/locale-constants.ts.
-- The writer's Zod schema refuses anything else at the route; this is the
-- backstop for every other writer.
ALTER TABLE "Tenant"
  ADD CONSTRAINT "Tenant_defaultLocale_supported"
  CHECK ("defaultLocale" IN ('en', 'bg'));
