-- #4576, deploy 2 of 2 — EVERY ORGANIZATION GETS AN OWNER, AND KEEPS ONE.
--
-- Deploy 1 (20261030140000) added ORG_OWNER and shipped code that reads it: an
-- owner is at least an admin, and an owner's membership is changed only by an
-- owner. That code is what is running while this migration applies, so the
-- owners written below are handled correctly by every container in the roll.
--
-- ─── The backfill (owner decision, 2026-10-30) ──────────────────────
--
-- In every organization that has an ORG_ADMIN and no ORG_OWNER, the ORG_ADMIN
-- who joined FIRST becomes its owner: earliest `createdAt`, then lowest `id`,
-- so a tie is broken the same way on every run. An organization with no
-- ORG_ADMIN at all gets no owner; nobody there administers it today either.
-- Idempotent: an organization that already has an owner is skipped.
--
-- The org audit chain is hash-chained in application code, so this migration
-- cannot append to it. The promotion is recorded here; each later change to an
-- owner is audited by the usecase that makes it.
UPDATE "OrgMembership" AS m
SET "role" = 'ORG_OWNER'
FROM (
    SELECT DISTINCT ON ("organizationId") "id"
    FROM "OrgMembership"
    WHERE "role" = 'ORG_ADMIN'
      AND "organizationId" NOT IN (
          SELECT "organizationId" FROM "OrgMembership" WHERE "role" = 'ORG_OWNER'
      )
    ORDER BY "organizationId", "createdAt" ASC, "id" ASC
) AS first_admin
WHERE m."id" = first_admin."id";

-- ─── The last-owner guard (owner decision, 2026-10-30) ──────────────
--
-- The usecase refuses to demote or remove an organization's last owner; this
-- is the backstop for every other writer (a raw `deleteMany`, a path that
-- forgets the check), the shape `tenant_membership_last_owner_guard` gives
-- tenants. It fires only when an OWNER row stops being one.
--
-- Deleting the ORGANIZATION is not refused: its memberships go by ON DELETE
-- CASCADE after the organization row itself, so the parent is already gone
-- when this runs for them, and an organization that no longer exists has no
-- owner to keep.
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

DROP TRIGGER IF EXISTS org_membership_last_owner_guard ON "OrgMembership";
CREATE TRIGGER org_membership_last_owner_guard
BEFORE UPDATE OR DELETE ON "OrgMembership"
FOR EACH ROW EXECUTE FUNCTION check_not_last_org_owner();
