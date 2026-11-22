-- ═══════════════════════════════════════════════════════════════════
-- The tenant-agreement triggers actually run as the table owner (#5187)
-- ═══════════════════════════════════════════════════════════════════
--
-- Migration 20260913120000_control_tenant_agreement_triggers added five
-- triggers as the DB backstop for #2532, and its header states:
--
--     "Like an FK check, this runs as the table owner and is NOT subject
--      to RLS — so it sees rows the writing session cannot, which is the
--      point: a cross-tenant reference is refused rather than silently
--      invisible."
--
-- That was not true. Both functions were plain plpgsql with no SECURITY
-- DEFINER, so they ran as the INVOKING role. A tenant write runs under
-- `SET LOCAL ROLE app_user` with `app.tenant_id` set, and "Control" is FORCE
-- ROW LEVEL SECURITY, so:
--
--   * `control_tenant_agreement` SELECTed the referenced control and found
--     NOTHING — the foreign row is invisible, not absent. `NOT FOUND` is
--     true, the function returns NEW, and the cross-tenant reference is
--     stored. The single-column FK passes separately, because a real FK
--     check IS done as the owner and the id does exist.
--
--   * `control_retenant_guard` is worse: it counts child rows whose
--     "tenantId" <> the control's new tenant — exactly the rows RLS hides
--     from app_user — so `offenders` was always 0 and the guard was
--     entirely vacuous for the only role that reaches it.
--
-- So the backstop refused only when the writer could ALREADY see the other
-- tenant's row, i.e. a privileged session: the one case needing no backstop.
-- It was a dead defence-in-depth layer whose comment claimed otherwise, which
-- is the part that does harm — the next person to add a write path reads that
-- header and believes the database is checking.
--
-- Nothing was leaking: `finding.ts` (an inline `tenantId: ctx.tenantId`
-- lookup that throws on a miss) and `task.ts` (`assertRefInTenant`) check
-- tenancy in the app, and every IntegrationExecution writer sets controlId
-- from a control it just read in-tenant. This restores the layer underneath
-- them rather than fixing a live hole.
--
-- ─── Why the existing test did not catch it ────────────────────────
--
-- tests/integration/control-tenant-agreement-triggers.test.ts drives
-- `prismaTestClient()`, a privileged session. Every REFUSES case there
-- exercised the one path that worked. Its app_user companion tests are added
-- with this migration, and they reproduce the acceptance before it.
--
-- ─── What changes ──────────────────────────────────────────────────
--
-- 1. Both functions become SECURITY DEFINER, so the lookup genuinely runs as
--    the owner and the header's claim becomes true. `SET search_path = public`
--    is mandatory on a SECURITY DEFINER function: without it the caller's
--    search_path decides which "Control" is read, which is a privilege
--    escalation in a function that now runs as the owner. It also excludes
--    pg_temp, so a caller cannot shadow a name with a temp table.
--
-- 2. `NOT FOUND` still returns NEW, and now means what it says. Once the
--    SELECT is unrestricted, the only way to find nothing is that no such
--    control exists — which the FK refuses on its own, as the original
--    comment reasoned. The branch was never wrong; its premise was.
--
-- 3. The refusal message no longer names the OWNING tenant. Making a dead
--    backstop live would otherwise turn it into an oracle: a caller who
--    reaches the trigger with an arbitrary control id would learn which
--    tenant owns it. Table, column and control id are all things the caller
--    already supplied, so they stay — the existing tests assert on
--    CONTROL_TENANT_MISMATCH and the control id, not on the tenant.
--
-- Neither function does dynamic SQL on caller-supplied text:
-- `control_retenant_guard`'s `format()` interpolates `%I` from a fixed
-- VALUES list, and its values are bound as $1/$2.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION control_tenant_agreement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_control_id TEXT;
    v_tenant     TEXT;
    v_found      BOOLEAN;
BEGIN
    -- The guarded column is named by the trigger, because `Finding` has
    -- TWO of them and a per-column function would be the same body twice.
    v_control_id := to_jsonb(NEW) ->> TG_ARGV[0];

    -- No reference is not a cross-tenant reference.
    IF v_control_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c."tenantId" INTO v_tenant FROM "Control" c WHERE c."id" = v_control_id;
    v_found := FOUND;

    -- `FOUND`, not a sentinel: `SELECT ... INTO` sets its target to NULL
    -- when nothing matches, and NULL is also a LEGAL value here (a global
    -- control), so a `v_tenant IS NULL` test cannot tell "no such control"
    -- from "library control" — it would wave through a dangling id.
    --
    -- This now runs as the OWNER (SECURITY DEFINER), so "nothing matches"
    -- finally means no such row rather than no row I may see. Before that,
    -- every foreign control took this branch.
    IF NOT v_found THEN
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
        -- Deliberately does NOT name the owning tenant: see point 3 above.
        RAISE EXCEPTION
            'CONTROL_TENANT_MISMATCH: %.% references Control % which belongs '
            'to a different tenant. A control can only be referenced from its '
            'own tenant, or be a global library control.',
            TG_TABLE_NAME, TG_ARGV[0], v_control_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION control_retenant_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    -- Runs as the owner now, so these counts see the OTHER tenants' rows.
    -- That is the whole point: the rows this looks for are by definition the
    -- ones RLS hides from the session doing the update.
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
$$;

-- ── Post-conditions ────────────────────────────────────────────────
--
-- The whole point of this migration is a property of the function's
-- DEFINITION, which no behavioural test on a privileged session can see —
-- that is how the original shipped. Assert it here, at the source.

DO $$
DECLARE
    n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM pg_proc
     WHERE proname IN ('control_tenant_agreement', 'control_retenant_guard')
       AND pronamespace = 'public'::regnamespace
       AND prosecdef;
    IF n <> 2 THEN
        RAISE EXCEPTION
            '#5187: expected both tenant-agreement functions to be SECURITY '
            'DEFINER, found % of 2. Without it they run as app_user and RLS '
            'hides the very rows they exist to find.', n;
    END IF;

    -- A SECURITY DEFINER function with a caller-controlled search_path is a
    -- privilege escalation, so the pin is as load-bearing as the flag.
    SELECT count(*) INTO n FROM pg_proc
     WHERE proname IN ('control_tenant_agreement', 'control_retenant_guard')
       AND pronamespace = 'public'::regnamespace
       AND proconfig @> ARRAY['search_path=public'];
    IF n <> 2 THEN
        RAISE EXCEPTION
            '#5187: expected both functions to pin search_path=public, found % '
            'of 2.', n;
    END IF;

    -- The triggers bind by name, so CREATE OR REPLACE keeps them attached.
    -- Assert that rather than assume it.
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
        RAISE EXCEPTION '#5187: expected 5 tenant-agreement triggers, found %', n;
    END IF;
END
$$;
