-- #3708 — a per-tenant API-key rotation age for the credential-hygiene pass
-- (follow-up to step 2b, #3670).
--
-- NULLABLE, NO DEFAULT, NO BACKFILL. NULL is the configured meaning of "use the
-- product default" (`DEFAULT_KEY_ROTATION_DAYS`, 90), and the pass records
-- `DEFAULT_NO_TENANT_SETTING` for it exactly as it did before this column
-- existed — so every existing tenant's behaviour and every existing row's
-- wording is unchanged by the deploy. A database default of 90 would have made
-- every tenant's row claim a policy nobody chose.
--
-- Additive only: Postgres adds a nullable column without a default as a
-- catalogue change, with no table rewrite. A still-running old container never
-- names the column, so a rolling deploy is safe in both directions.
ALTER TABLE "TenantSecuritySettings"
  ADD COLUMN "apiKeyRotationDays" INTEGER;

-- 7..730 days inclusive. Below a week every agent key fires within days of
-- minting — noise that teaches people to ignore the rule; above two years the
-- rule stops saying anything. The Zod schema refuses the same range at the
-- route, and this is the backstop for every writer that is not that route. A
-- CHECK on a nullable column passes for NULL, which keeps "no setting" legal.
ALTER TABLE "TenantSecuritySettings"
  ADD CONSTRAINT "TenantSecuritySettings_apiKeyRotationDays_range"
  CHECK ("apiKeyRotationDays" IS NULL OR ("apiKeyRotationDays" >= 7 AND "apiKeyRotationDays" <= 730));
