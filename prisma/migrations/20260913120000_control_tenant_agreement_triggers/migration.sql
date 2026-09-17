-- ═══════════════════════════════════════════════════════════════════
-- #2532: the four Control references #2356 could not convert.
--
-- #2356 converted 63 single-column FKs between tenant-scoped models to
-- the composite `[xId, tenantId] -> [id, tenantId]` form. Four sites
-- were split out here:
--
--     Finding.controlId              -> Control
--     Finding.compensatingControlId  -> Control
--     Task.controlId                 -> Control
--     IntegrationExecution.controlId -> Control
--
-- ─── Why these four cannot take the composite ──────────────────────
--
-- `Control.tenantId` is NULLABLE, and that is DESIGN, not drift. A row
-- with a NULL tenant is a GLOBAL LIBRARY control, visible to every
-- tenant:
--
--   * `Control_annexId_global_key` (migration 20260806130000) is a
--     PARTIAL unique index `ON "Control"("annexId") WHERE "tenantId" IS
--     NULL`, created precisely so the shared catalogue holds one control
--     per annex reference.
--   * Six read sites scope with `OR: [{tenantId: ctx.tenantId}, {tenantId: null}]`
--     (ControlRepository 275/295/348/397, DashboardRepository 347,
--     usecases/control/health.ts 66).
--   * `usecases/control/mutations.ts` refuses to update, re-status or
--     delete a row whose tenant is NULL — "Cannot delete global library
--     controls" — so the library is read-shared and write-protected.
--
-- A composite FK carrying `tenantId` cannot reference such a row: the
-- child's tenant is NOT NULL and the parent's is NULL, so every
-- reference to a library control would be refused. Converting these
-- four would not tighten the schema; it would DELETE a capability.
--
-- That exclusion has been accepted four times already — ControlException,
-- ControlTest, Evidence and ProcessNode all carry the composite and so
-- cannot point at a library control. The difference is that a FINDING or
-- a TASK against a catalogue control is a thing an auditor does.
--
-- ─── What is enforced instead ──────────────────────────────────────
--
-- The single-column FK stays (it carries the ON DELETE SET NULL these
-- four rely on). A trigger adds the tenant agreement the composite would
-- have given, with the one exemption the composite cannot express:
--
--     the referenced Control must be in the child's tenant,
--     OR be a global library control (tenantId IS NULL).
--
-- Like an FK check, this runs as the table owner and is NOT subject to
-- RLS — so it sees rows the writing session cannot, which is the point:
-- a cross-tenant reference is refused rather than silently invisible.
-- ═══════════════════════════════════════════════════════════════════

-- ── Precondition: no existing row already breaks the rule ──────────

DO $$
DECLARE
    site      RECORD;
    offenders BIGINT;
    total     BIGINT := 0;
    report    TEXT := '';
BEGIN
    FOR site IN
        SELECT * FROM (VALUES
            ('Finding',              'controlId'),
            ('Finding',              'compensatingControlId'),
            ('Task',                 'controlId'),
            ('IntegrationExecution', 'controlId')
        ) AS t(child, col)
    LOOP
        -- `p."tenantId" IS NOT NULL` is the exemption, stated here too so
        -- the pre-flight measures exactly what the trigger will enforce.
        -- A pre-flight stricter than its trigger fails migrations for rows
        -- the trigger would have allowed.
        EXECUTE format(
            'SELECT count(*) FROM %I c JOIN "Control" p ON p."id" = c.%I '
            'WHERE c.%I IS NOT NULL AND p."tenantId" IS NOT NULL '
            'AND p."tenantId" <> c."tenantId"',
            site.child, site.col, site.col
        ) INTO offenders;
        IF offenders > 0 THEN
            total := total + offenders;
            report := report || format(E'\n  %s.%s: %s row(s)', site.child, site.col, offenders);
        END IF;
    END LOOP;
    IF total > 0 THEN
        RAISE EXCEPTION
            E'#2532: % existing row(s) reference a Control owned by ANOTHER tenant.%\n\nRe-point or null them before this migration can apply.',
            total, report;
    END IF;
END
$$;

-- ── The rule ───────────────────────────────────────────────────────

-- No `USING ERRCODE`, for the reason the four-eyes and policy-card-pin
-- triggers state: this fires on the ordinary typed Prisma path, and a
-- mapped SQLSTATE reaches the caller as a foreign-key message about a
-- foreign key that does not exist. Left at P0001 the text survives.
CREATE OR REPLACE FUNCTION control_tenant_agreement()
RETURNS TRIGGER AS $$
DECLARE
    v_control_id TEXT;
    v_tenant     TEXT;
