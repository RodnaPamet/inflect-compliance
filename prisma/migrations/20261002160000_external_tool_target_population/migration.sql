-- ═══════════════════════════════════════════════════════════════════
-- THE TARGET POPULATION — bounding WHICH ROW an agent may write to
-- (#3051 step 5c — part of #2861's external-write ladder)
--
-- Step 5b opened VALUE fields: the agent chooses an argument within a typed
-- constraint a reviewer read. This opens the TARGET — the argument that says
-- which row the write is about. Issue #3051's own question 5 calls that "the
-- step that makes an agent able to touch a row nobody reviewed", so everything
-- below is arranged around the refusals rather than the happy path.
--
-- ── WHY A NAMED POPULATION, AND WHY CODE-DEFINED ────────────────────
--
-- Owner decision 1 rejected bounding the target with a pattern: approving
-- `^[0-9]+$` on an employee number approves EVERY employee, and a reviewer
-- reading that pattern is unlikely to see it. The owner's follow-on ruling
-- (2026-10-02) settled what "bounded by data" means — a CODE-DEFINED registry of
-- named populations, not an operator-authored saved query, because a stored
-- predicate has exactly the property that made the pattern unreviewable. A
-- registry entry can only be widened by a code change somebody reviews. The
-- accepted cost is that a new population needs a deploy, not a console action.
--
-- The registry itself is `src/app-layer/usecases/external-tool-target-populations.ts`.
-- The database stores only the KEY, and deliberately cannot validate it: an
-- unknown key fails CLOSED at dispatch (`external_target_population_unknown`),
-- which is also what makes removing an entry safe — every template naming it
-- becomes undispatchable rather than unbounded.
--
-- ── WHAT LANDS HERE ─────────────────────────────────────────────────
--
--   1. "targetPopulation" / "pendingTargetPopulation", nullable with no
--      default, so every existing row is a template with no open target.
--   2. Three CHECKs that make the two halves of a target agree: which ARGUMENT
--      (a `{"kind":"target"}` entry in "openFields") and which POPULATION (the
--      new column) are each stored exactly once, and neither may exist without
--      the other.
--   3. A replacement four-eyes trigger function, so the new column moves ONLY
--      by promoting exactly what was pending — the same path "openFields" takes.
--   4. A replacement signature-guard function, so "is this row a template" also
--      counts a target.
--
-- ── WHY CREATE OR REPLACE AND NOT AN EDIT TO THE EARLIER MIGRATIONS ──
--
-- `20261002120000` and `20261002130000` are APPLIED. Prisma checksums each
-- migration, so editing either breaks every existing database including CI's.
-- `CREATE OR REPLACE FUNCTION` makes the replacement exact: the triggers keep
-- pointing at the same two names, and a fresh database applying all three
-- migrations in order ends in the same state as one applying only this one on
-- top of the second.
--
-- ── ROLLING-DEPLOY SAFETY ───────────────────────────────────────────
--
--   • No `ALTER TYPE`, no new enum: an enum value added mid-deploy makes
--     still-running old containers fail with 42704.
--   • Both columns are NULLABLE with no default, so the ALTER does not rewrite
--     the table and an old container keeps writing rows that omit them.
--   • An old container can still save and approve an exact-value set and a
--     5b template: the new CHECKs are satisfied by NULL on both sides, and the
--     trigger's target clauses are no-ops when neither side names a population.
--   • What an old container cannot do is PROMOTE a target — it writes neither
--     column, so `NEW."targetPopulation"` stays NULL while
--     `OLD."pendingTargetPopulation"` is set, and the promotion is refused.
--     That is the control working, and it fails closed.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1) The columns ─────────────────────────────────────────────────

ALTER TABLE "ExternalToolParameterSet" ADD COLUMN IF NOT EXISTS "targetPopulation" TEXT;
ALTER TABLE "ExternalToolParameterSet" ADD COLUMN IF NOT EXISTS "pendingTargetPopulation" TEXT;

