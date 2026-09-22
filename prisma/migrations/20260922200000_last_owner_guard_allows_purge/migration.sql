-- #2747 — the last-OWNER guard must not block a tenant purge.
--
-- `check_not_last_owner` is a deliberate backstop: "even a misbehaving usecase
-- cannot orphan a tenant" (20260424220000). That reasoning is intact and this
-- migration does not weaken it for any live tenant.
--
-- But a tenant PURGE legitimately removes every membership, and the guard
-- rejected it with
--
--     P0001  LAST_OWNER_GUARD: tenant … would have zero active OWNERs
--
-- found by running the purge against a real schema rather than a dry run —
-- the dry run passed, because counting rows never fires a trigger.
--
-- A soft-deleted tenant with zero owners is not an orphan. It is a closed
-- account, and orphaning is the point. So the guard now exempts exactly that
-- case: `Tenant.deletedAt IS NOT NULL`. A live tenant is protected exactly as
-- before, and the exemption cannot be reached without first soft-deleting the
-- tenant through the org plane.
--
-- Function replace only. No enum additions, no table DDL — nothing here can
-- land half-applied (see docs/runbooks/failed-migration-recovery.md).

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

    -- THE EXEMPTION, AND THE ONLY CHANGE IN THIS MIGRATION.
    -- A soft-deleted tenant is being wound down; leaving it without an owner
    -- is the intended end state, not an accident to be prevented.
    IF EXISTS (
        SELECT 1 FROM "Tenant"
         WHERE "id" = affected_tenant AND "deletedAt" IS NOT NULL
    ) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

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
