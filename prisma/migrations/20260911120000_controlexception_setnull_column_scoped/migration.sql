-- ═══════════════════════════════════════════════════════════════════
-- ControlException: two composite SET NULL foreign keys that abort the
-- parent delete with SQLSTATE 23502 instead of nulling the reference.
--
-- ─── The defect ────────────────────────────────────────────────────
--
-- 20260507140000_epic_g5_control_exceptions declared two composite FKs
-- ON DELETE SET NULL:
--
--   ControlException_compensatingControlId_tenantId_fkey
--       ("compensatingControlId", "tenantId") -> Control(id, tenantId)
--   ControlException_renewedFromId_tenantId_fkey
--       ("renewedFromId", "tenantId") -> ControlException(id, tenantId)
--
-- Postgres SET NULL over a MULTI-COLUMN foreign key nulls EVERY
-- referencing column, not just the one that points at the parent. Both
-- of these carry `tenantId`, which is NOT NULL. So the referential
-- action itself writes an illegal row and the parent delete aborts:
--
--   ERROR:  23502: null value in column "tenantId" of relation
--           "ControlException" violates not-null constraint
--   CONTEXT: SQL statement "UPDATE ONLY "public"."ControlException"
--            SET "compensatingControlId" = NULL, "tenantId" = NULL
--            WHERE $1 = "compensatingControlId" AND $2 = "tenantId""
--
-- Note the trap for whoever debugs this: it surfaces as a NOT NULL
-- violation naming `tenantId` — a column the failing DELETE never
-- mentioned — not as a foreign-key error. The CONTEXT line is the only
-- thing that points at the FK.
--
-- This is the hazard #2356 knew about and deliberately steered around;
-- 20260907120000_tenant_scoped_fks_composite_mechanical says so in its
-- own header ("SET NULL nulls every referencing column, and `tenantId`
-- is NOT NULL ... a real behavioural decision per site"). These two
-- constraints predate that sweep (2026-05-07) and were never revisited,
-- so they are the two sites where the composite shape and SetNull did
-- in fact get combined.
--
-- ─── Reachability ──────────────────────────────────────────────────
--
-- Both are live today, from two paths that hard-delete the parent with
-- raw SQL — which bypasses the soft-delete client extension, and with
-- it any application-side referential handling:
--
--   1. POST /api/t/[tenantSlug]/controls/[controlId]/purge
--      -> purgeControl -> purgeEntity (usecases/soft-delete-operations.ts)
--         DELETE FROM "Control" WHERE "id" = $1 AND "tenantId" = $2
--
--   2. The unattended data-lifecycle sweep, purgeSoftDeletedOlderThan
--      (jobs/data-lifecycle.ts)
--         DELETE FROM "Control" WHERE "id" = $1
--
-- The reachable row shape is ordinary, not contrived: an exception on
-- control A that names control B as its compensating control. Nothing
-- protects B — `controlId` is RESTRICT and points at A — so purging B
-- runs the SET NULL action and hits 23502. requestException's zod
-- superRefine REQUIRES A <> B, so this is the only shape the API can
-- produce with a compensating control set at all.
--
-- Blast radius on path 2 is the whole sweep, not one row: the per-row
-- DELETE loop has no try/catch and `runJob` logs and re-throws. The
-- model loop walks SOFT_DELETE_MODELS in insertion order and `Control`
-- is third of thirteen, so one un-purgeable control also stops Evidence,
-- Policy, Vendor, FileRecord, Task, Finding, Audit, AuditCycle,
-- AuditPack and ControlTestPlan from ever being swept.
--
-- ─── Why SET NULL (column), not RESTRICT ───────────────────────────
--
-- Postgres 15+ supports `ON DELETE SET NULL (colName)`, which nulls
-- only the named column and leaves NOT NULL `tenantId` intact. That is
-- what this migration installs, because it is what the code already
-- means:
--
--   • The original migration states the renewal intent outright:
--     "SetNull on cascade so deleting the prior row doesn't shred the
--     renewal record (the audit log carries the lineage)." The delete is
--     MEANT to succeed and the renewal row MEANT to survive.
--
--   • `controlId` (RESTRICT) and `compensatingControlId` (SET NULL)
--     point at the SAME table with DIFFERENT actions. That is a designed
--     distinction, not an oversight: you may not purge the control an
--     exception is ABOUT, but purging a merely-compensating control just
--     drops the pointer. RESTRICT would erase that distinction.
--
--   • The purge route exists to succeed. It is an admin-gated
--     "irreversible hard-delete" whose only precondition is that the row
--     is already soft-deleted. There is no pre-flight reference check,
--     no catch, and no "still referenced" error anywhere on the path —
--     nothing in the design anticipates a referential refusal.
--
-- RESTRICT would be expressible in Prisma's DSL and would remove the
-- schema/DB divergence recorded below, but it would MOVE the failure
-- rather than fix it: the sweep would abort on 23503 exactly where it
-- now aborts on 23502, with the same blast radius, and an admin who
-- soft-deleted a control would find it unpurgeable for as long as any
-- unrelated exception happens to name it as compensating. #2356's own
-- header calls SetNull -> Restrict "a real behavioural decision per
-- site" rather than a mechanical standardisation, and at these two sites
-- the evidence points the other way.
--
-- Tenant isolation is fully preserved. The FKs stay composite and
-- tenant-carrying, so a cross-tenant reference remains unrepresentable
-- (measured: writing a foreign tenant's control id into
-- `compensatingControlId` is still refused, with 23503). Only the
-- referential ACTION's column list changes.
--
-- ─── Deliberate schema/DB divergence ───────────────────────────────
--
-- Prisma's DSL has no syntax for a column-scoped SET NULL, so
-- prisma/schema/controls.prisma cannot express what this migration
-- installs. The two relations there carry no `onDelete`, and because
-- their FK includes the required `tenantId`, Prisma renders them as
-- `ON DELETE RESTRICT`.
--
-- That divergence is therefore NOT new — it already exists on
-- origin/main, where the DB says plain SET NULL and the schema says
-- RESTRICT. Measured with
--   prisma migrate diff --from-config-datasource --to-schema prisma/schema --script
-- against a fresh DB built from prisma/migrations, before and after this
-- migration: both runs emit the SAME 181-line script containing the SAME
-- four ControlException statements. Prisma's introspection cannot see a
-- SET NULL column list at all, so this migration changes the expected
-- drift residue not one byte.
--
-- The guardrail that holds the DB side of this contract is
-- tests/integration/control-exception-purge-contract.test.ts, which
-- exercises the DELETE rather than reading the constraint definition.
--
-- Rollback: restore the plain `ON DELETE SET NULL` constraints — which
-- restores the 23502. This repo forward-fixes
-- (docs/change-management-policy.md).
-- ═══════════════════════════════════════════════════════════════════

-- ── Precondition: column-scoped SET NULL needs Postgres 15+ ────────
--
-- A named refusal rather than a bare syntax error 20 lines down. Every
-- compose file and CI service in this repo pins postgres:16-alpine.

DO $$
BEGIN
    IF current_setting('server_version_num')::int < 150000 THEN
        RAISE EXCEPTION
            'ControlException SET NULL fix needs Postgres 15+ for "ON DELETE SET NULL (column)"; this server is %',
            current_setting('server_version');
    END IF;
END
$$;

-- ── compensatingControlId -> Control ───────────────────────────────

ALTER TABLE "ControlException"
    DROP CONSTRAINT "ControlException_compensatingControlId_tenantId_fkey";

ALTER TABLE "ControlException"
    ADD CONSTRAINT "ControlException_compensatingControlId_tenantId_fkey"
    FOREIGN KEY ("compensatingControlId", "tenantId") REFERENCES "Control"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("compensatingControlId");

-- ── renewedFromId -> ControlException (self-referential) ───────────

ALTER TABLE "ControlException"
    DROP CONSTRAINT "ControlException_renewedFromId_tenantId_fkey";

ALTER TABLE "ControlException"
    ADD CONSTRAINT "ControlException_renewedFromId_tenantId_fkey"
    FOREIGN KEY ("renewedFromId", "tenantId") REFERENCES "ControlException"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("renewedFromId");

-- ── Post-condition: the column list actually landed ────────────────
--
-- `confdeltype = 'n'` alone does NOT distinguish the fix from the bug —
-- plain SET NULL and column-scoped SET NULL are both 'n'. The
-- difference is `confdelsetcols`, NULL for a whole-row SET NULL and
-- holding the scoped columns' attnums otherwise. Asserting the exact
-- scoped column here means a silently-degraded ALTER cannot ship green.

DO $$
DECLARE
    expected  RECORD;
    scoped    TEXT;
    deltype   "char";
    ncols     INTEGER;
BEGIN
    FOR expected IN
        SELECT * FROM (VALUES
            ('ControlException_compensatingControlId_tenantId_fkey', 'compensatingControlId'),
            ('ControlException_renewedFromId_tenantId_fkey',         'renewedFromId')
        ) AS t(conname, col)
    LOOP
        SELECT c.confdeltype,
               array_length(c.confdelsetcols, 1),
               (SELECT a.attname FROM pg_attribute a
                 WHERE a.attrelid = c.conrelid
                   AND a.attnum = c.confdelsetcols[1])
          INTO deltype, ncols, scoped
          FROM pg_constraint c
         WHERE c.conrelid = '"ControlException"'::regclass
           AND c.contype = 'f'
           AND c.conname = expected.conname;

        IF deltype IS NULL THEN
            RAISE EXCEPTION 'ControlException SET NULL fix: constraint % is missing', expected.conname;
        END IF;

        IF deltype <> 'n' OR ncols IS DISTINCT FROM 1 OR scoped IS DISTINCT FROM expected.col THEN
            RAISE EXCEPTION
                'ControlException SET NULL fix did not land column-scoped on %: expected confdeltype=n with exactly one scoped column %, got confdeltype=%, scoped column count=%, scoped column=%',
                expected.conname, expected.col, deltype, ncols, scoped;
        END IF;
    END LOOP;
END
$$;