-- ─── 2) The three coherence CHECKs ──────────────────────────────────
--
-- The pending column cannot be set without a pending edit beside it to say who
-- proposed it and when — the same half of `pendingOpenFields` that
-- `..._pending_open_fields_needs_pending` already refuses, and for the same
-- reason. NULL beside a real proposal stays legal: it means "after this edit the
-- template has no open target", which is a NARROWING an operator must be able
-- to propose.
ALTER TABLE "ExternalToolParameterSet"
    ADD CONSTRAINT "ExternalToolParameterSet_pending_target_needs_pending"
    CHECK ("pendingTargetPopulation" IS NULL OR "pendingHash" IS NOT NULL);

-- THE TWO HALVES OF A TARGET MUST BOTH BE PRESENT OR BOTH ABSENT.
--
-- `jsonb_path_exists(…, '$.* ? (@.kind == "target")')` asks whether any VALUE in
-- the openFields object is a target marker. Both halves of the equality matter
-- and they fail differently:
--
--   • marker with no population — the agent would choose a row bounded by
--     nothing at all. This is the dangerous direction and the reason the CHECK
--     exists.
--   • population with no marker — harmless at dispatch (nothing is opened), but
--     it means the row asserts something about a target that its field list
--     does not, so a reviewer approved one of two readings and nobody knows
--     which. Refused too, rather than tolerated as a no-op.
--
-- `jsonb_path_exists` and `jsonb_path_query_array` are IMMUTABLE (verified
-- against `pg_proc.provolatile` on this Postgres, not assumed), which is what
-- lets them appear in a CHECK at all.
ALTER TABLE "ExternalToolParameterSet"
    ADD CONSTRAINT "ExternalToolParameterSet_target_population_matches_marker"
    CHECK (
        ("targetPopulation" IS NOT NULL)
        = (
            "openFields" IS NOT NULL
            AND jsonb_path_exists("openFields", '$.* ? (@.kind == "target")')
        )
        AND ("pendingTargetPopulation" IS NOT NULL)
        = (
            "pendingOpenFields" IS NOT NULL
            AND jsonb_path_exists("pendingOpenFields", '$.* ? (@.kind == "target")')
        )
    );

-- AT MOST ONE TARGET PER SIDE. A row carries ONE population, so a second target
-- field would be a second row-identifier bounded by the same set of values —
-- which is not one row, and nothing downstream could say which one the write is
-- about. Also refused by `OpenFieldsSchema`, so this is the backstop; it matters
-- because the CHECK above would be satisfied by two markers and one population.
ALTER TABLE "ExternalToolParameterSet"
    ADD CONSTRAINT "ExternalToolParameterSet_at_most_one_target_field"
    CHECK (
        (
            "openFields" IS NULL
            OR jsonb_array_length(
                   jsonb_path_query_array("openFields", '$.* ? (@.kind == "target")')
               ) <= 1
        )
        AND (
            "pendingOpenFields" IS NULL
            OR jsonb_array_length(
                   jsonb_path_query_array("pendingOpenFields", '$.* ? (@.kind == "target")')
               ) <= 1
        )
    );

-- ─── 3) THE GATE: a target moves only through four eyes ─────────────
--
-- Replaces the body installed by `20261002130000_template_edit_needs_two_humans`.
-- Everything that migration decided is unchanged — ONE counted signature, the
-- proposer excluded as a SET property, `openFields` moving only by promoting
-- exactly what was pending, no open fields on a BASELINE.
--
-- WHAT IS NEW, and why each clause is not decoration:
--
--   • `v_open_changed` now also fires on "targetPopulation". The CHECK above
--     ties the column to the marker, so swapping a template's population
--     WITHOUT touching its field list is a legal row — and it is the sharpest
--     widening available: retarget `terminated_employee_work_emails` to a
--     population containing every active worker and the approved field list,
--     the approved exact values and the stored digest all read unchanged. This
--     trigger is the only thing that refuses it.
--
--   • A promotion must carry "targetPopulation" = OLD."pendingTargetPopulation"
--     as well as the open fields. Without it, `approveParameterChange` could
--     promote the reviewed field list beside an unreviewed population.
--
--   • `v_template` counts a target. A row whose only open field is the target
--     has `openFields` non-null anyway, so this is belt rather than braces —
--     and it is written out because `v_template` decides whether the counted
--     four-eyes gate applies at all, and that term should not depend on another
--     constraint continuing to hold.
--
-- No `USING ERRCODE`, deliberately, for the reason the earlier migrations give:
-- this fires on the ordinary typed Prisma path, and a mapped SQLSTATE reaches
-- the caller as a foreign-key message about a foreign key that does not exist.
-- Left at P0001 the text survives, and the usecase matches on it.

