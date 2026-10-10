-- Step 6c: per-tenant model adjudication of the reconciliation residue.
--
-- A NEW type, so `CREATE TYPE` rather than `ADD VALUE` — the enum-isolation
-- hazard (a value committed outside the transaction, surviving a rollback and
-- then failing the re-run) does not arise for a type that did not previously
-- exist. The column's DEFAULT is what makes this safe to deploy ahead of the
-- feature: every existing tenant reads OFF, and OFF is the only value that
-- reaches no provider.
CREATE TYPE "LegacyMatchAiMode" AS ENUM ('OFF', 'LOCAL_ONLY', 'EXTERNAL');

ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN "legacyMatchAiMode" "LegacyMatchAiMode" NOT NULL DEFAULT 'OFF';
