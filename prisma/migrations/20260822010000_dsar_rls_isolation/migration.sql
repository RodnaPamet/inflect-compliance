-- DataSubjectRequest — close a silent isolation hole.
--
-- The table shipped in 20260626130000 with NO row-level security: no
-- ENABLE, no FORCE, no policy. Verified against a live migrated database
-- before writing this — `pg_policies` returns zero rows for it and
-- `relrowsecurity/relforcerowsecurity` are both false.
--
-- WHY NOTHING CAUGHT IT. The model is deliberately USER-scoped (see the
-- comment at prisma/schema/auth.prisma:1521): a DSAR concerns a person,
-- not a tenant, so it carries no `tenantId` column. Both halves of the
-- isolation guarantee are keyed on exactly that column:
--
--   * `enumerateDirectTenantScopedModels()` filters the DMMF on a
--     `tenantId` field, so DSAR was never enumerated.
--   * `OWNERSHIP_CHAINED_MODELS` — the hand-curated other half — did not
--     list it.
--
-- So `TENANT_SCOPED_MODELS` excluded it, which made it invisible to
-- `rls-coverage.test.ts` (whose entire population is that set) AND to the
-- Prisma tripwire, which short-circuits before the missing-context warn
-- for any model the predicate rejects. The guard was not bypassed; the
-- table was never in its denominator. Same shape as the
-- PolicyAcknowledgementAssignment entry that precedes this one.
--
-- NOT A LIVE LEAK TODAY. `dsar-register.ts` is the only module that
-- touches the model, and all three of its functions apply
-- `scopedToTenantMembers()`. `tests/integration/dsar-register-isolation.test.ts`
-- is a real two-tenant behavioural control over that. What was missing is
-- the DB backstop underneath it — so a FOURTH access path (a new usecase,
-- an export, a report) could read across tenants with nothing to stop it
-- and nothing even to log it.
--
-- THE PREDICATE MIRRORS THE APPLICATION'S. `scopedToTenantMembers()` is
--     user.tenantMemberships.some({ tenantId, status: 'ACTIVE' })
-- and the policy below is that same statement in SQL, so this migration
-- is a no-op for every query the app makes today. A subject who belongs
-- to two tenants stays visible to both, which is correct: their request
-- is legitimately the business of each.
--
-- THE QUALIFIED REFERENCE ON LINE `m."userId" = "DataSubjectRequest"."userId"`
-- IS LOAD-BEARING. `TenantMembership` has its own `userId` column, so an
-- unqualified `"userId"` inside the subquery resolves to the INNER
-- relation — making the condition `m."userId" = m."userId"`, which is
-- true for every row and would turn this policy into a no-op that still
-- reads like isolation. The PolicyAcknowledgementAssignment precedent
-- could safely use a bare column name because `PolicyVersion` has no
-- `policyVersionId`; that is not the case here.
--
-- ROLLBACK.
--   DROP POLICY IF EXISTS tenant_isolation ON "DataSubjectRequest";
--   DROP POLICY IF EXISTS superuser_bypass ON "DataSubjectRequest";
--   ALTER TABLE "DataSubjectRequest" NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE "DataSubjectRequest" DISABLE ROW LEVEL SECURITY;
-- Reverting restores the pre-migration state exactly; the application
-- keeps working either way because its own predicate is unchanged.

ALTER TABLE "DataSubjectRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DataSubjectRequest" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "DataSubjectRequest";
CREATE POLICY tenant_isolation ON "DataSubjectRequest"
    USING (
        EXISTS (
            SELECT 1 FROM "TenantMembership" m
            WHERE m."userId"   = "DataSubjectRequest"."userId"
              AND m."tenantId" = current_setting('app.tenant_id', true)::text
              AND m."status"   = 'ACTIVE'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM "TenantMembership" m
            WHERE m."userId"   = "DataSubjectRequest"."userId"
              AND m."tenantId" = current_setting('app.tenant_id', true)::text
              AND m."status"   = 'ACTIVE'
        )
    );

DROP POLICY IF EXISTS superuser_bypass ON "DataSubjectRequest";
CREATE POLICY superuser_bypass ON "DataSubjectRequest"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "DataSubjectRequest" TO app_user;
