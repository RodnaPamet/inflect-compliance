-- The publisher's own ids for a third-party application, so the Integrations
-- tab on /agents/reports can link to the vendor's console ("What is this?",
-- "Manage / deactivate"). Inflect stays read-only: these are links, not writes.
--
--   publisherAppId    Entra's application (client) id GUID, a GitHub App's
--                     numeric id as a string, or an Okta app id.
--   publisherAppSlug  a GitHub App's slug.
--
-- Both are identifiers the signed `scanent-integrations/1` report already
-- carries; neither is a secret. NULLABLE with no default and no backfill: a row
-- reads NULL (no link) until the next scan of its directory stamps it. The
-- table keeps its RLS policies; adding columns changes none of them.
ALTER TABLE "DiscoveredThirdPartyApp"
  ADD COLUMN "publisherAppId" TEXT,
  ADD COLUMN "publisherAppSlug" TEXT;