CREATE OR REPLACE FUNCTION external_tool_parameter_set_open_fields_four_eyes()
RETURNS TRIGGER AS $$
DECLARE
    v_open_changed BOOLEAN;
    v_promotion    BOOLEAN;
    v_template     BOOLEAN;
    v_required     INTEGER;
    v_signatures   INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."openFields" IS NOT NULL THEN
            RAISE EXCEPTION
                'EXTERNAL_TOOL_OPEN_FIELDS_NOT_ON_BASELINE: a parameter set cannot be CREATED '
                'with open fields. A new set is a baseline — trust-on-first-use, with no '
                'approver and nothing to have been compared against — so a template reached '
                'that way is a predicate nobody reviewed. Save the exact values, then propose '
                'the open fields and have them approved.';
        END IF;
        -- THIS IS THE FIRST CONTROL ON THIS PATH, not a belt behind the CHECKs.
        -- A BEFORE ROW trigger runs before constraint evaluation, so an INSERT
        -- carrying a population reaches here and never reaches
        -- `..._target_population_matches_marker` at all. (An earlier draft of
        -- this comment called the clause unreachable, which is exactly backwards
        -- and is the kind of note that gets a live check deleted.)
        IF NEW."targetPopulation" IS NOT NULL THEN
            RAISE EXCEPTION
                'EXTERNAL_TOOL_TARGET_NOT_ON_BASELINE: a parameter set cannot be CREATED with '
                'an open target. A baseline has no reviewed moment, and an open target is what '
                'lets an agent address a row nobody named. Save the exact values, then propose '
                'the target population and have it approved.';
        END IF;
        RETURN NEW;
    END IF;

    v_open_changed := NEW."openFields" IS DISTINCT FROM OLD."openFields"
                      OR NEW."targetPopulation" IS DISTINCT FROM OLD."targetPopulation";
    v_promotion    := OLD."pendingHash" IS NOT NULL
                      AND NEW."pendingHash" IS NULL
                      AND NEW."parametersHash" = OLD."pendingHash";
    v_template     := OLD."openFields" IS NOT NULL
                      OR OLD."pendingOpenFields" IS NOT NULL
                      OR OLD."targetPopulation" IS NOT NULL
                      OR OLD."pendingTargetPopulation" IS NOT NULL;

    -- The open fields AND the target population move ONLY by promoting exactly
    -- what was pending — both of them, together, in the same UPDATE.
    IF v_open_changed
       AND NOT (
           v_promotion
           AND NEW."openFields" IS NOT DISTINCT FROM OLD."pendingOpenFields"
           AND NEW."targetPopulation" IS NOT DISTINCT FROM OLD."pendingTargetPopulation"
       ) THEN
        RAISE EXCEPTION
            'EXTERNAL_TOOL_OPEN_FIELDS_NOT_PROMOTED: the open fields and target population in '
            'force on parameter set % may change only by approving the pending edit that '
            'proposed them. Propose the change, collect the signatures, and approve it.',
            OLD."id";
    END IF;

    -- Nothing about open fields is happening: the exact-value path since #2860,
    -- unchanged.
    IF NOT (v_template AND v_promotion) THEN
        RETURN NEW;
    END IF;

    -- ONE counted signature, from a human who is not the proposer (owner ruling,
    -- 2026-10-02 — see `20261002130000_template_edit_needs_two_humans`).
    v_required := 1;

    -- The SET property: the proposer is excluded from the counted approvers
    -- rather than from one ordinal position among them. This is the half that
    -- makes it four eyes rather than two signatures.
    SELECT count(DISTINCT a."approverUserId")
      INTO v_signatures
      FROM "ExternalToolParameterSetApproval" a
     WHERE a."tenantId"       = OLD."tenantId"
       AND a."parameterSetId" = OLD."id"
       AND a."revision"       = OLD."revision" + 1
       AND a."pendingHash"    = OLD."pendingHash"
       AND (OLD."pendingByUserId" IS NULL OR a."approverUserId" <> OLD."pendingByUserId");

    IF v_signatures < v_required THEN
        RAISE EXCEPTION
            'EXTERNAL_TOOL_OPEN_FIELDS_FOUR_EYES: parameter set % needs % approving '
            'signature(s) on revision % from a human other than the one who proposed it, and '
            'has %. A template opens a field to whatever the agent chooses within a bound, so '
            'the predicate review is the only gate on it — and the proposer reading their own '
            'predicate is one pair of eyes, not two.',
            OLD."id", v_required, OLD."revision" + 1, v_signatures;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 4) The signature guard sees a target as a template ─────────────
