-- Move the WEBHOOK HMAC signing key out of plaintext JSON.
--
-- `AutomationRule.actionConfigJson.secretRef` was documented on the TypeScript
-- type as "reference into the secret store (never the raw secret)", but the
-- executor used it DIRECTLY as the HMAC key. `actionConfigJson` is a plain Json
-- column and is NOT in the Epic B encrypted-field manifest, so every configured
-- webhook secret sat in clear in the database, in backups, and in any query
-- result.
--
-- The new column IS in the manifest, so the Prisma middleware encrypts on write
-- and decrypts on read.

ALTER TABLE "AutomationRule" ADD COLUMN "webhookSecretEncrypted" TEXT;

-- Backfill is DELIBERATELY NOT DONE HERE.
--
-- Encryption is applied by the application's Prisma middleware using the
-- per-tenant DEK; SQL cannot produce a valid ciphertext, and copying the
-- plaintext across in SQL would leave an unencrypted value in a column the
-- application will try to DECRYPT on read — corrupting it. The migration
-- therefore only creates the column.
--
-- Existing rows are migrated by `scripts/migrate-webhook-secrets.ts`, which
-- reads each rule's `actionConfigJson.secretRef`, writes it through the
-- application layer (encrypting it), and strips the key from the JSON. Until
-- that runs, `fireWebhook` falls back to the legacy `secretRef` so live
-- webhooks keep signing — the fallback is removed once the sweep reports zero
-- remaining.
