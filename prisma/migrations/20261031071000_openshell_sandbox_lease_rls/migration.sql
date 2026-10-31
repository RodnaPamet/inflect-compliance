-- Row level security for `OpenShellSandboxLease` — #4568.
--
-- A SECOND migration rather than an edit to the one that creates the table,
-- because that one was already applied: editing applied SQL leaves two
-- histories, one in the file and one in the database, and the file wins only
-- for whoever has not run it yet.
--
-- The lease is what the kill switch reads to decide what to delete. A read that
-- crossed tenants would hand one tenant's sandbox ids to another's kill, and a
-- WRITE that crossed would open a lease nobody's kill can reach. Both are
-- refused in the database and not only in the query, which is why the lease
-- writes run inside `runInTenantContext` rather than on the global client.
ALTER TABLE "OpenShellSandboxLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OpenShellSandboxLease" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "OpenShellSandboxLease";
CREATE POLICY tenant_isolation ON "OpenShellSandboxLease"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "OpenShellSandboxLease";
CREATE POLICY tenant_isolation_insert ON "OpenShellSandboxLease"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "OpenShellSandboxLease";
CREATE POLICY superuser_bypass ON "OpenShellSandboxLease"
    USING (current_setting('role') != 'app_user');