--
-- Replaces the body installed by `20261002120000`. One clause changes: a row is
-- a TEMPLATE if either side names a target population too, so the signature-time
-- proposer-exclusion message fires for a target-only edit at the moment of
-- signing, naming the person who can act on it — rather than later, against
-- whoever happens to promote.
--
-- With the marker/population CHECK in force a target implies non-null
-- `openFields`, so this is the same belt the promotion trigger's `v_template`
-- wears, for the same reason: the term that decides whether an exclusion applies
-- should not be inferred from a different constraint.

CREATE OR REPLACE FUNCTION external_tool_parameter_set_approval_guard()
RETURNS TRIGGER AS $$
DECLARE
    v_pending_hash TEXT;
    v_pending_by   TEXT;
    v_revision     INTEGER;
    v_template     BOOLEAN;
BEGIN
    SELECT s."pendingHash", s."pendingByUserId", s."revision",
           (s."openFields" IS NOT NULL
            OR s."pendingOpenFields" IS NOT NULL
            OR s."targetPopulation" IS NOT NULL
            OR s."pendingTargetPopulation" IS NOT NULL)
      INTO v_pending_hash, v_pending_by, v_revision, v_template
      FROM "ExternalToolParameterSet" s
     WHERE s."id" = NEW."parameterSetId" AND s."tenantId" = NEW."tenantId";

    -- `FOUND`, not a sentinel variable: `SELECT ... INTO` sets every target to
    -- NULL when it matches nothing, so a `v_found BOOLEAN` would come back NULL
    -- and `IF NOT v_found` would be NULL — neither true nor false — and the
    -- refusal below would be skipped for exactly the case it exists for.
    IF NOT FOUND THEN
        -- Under `app_user` this is a cross-tenant write attempt (RLS hid the
        -- row); under a privileged session it is a dangling id. Both refuse.
        RAISE EXCEPTION
            'EXTERNAL_TOOL_PARAMETER_APPROVAL_NO_SET: no visible parameter set % in tenant %.',
            NEW."parameterSetId", NEW."tenantId";
    END IF;

    IF v_pending_hash IS NULL THEN
        RAISE EXCEPTION
            'EXTERNAL_TOOL_PARAMETER_APPROVAL_NOTHING_PENDING: parameter set % has no pending '
            'edit, so there is nothing for a signature to be against.',
            NEW."parameterSetId";
    END IF;

    IF NEW."pendingHash" <> v_pending_hash THEN
        RAISE EXCEPTION
            'EXTERNAL_TOOL_PARAMETER_APPROVAL_STALE_HASH: the pending edit on parameter set % '
            'changed since it was reviewed. Re-read it and sign the digest now on file.',
            NEW."parameterSetId";
    END IF;

    IF NEW."revision" <> v_revision + 1 THEN
        RAISE EXCEPTION
            'EXTERNAL_TOOL_PARAMETER_APPROVAL_WRONG_REVISION: parameter set % is at revision %, '
            'so a signature on its pending edit is for revision % and not %.',
            NEW."parameterSetId", v_revision, v_revision + 1, NEW."revision";
    END IF;

    -- The exclusion applies only to a template edit, so a one-admin tenant is
    -- not locked out of its own single-approval exact-value edits.
    IF v_template AND v_pending_by IS NOT NULL AND NEW."approverUserId" = v_pending_by THEN
        RAISE EXCEPTION
            'EXTERNAL_TOOL_PARAMETER_APPROVAL_PROPOSER_SELF_REVIEW: % proposed this edit to '
            'parameter set % and may not be one of the humans who approve it. Widening a '
            'predicate affects every future invocation, and the point of the second pair of '
            'eyes is that they are not the first pair.',
            NEW."approverUserId", NEW."parameterSetId";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
