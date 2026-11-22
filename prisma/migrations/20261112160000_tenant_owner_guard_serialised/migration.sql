-- #5388 — the tenant last-OWNER guard SERIALISES per tenant before it counts.
--
-- `check_not_last_owner` (latest body: 20260922200000) counted the tenant's
-- other ACTIVE OWNER rows under READ COMMITTED with no lock. Two OWNERs
-- demoting (or deactivating, or removing) each other at once each locked a
-- DIFFERENT row, each count still saw the other row as an ACTIVE OWNER, both
-- commits went through, and the tenant was left with no ACTIVE OWNER — the
-- state the guard exists to refuse.
--
-- The fix: before counting, take a transaction-scoped advisory lock keyed on
-- the tenant, `hashtext('tenant-owner:' || tenantId)`. The member usecases
-- (`src/app-layer/usecases/tenant-admin.ts`), the ownership transfer
-- (`tenant-lifecycle.ts`) and the access-review close take the SAME key first
-- in their transaction, before their own counts, so the two layers queue on
-- one lock and the usecase's re-entry here is free (advisory locks stack
-- within a transaction). The `tenant-owner:` namespace is distinct from the
-- audit chain's bare `hashtext(tenantId)` key so the two never contend. It
-- mirrors the org guard's `org-owner:` (20261112130500, #5373).
--
-- Why the count then sees the other change: in PL/pgSQL under READ COMMITTED
-- every SQL statement in a VOLATILE function takes a fresh snapshot. The
-- COUNT below runs after `pg_advisory_xact_lock` returns, i.e. after the
-- transaction that held the lock committed, so it sees that demotion. (A
-- STABLE function would reuse the calling statement's snapshot and the lock
-- would be decorative — keep this function VOLATILE, the default.)
--
-- The lock is taken only when an ACTIVE OWNER stops being one in a live
-- tenant, after the early returns and after the soft-deleted-tenant exemption
-- (#2747), so ordinary membership writes and the tenant purge never queue on
-- it. Everything else — the exemption, the error text, SQLSTATE P0001 — is
-- unchanged.
--
-- Function replace only. No table DDL, no enum change, the trigger
-- `tenant_membership_last_owner_guard` is untouched (it already points at this
-- function by name). Nothing here can land half-applied.

CREATE OR REPLACE FUNCTION check_not_last_owner()
RETURNS TRIGGER AS $$
DECLARE
    owner_count INT;
    affected_tenant TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Care only about OWNER being demoted or deactivated.
        IF OLD.role = 'OWNER' AND OLD.status = 'ACTIVE'
           AND (NEW.role != 'OWNER' OR NEW.status != 'ACTIVE') THEN
            affected_tenant := OLD."tenantId";
        ELSE
            RETURN NEW;
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.role = 'OWNER' AND OLD.status = 'ACTIVE' THEN
            affected_tenant := OLD."tenantId";
        ELSE
            RETURN OLD;
        END IF;
    END IF;

    -- A soft-deleted tenant is being wound down; leaving it without an owner
    -- is the intended end state, not an accident to be prevented (#2747).
    IF EXISTS (
        SELECT 1 FROM "Tenant"
         WHERE "id" = affected_tenant AND "deletedAt" IS NOT NULL
    ) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    -- THE CHANGE IN THIS MIGRATION: queue behind any other owner change in
    -- this tenant, so the count below reads its committed result.
    PERFORM pg_advisory_xact_lock(hashtext('tenant-owner:' || affected_tenant));

    SELECT COUNT(*) INTO owner_count
    FROM "TenantMembership"
    WHERE "tenantId" = affected_tenant
      AND "role" = 'OWNER'
      AND "status" = 'ACTIVE'
      AND "id" != OLD."id";

    IF owner_count < 1 THEN
        RAISE EXCEPTION 'LAST_OWNER_GUARD: tenant % would have zero active OWNERs', affected_tenant
            USING ERRCODE = 'P0001';
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
