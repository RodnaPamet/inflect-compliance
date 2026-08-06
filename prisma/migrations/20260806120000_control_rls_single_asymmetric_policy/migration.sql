-- Control RLS — replace the split policy pair with ONE asymmetric policy.
--
-- THE LEAK
-- --------
-- `Control` has a NULLABLE tenantId (global library rows carry NULL) and
-- carried the split shape that tests/guardrails/rls-coverage.test.ts
-- documents as leaky for exactly this case:
--
--   tenant_isolation        FOR ALL  USING ("tenantId" IS NULL OR own)
--   tenant_isolation_insert FOR INSERT WITH CHECK (own)
--
-- Two Postgres behaviours combine badly here:
--
--   1. A FOR ALL policy with no explicit WITH CHECK reuses its USING
--      expression as the implicit WITH CHECK. So `tenant_isolation`
--      silently permitted WRITES satisfying ("tenantId" IS NULL OR own).
--   2. Permissive policies OR together. The strict INSERT sibling could
--      therefore never *restrict* anything — it only added an alternative
--      way to pass.
--
-- Under `app_user` that permitted three cross-tenant writes:
--   - UPDATE of a global-library row (tenantId IS NULL), visible to every
--     tenant;
--   - UPDATE setting an owned row's tenantId to NULL, PROMOTING a private
--     control into the shared catalogue for every tenant;
--   - INSERT of a global row.
--
-- THE FIX
-- -------
-- One policy, asymmetric — the shape UserSession uses (Epic D.1):
--   USING      ("tenantId" IS NULL OR own)   -- reads still see the library
--   WITH CHECK (own)                          -- writes are strictly own-tenant
--
-- Dropping the INSERT sibling is required, not incidental: leaving it would
-- keep a permissive alternative that ORs back in.
--
-- superuser_bypass and FORCE ROW LEVEL SECURITY are unchanged.

DROP POLICY IF EXISTS tenant_isolation_insert ON "Control";
DROP POLICY IF EXISTS tenant_isolation ON "Control";

CREATE POLICY tenant_isolation ON "Control"
    USING (
        "tenantId" IS NULL
        OR "tenantId" = current_setting('app.tenant_id', true)::text
    )
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)::text
    );

-- Re-assert the invariants the table must keep (idempotent).
ALTER TABLE "Control" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Control" FORCE ROW LEVEL SECURITY;
