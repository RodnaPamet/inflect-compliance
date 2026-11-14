-- #5314 — LegacyMatchVerdict's superuser_bypass keyed on the tenant GUC, not the role.
--
-- Migration 20261010120000_legacy_match_verdict created this table's
-- `superuser_bypass` policy as
--
--     USING (current_setting('app.tenant_id', true) IS NULL
--         OR current_setting('app.tenant_id', true) = '')
--
-- instead of the canonical `current_setting('role') != 'app_user'` that every
-- other table carries (docs/rls-tenant-isolation.md). Being permissive, it
-- admitted an `app_user` session that had NOT bound a tenant — the exact
-- session every other table returns zero rows to — to read and insert every
-- tenant's verdicts. Every current app_user entry point binds a tenant, so this
-- restores a lost backstop rather than closing a reachable leak.
--
-- Applied migrations are never edited, so the fix is this forward migration:
-- recreate the policy in the canonical shape. Idempotent. The postgres-role
-- paths (migrations, seeds, sweeps) are admitted exactly as before.
-- Rollback: forward-fix only (docs/change-management-policy.md); the old shape
-- is the one this migration exists to remove.

DROP POLICY IF EXISTS superuser_bypass ON "LegacyMatchVerdict";
CREATE POLICY superuser_bypass ON "LegacyMatchVerdict"
    USING (current_setting('role') != 'app_user');
