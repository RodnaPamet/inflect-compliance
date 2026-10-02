-- A template edit needs TWO humans, not three (owner ruling, 2026-10-02).
--
-- ═══════════════════════════════════════════════════════════════════
-- WHY THIS IS A SECOND MIGRATION AND NOT AN EDIT TO THE FIRST
-- ═══════════════════════════════════════════════════════════════════
--
-- `20261002120000_external_tool_parameter_open_fields` is ALREADY APPLIED to
-- the shared test database at 127.0.0.1:5434 — it got there before review,
-- via `npm run openapi:generate`, which is a wrapper around a Jest contract
-- test and so runs `globalSetup` without `CI=1`.
--
-- Prisma stores a checksum per migration. Editing that file would break it for
-- every session and for CI, so the only safe way to change the rule is a new
-- migration that REPLACES the function. `CREATE OR REPLACE FUNCTION` makes
-- that exact and cheap: the trigger keeps pointing at the same name, and a
-- fresh database applying both migrations in order ends in the same state as
-- one that applies only this one on top.
--
-- ═══════════════════════════════════════════════════════════════════
-- WHAT CHANGED, AND WHY
-- ═══════════════════════════════════════════════════════════════════
--
-- The first cut required 2 counted signatures AND excluded the proposer from
-- the count. Those compose into THREE distinct humans per template edit —
-- proposer plus two approvers — which is stricter than "four eyes" means and
-- had a consequence nobody asked for: a tenant with two admins could not
-- promote a template edit at all. A control shaped like an outage is a control
-- people route around.
--
-- So the requirement is ONE counted signature, and the proposer exclusion
-- STAYS. That is four eyes in the literal sense: the human who wrote the
-- predicate, and one independent human who read it. The exclusion is the half
-- that carries the property — two signatures from one person is one review,
-- and it is the exclusion, not the count, that makes the second pair of eyes
-- a different pair.
--
-- Nothing else in the function moves. In particular `openFields` still changes
-- only by promoting exactly what was pending, a baseline still may not carry
-- open fields, and the count still filters on `revision` and `pendingHash` so
-- a signature cannot carry forward to content its signer never read.

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
        RETURN NEW;
    END IF;

    v_open_changed := NEW."openFields" IS DISTINCT FROM OLD."openFields";
    v_promotion    := OLD."pendingHash" IS NOT NULL
                      AND NEW."pendingHash" IS NULL
                      AND NEW."parametersHash" = OLD."pendingHash";
    v_template     := OLD."openFields" IS NOT NULL OR OLD."pendingOpenFields" IS NOT NULL;

    -- `openFields` moves ONLY by promoting exactly what was pending.
    IF v_open_changed
       AND NOT (v_promotion AND NEW."openFields" IS NOT DISTINCT FROM OLD."pendingOpenFields") THEN
        RAISE EXCEPTION
            'EXTERNAL_TOOL_OPEN_FIELDS_NOT_PROMOTED: the open fields in force on parameter set '
            '% may change only by approving the pending edit that proposed them. Propose the '
            'change, collect the signatures, and approve it.',
            OLD."id";
    END IF;

    -- Nothing about open fields is happening: the exact-value path since #2860,
    -- unchanged.
    IF NOT (v_template AND v_promotion) THEN
        RETURN NEW;
    END IF;

    -- ONE counted signature, from a human who is not the proposer. Was 2, which
    -- with the exclusion below meant three people; see the header.
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
