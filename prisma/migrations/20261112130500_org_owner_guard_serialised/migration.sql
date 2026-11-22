-- #5373 — the org last-owner guard SERIALISES per organization before it counts.
--
-- `check_not_last_org_owner` (20261030160000) counted the organization's other
-- ORG_OWNER rows under READ COMMITTED with no lock. Two owners demoting each
-- other at once each locked a DIFFERENT row, each count still saw the other
-- row as ORG_OWNER, both commits went through, and the organization was left
-- with no owner — the state the guard exists to refuse.
--
-- The fix: before counting, take a transaction-scoped advisory lock keyed on
-- the organization, `hashtext('org-owner:' || organizationId)`. The usecase
-- (`src/app-layer/usecases/org-members.ts`) takes the SAME key in its
-- transaction before its own count, so the two layers queue on one lock and
-- the usecase's re-entry here is free (advisory locks stack within a
-- transaction). The `org-owner:` namespace is distinct from the org audit
-- chain's `org:` key so the two never contend.
--
-- Why the count then sees the other change: in PL/pgSQL under READ COMMITTED
-- every SQL statement in a VOLATILE function takes a fresh snapshot. The
-- COUNT below runs after `pg_advisory_xact_lock` returns, i.e. after the
-- transaction that held the lock committed, so it sees that demotion. (A
-- STABLE function would reuse the calling statement's snapshot and the lock
-- would be decorative — keep this function VOLATILE, the default.)
--
-- The lock is taken only when an ORG_OWNER row stops being one, after the
-- early returns, so ordinary membership writes never queue on it. Everything
-- else — the organization-cascade exemption, the error text, SQLSTATE P0001 —
-- is unchanged.
--
-- Function replace only. No table DDL, no enum change, the trigger itself is
-- untouched (it already points at this function by name).

CREATE OR REPLACE FUNCTION check_not_last_org_owner()
RETURNS TRIGGER AS $$
DECLARE
    owner_count INT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NOT (OLD."role" = 'ORG_OWNER' AND NEW."role" <> 'ORG_OWNER') THEN
            RETURN NEW;
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD."role" <> 'ORG_OWNER' THEN
            RETURN OLD;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId") THEN
            RETURN OLD;
        END IF;
    END IF;

    -- THE CHANGE IN THIS MIGRATION: queue behind any other owner change in
    -- this organization, so the count below reads its committed result.
    PERFORM pg_advisory_xact_lock(hashtext('org-owner:' || OLD."organizationId"));

    SELECT COUNT(*) INTO owner_count
    FROM "OrgMembership"
    WHERE "organizationId" = OLD."organizationId"
      AND "role" = 'ORG_OWNER'
      AND "id" <> OLD."id";

    IF owner_count < 1 THEN
        RAISE EXCEPTION 'LAST_ORG_OWNER_GUARD: organization % would have no ORG_OWNER', OLD."organizationId"
            USING ERRCODE = 'P0001';
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
