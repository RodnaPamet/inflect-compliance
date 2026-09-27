-- #2861 — how far a connection may go when an AGENT drives a write to it.
--
-- The ladder itself landed in #2933 with no storage, deliberately: "adding
-- `externalWriteMode` columns now would be a migration for a mechanism with no
-- reader and no writer". This is the storage, and it arrives with the OWNER-gated
-- setter that writes it and the admin surface that reads it.
--
-- WHY A TEXT COLUMN AND NOT A POSTGRES ENUM. This is the one decision here worth
-- explaining, and it is the identity ladder's scar. Postgres cannot drop an enum
-- value without recreating the type, and an `ALTER TYPE` mid-rolling-deploy makes
-- still-running OLD containers fail with SQLSTATE 42704 — which is why
-- `IdentityWriteMode` still carries a retired `PROPOSE` value that no rung maps
-- to. `external-write-ladder.ts` was written for a string: `coerceStoredMode`
-- takes `string | null | undefined` and fails CLOSED to DISABLED for anything it
-- does not recognise, and `RETIRED_MODES` exists to translate a rung that has
-- been removed. A retired rung therefore costs a source constant, not a
-- migration, and an old container reading a rung it has never heard of treats it
-- as "off" rather than as the widest authority the caller allows.
--
-- NO BACKFILL, AND THAT IS NOT AN OMISSION. NULL coerces to DISABLED, which is
-- exactly what every existing connection should read as — so writing DISABLED
-- into every row would change nothing and would only make the "never set" state
-- indistinguishable from "deliberately set to off". The distinction is worth
-- keeping: `externalWriteModeSince` is NULL alongside it, and the ladder refuses
-- to widen off a rung with no recorded start.
--
-- AlterTable
ALTER TABLE "IntegrationConnection"
    ADD COLUMN "externalWriteMode" TEXT,
    ADD COLUMN "externalWriteModeSince" TIMESTAMP(3);
