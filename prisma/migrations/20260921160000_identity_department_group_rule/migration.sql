-- JML joiner Phase 2a — the department → security-group entitlement map (#2713).
--
-- Until this table exists every joiner plan refuses NO_DEPARTMENT_MAP, and that
-- refusal is one an operator cannot clear: there is nowhere to put the map.
--
-- Owner decision 10 was REVISED on 2026-09-21. The original wording put the map
-- on TenantSecuritySettings; that did not survive contact with what the planner
-- consumes. `departmentGroups` is a LIST wanting per-rule provenance and audit,
-- which is a table. `defaultGroupId` is SINGULAR per tenant and stayed a column
-- on TenantSecuritySettings, where it inherits the OWNER gate.

CREATE TABLE "IdentityDepartmentGroupRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupName" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityDepartmentGroupRule_pkey" PRIMARY KEY ("id")
);

-- One rule per department per tenant: two rules for one department is a
-- contradiction, not a tie to break.
CREATE UNIQUE INDEX "IdentityDepartmentGroupRule_tenantId_department_key"
    ON "IdentityDepartmentGroupRule"("tenantId", "department");

CREATE INDEX "IdentityDepartmentGroupRule_tenantId_idx"
    ON "IdentityDepartmentGroupRule"("tenantId");

ALTER TABLE "IdentityDepartmentGroupRule"
    ADD CONSTRAINT "IdentityDepartmentGroupRule_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS TRIO. A new tenant-scoped model owes all three; `TENANT_SCOPED_MODELS` is
-- derived from the DMMF, so this table is RLS-enforced the moment it has a
-- tenantId, and tests/guardrails/rls-coverage.test.ts fails without these.
ALTER TABLE "IdentityDepartmentGroupRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityDepartmentGroupRule" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "IdentityDepartmentGroupRule"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

CREATE POLICY tenant_isolation_insert ON "IdentityDepartmentGroupRule"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

CREATE POLICY superuser_bypass ON "IdentityDepartmentGroupRule"
    USING (current_setting('role') != 'app_user');

-- The SINGULAR fallback, and its NAME. Decision 5 binds the name: "a typo'd or
-- brand-new department is otherwise indistinguishable from a mapped one", so a
-- plan that fell back can say WHICH group it fell back to. Nullable with no
-- default — absent means "no fallback configured", which the planner reports as
-- NO_DEFAULT_GROUP rather than silently picking something.
ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN "identityDefaultGroupId" TEXT,
    ADD COLUMN "identityDefaultGroupName" TEXT;
