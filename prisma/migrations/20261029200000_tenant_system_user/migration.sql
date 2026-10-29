-- #4400 — a per-tenant SYSTEM `User` row, so a background job can satisfy a
-- NOT NULL foreign key to `User` (`Task.createdByUserId` first) without
-- borrowing a real member's id.
--
-- The row is created lazily, by `ensureTenantSystemUser`
-- (`src/app-layer/context-system.ts`), the first time a job needs it. Its
-- shape is fixed by its id:
--
--   id           'sys_' || <tenantId>      (a cuid never contains '_')
--   emailHash    'system:' || <tenantId>   (never a 64-hex HMAC, so no
--                                           lookup by email can reach it)
--   passwordHash NULL
--
-- The constraints below make that shape, and the row's inability to sign in
-- or hold standing anywhere, a property of the DATABASE rather than of each
-- code path that might otherwise find it. They are additive: no existing row
-- is touched, and an old container mid-deploy never writes a 'sys_' id.

-- Preflight: nothing may already occupy the reserved namespace. Under the
-- old schema neither shape could arise (ids are cuids, hashes are hex), so
-- this refuses only a database somebody edited by hand.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "User"
        WHERE id LIKE 'sys\_%' OR "emailHash" LIKE 'system:%'
    ) THEN
        RAISE EXCEPTION 'User rows already occupy the reserved system namespace (id sys_* or emailHash system:*)';
    END IF;
END $$;

-- The row's shape: a 'sys_' id and a 'system:' hash come together or not at
-- all, the hash names the same tenant as the id, and a system row never has
-- a password. A rewrite of the row's email re-hashes it (the PII middleware
-- derives `emailHash` on every write that carries an email), which breaks
-- the second clause, so the row cannot be repointed at a real address.
ALTER TABLE "User" ADD CONSTRAINT "User_system_row_shape" CHECK (
    (id LIKE 'sys\_%') = ("emailHash" LIKE 'system:%')
    AND (
        id NOT LIKE 'sys\_%'
        OR ("emailHash" = 'system:' || substr(id, 5) AND "passwordHash" IS NULL)
    )
);

-- Never a sign-in, a membership, a credential or a session. Every path to a
-- session or a context needs a row in one of these tables (or a password,
-- refused above), so refusing the system id here closes all of them at once,
-- including any path written later.
ALTER TABLE "Account"            ADD CONSTRAINT "Account_not_system_user"            CHECK ("userId" NOT LIKE 'sys\_%');
ALTER TABLE "UserIdentityLink"   ADD CONSTRAINT "UserIdentityLink_not_system_user"   CHECK ("userId" NOT LIKE 'sys\_%');
ALTER TABLE "TenantMembership"   ADD CONSTRAINT "TenantMembership_not_system_user"   CHECK ("userId" NOT LIKE 'sys\_%');
ALTER TABLE "OrgMembership"      ADD CONSTRAINT "OrgMembership_not_system_user"      CHECK ("userId" NOT LIKE 'sys\_%');
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_not_system_user" CHECK ("userId" NOT LIKE 'sys\_%');
ALTER TABLE "UserMfaEnrollment"  ADD CONSTRAINT "UserMfaEnrollment_not_system_user"  CHECK ("userId" NOT LIKE 'sys\_%');
ALTER TABLE "UserSession"        ADD CONSTRAINT "UserSession_not_system_user"        CHECK ("userId" NOT LIKE 'sys\_%');
ALTER TABLE "Session"            ADD CONSTRAINT "Session_not_system_user"            CHECK ("userId" NOT LIKE 'sys\_%');
ALTER TABLE "TenantApiKey"       ADD CONSTRAINT "TenantApiKey_not_system_user"       CHECK ("createdById" NOT LIKE 'sys\_%');
ALTER TABLE "TenantDeviceToken"  ADD CONSTRAINT "TenantDeviceToken_not_system_user"  CHECK ("createdById" NOT LIKE 'sys\_%');