BEGIN
    -- The guarded column is named by the trigger, because `Finding` has
    -- TWO of them and a per-column function would be the same body twice.
    v_control_id := to_jsonb(NEW) ->> TG_ARGV[0];

    -- No reference is not a cross-tenant reference.
    IF v_control_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c."tenantId" INTO v_tenant FROM "Control" c WHERE c."id" = v_control_id;

    -- `FOUND`, not a sentinel: `SELECT ... INTO` sets its target to NULL
    -- when nothing matches, and NULL is also a LEGAL value here (a global
    -- control), so a `v_tenant IS NULL` test cannot tell "no such control"
    -- from "library control" — it would wave through a dangling id.
    IF NOT FOUND THEN
        -- The FK refuses this on its own; nothing to add.
        RETURN NEW;
    END IF;

    -- A global library control belongs to every tenant. This is the
    -- exemption a composite FK cannot express, and the whole reason this
    -- trigger exists instead of one.
    IF v_tenant IS NULL THEN
        RETURN NEW;
    END IF;

    IF v_tenant <> NEW."tenantId" THEN
        RAISE EXCEPTION
            'CONTROL_TENANT_MISMATCH: %.% references Control % which belongs '
            'to tenant %, but the row is in tenant %. A control can only be '
            'referenced from its own tenant, or be a global library control.',
            TG_TABLE_NAME, TG_ARGV[0], v_control_id, v_tenant, NEW."tenantId";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- `UPDATE OF` both columns, not just the pointer: re-tenanting the CHILD
-- while the pointer stands still is the same violation arriving from the
-- other side.
CREATE TRIGGER finding_control_tenant_trg
    BEFORE INSERT OR UPDATE OF "controlId", "tenantId" ON "Finding"
    FOR EACH ROW EXECUTE FUNCTION control_tenant_agreement('controlId');

CREATE TRIGGER finding_compensating_control_tenant_trg
    BEFORE INSERT OR UPDATE OF "compensatingControlId", "tenantId" ON "Finding"
    FOR EACH ROW EXECUTE FUNCTION control_tenant_agreement('compensatingControlId');

CREATE TRIGGER task_control_tenant_trg
    BEFORE INSERT OR UPDATE OF "controlId", "tenantId" ON "Task"
    FOR EACH ROW EXECUTE FUNCTION control_tenant_agreement('controlId');

CREATE TRIGGER integration_execution_control_tenant_trg
    BEFORE INSERT OR UPDATE OF "controlId", "tenantId" ON "IntegrationExecution"
    FOR EACH ROW EXECUTE FUNCTION control_tenant_agreement('controlId');

-- ── The same rule, from the parent side ────────────────────────────
--
-- The four triggers above fire on the CHILD. Moving a Control between
-- tenants, or claiming a library control for one tenant, breaks the same
-- invariant without any child row being written — and nothing would
-- notice. No code path updates `Control.tenantId` today (verified: zero
-- `control.update` sites write it), which is exactly why this is cheap:
-- it fires only on a path nothing currently takes.

CREATE OR REPLACE FUNCTION control_retenant_guard()
RETURNS TRIGGER AS $$
DECLARE
    site      RECORD;
    offenders BIGINT;
    total     BIGINT := 0;
    report    TEXT := '';
BEGIN
    IF NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId" THEN
        RETURN NEW;
    END IF;

    -- Moving a control INTO the global library can orphan nobody: every
    -- tenant may reference a library control.
    IF NEW."tenantId" IS NULL THEN
        RETURN NEW;
    END IF;

    FOR site IN
        SELECT * FROM (VALUES
            ('Finding',              'controlId'),
            ('Finding',              'compensatingControlId'),
            ('Task',                 'controlId'),
            ('IntegrationExecution', 'controlId')
        ) AS t(child, col)
    LOOP
        EXECUTE format(
            'SELECT count(*) FROM %I c WHERE c.%I = $1 AND c."tenantId" <> $2',
            site.child, site.col
        ) INTO offenders USING NEW."id", NEW."tenantId";
        IF offenders > 0 THEN
            total := total + offenders;
            report := report || format(E'\n  %s.%s: %s row(s)', site.child, site.col, offenders);
        END IF;
    END LOOP;

    IF total > 0 THEN
        RAISE EXCEPTION
            E'CONTROL_RETENANT_ORPHANS: moving Control % to tenant % would '
            'strand % reference(s) in other tenants.%',
            NEW."id", NEW."tenantId", total, report;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER control_retenant_trg
    BEFORE UPDATE OF "tenantId" ON "Control"
    FOR EACH ROW EXECUTE FUNCTION control_retenant_guard();

-- ── Post-conditions ────────────────────────────────────────────────

DO $$
DECLARE
    n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgname IN (
           'finding_control_tenant_trg',
           'finding_compensating_control_tenant_trg',
           'task_control_tenant_trg',
           'integration_execution_control_tenant_trg',
           'control_retenant_trg'
       );
    IF n <> 5 THEN
        RAISE EXCEPTION '#2532: expected 5 tenant-agreement triggers, found %', n;
    END IF;

    -- The capability this whole design exists to preserve. If the column
    -- ever became NOT NULL the triggers above would still pass their own
    -- post-condition while the library they protect had been deleted.
    IF (SELECT attnotnull FROM pg_attribute
         WHERE attrelid = '"Control"'::regclass AND attname = 'tenantId') THEN
        RAISE EXCEPTION
            '#2532: Control.tenantId is NOT NULL — the global library is gone, '
            'and these triggers are guarding an exemption that can no longer occur.';
    END IF;
END
$$;
