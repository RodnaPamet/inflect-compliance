-- The verdict a ratification was made against.
--
-- A PLAIN COLUMN, not a foreign key, because of a lifetime mismatch: an alias
-- is the durable record of a person's decision, and a verdict is an annotation
-- that cascades away with its reconciliation run. No referential action says
-- "keep the alias, forget the verdict" — Cascade would delete the decision,
-- Restrict would make a run un-purgeable because somebody ratified a row in it,
-- and SetNull cannot null a required `tenantId` on the composite key that would
-- be needed to prevent a cross-tenant reference.
--
-- So a purged verdict leaves the id behind. That is honest rather than lossy:
-- the decision WAS made against that verdict, and that stays true afterwards.
--
-- Nullable with no backfill. Every alias confirmed before adjudication existed
-- genuinely has no verdict, and `NULL` says exactly that.
ALTER TABLE "LegacyIdentityAlias" ADD COLUMN "verdictId" TEXT;

-- Indexed because the useful direction is verdict -> ratifications: "was this
-- verdict acted on, and by whom" is the blind sample's own question, and it
-- would otherwise be a sequential scan of every alias a tenant has.
CREATE INDEX "LegacyIdentityAlias_tenantId_verdictId_idx"
    ON "LegacyIdentityAlias" ("tenantId", "verdictId");
