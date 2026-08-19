-- JML identity-write authority, per direction, on TenantSecuritySettings.
--
-- Both directions default to DISABLED. This product has never written to a
-- customer's identity directory; enabling that is a deliberate act, not
-- something a migration should switch on for existing tenants.
--
-- No RLS work is needed: TenantSecuritySettings already carries the tenant
-- policies, and these are columns on it rather than a new model. That is the
-- main reason this setting lives here instead of in a table of its own.

CREATE TYPE "IdentityWriteMode" AS ENUM ('DISABLED', 'DRY_RUN', 'PROPOSE', 'AUTOMATIC');

ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN "identityLeaverMode" "IdentityWriteMode" NOT NULL DEFAULT 'DISABLED',
    ADD COLUMN "identityJoinerMode" "IdentityWriteMode" NOT NULL DEFAULT 'DISABLED',
    ADD COLUMN "identityLeaverDryRunSince" TIMESTAMP(3),
    ADD COLUMN "identityJoinerDryRunSince" TIMESTAMP(3);
