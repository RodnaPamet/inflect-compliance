-- ═══════════════════════════════════════════════════════════════════
-- BOUNDED TEMPLATES FOR VALUE FIELDS, AND THE FOUR-EYES GATE ON THEM
-- (#3051 step 5b — part of #2861's external-write ladder)
--
-- `ExternalToolParameterSet` holds EXACT values today: a human types the bytes
-- that will be dispatched, and the safety claim is "a person wrote this". A
-- TEMPLATE opens some fields, and the claim moves — it becomes "the constraint
-- is tight enough", a judgement a reviewer makes ONCE, about a shape, for every
-- future invocation. Retyping one value affects one call; widening a predicate
-- affects all of them. That asymmetry is why this migration exists.
--
-- Three things land here:
--
--   1. "openFields" / "pendingOpenFields" on "ExternalToolParameterSet" —
--      nullable, no default, so an existing row IS a template with zero open
--      fields. No backfill, no flag day.
--   2. "ExternalToolParameterSetApproval" — one row per human signature, with
--      the four-eyes rule expressed as a unique index rather than as usecase
--      code.
--   3. A trigger on "ExternalToolParameterSet" that refuses to let a pending
--      edit's open fields come into force until the signatures are there.
--
-- ── WHY THE GATE IS A TRIGGER ON THE PROMOTION, NOT THE SIGNATURE TABLE ──
--
-- A signature table enforces "one signature per human per revision". It does
-- NOT enforce "two distinct humans before this goes live" — that is a COUNT,
-- and counting then promoting is the read-then-write the `AgentProposal`
-- migration is explicit about: two requests each read "one signature so far"
-- and each promote. There is no application-layer arrangement of that check
-- that closes the window.
--
-- So the count is asserted inside the UPDATE that promotes, by the database,
-- against the row that UPDATE has already locked. The application never
-- decides it.
--
-- ── WHY THE EXCLUSION RULE IS A SET PROPERTY ────────────────────────
--
-- The human in "pendingByUserId" may not be AMONG the approvers — not "the
-- second approver is not the proposer". The ordinal form sounds equivalent and
-- is bypassed by controlling who clicks first, exactly as the proposal
-- trigger's comment explains.
--
-- It is checked at BOTH ends, for a reason the ordinal/set distinction does not
-- cover. The signature-time check gives the clear early error, naming the
-- person who can act on it. The promotion-time check is the load-bearing one:
-- `proposeParameterChange` refuses an edit identical to what is IN FORCE but
-- not one identical to what is already PENDING, so a human who signed first
-- could afterwards re-propose the same content and become its proposer, with
-- their earlier signature still on file. Only a check at promotion sees that.
--
-- ── ROLLING-DEPLOY SAFETY ───────────────────────────────────────────
--
--   • No `ALTER TYPE` anywhere, and no new Postgres enum: an enum value added
--     mid-deploy makes still-running old containers fail with 42704.
--   • Both new columns are NULLABLE with no default, so the ALTER does not
--     rewrite the table and an old container keeps writing rows that omit them.
--   • An old container can still save and approve an EXACT-VALUE set: the
--     trigger returns early when neither side of the row has open fields, so
--     today's single-approval path is untouched. What an old container cannot
--     do is approve a TEMPLATE edit — it writes no signature row, so the
--     promotion is refused. That is the control working, and it fails closed.
--   • The signature table is created empty and no old container writes it.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1) The open-field columns ──────────────────────────────────────

ALTER TABLE "ExternalToolParameterSet" ADD COLUMN IF NOT EXISTS "openFields" JSONB;
ALTER TABLE "ExternalToolParameterSet" ADD COLUMN IF NOT EXISTS "pendingOpenFields" JSONB;

-- The existing `ExternalToolParameterSet_pending_is_whole` CHECK is left
-- EXACTLY as it is, and this is a separate constraint rather than a widening of
-- it. `pendingOpenFields` is a FIFTH fact that may legitimately be absent while
-- the quartet is present: NULL on a pending edit means "after this edit the
-- template has zero open fields", which is a NARROWING and a thing an operator
-- must be able to propose. Folding it into the all-or-none quartet would make
-- that proposal unrepresentable.
--
-- What IS uninterpretable is the other half — open fields pending with no
-- pending edit beside them to say who proposed them or when — so that is what
-- this refuses. Additive, so no table rewrite and nothing to drop.
ALTER TABLE "ExternalToolParameterSet"
    ADD CONSTRAINT "ExternalToolParameterSet_pending_open_fields_needs_pending"
    CHECK ("pendingOpenFields" IS NULL OR "pendingHash" IS NOT NULL);

-- The composite parent key a signature's FK points at, so a signature can
-- never be attached to another tenant's parameter set.
--
-- `IF NOT EXISTS`, deliberately, and for the reason the `AgentProposal`
-- migration states rather than to paper over a conflict: this index belongs to
-- the TABLE, not to one migration. Any table wanting a tenant-safe composite FK
-- back to "ExternalToolParameterSet" needs exactly this index under exactly
-- this name, and two branches creating it unconditionally means whichever
-- merges second dies with 42P07 on deploy. Same columns, same name, same
-- uniqueness — idempotent by construction.
CREATE UNIQUE INDEX IF NOT EXISTS "ExternalToolParameterSet_id_tenantId_key"
    ON "ExternalToolParameterSet"("id", "tenantId");

-- ─── 2) The signature table ─────────────────────────────────────────

CREATE TABLE "ExternalToolParameterSetApproval" (
    "id"                TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "parameterSetId"    TEXT NOT NULL,
    "approverUserId"    TEXT NOT NULL,
    "revision"          INTEGER NOT NULL,
    "pendingHash"       TEXT NOT NULL,
    "requiredApprovals" INTEGER NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExternalToolParameterSetApproval_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ExternalToolParameterSetApproval"
    ADD CONSTRAINT "ExternalToolParameterSetApproval_required_approvals_positive"
    CHECK ("requiredApprovals" >= 1);

-- A signature for revision 1 would be a signature on a BASELINE, and a baseline
-- is trust-on-first-use with nothing to have reviewed. The first signable
-- revision is 2.
ALTER TABLE "ExternalToolParameterSetApproval"
    ADD CONSTRAINT "ExternalToolParameterSetApproval_revision_signable"
    CHECK ("revision" >= 2);

-- THE FOUR-EYES CONSTRAINT ITSELF. One signature per human per (revision,
-- content), arbitrated by the index, with no read-then-write window anywhere.
--
-- `revision` is in the key so the same admin can approve a LATER edit having
-- signed an earlier one. `pendingHash` is in the key so the same admin can sign
-- AGAIN once the content under review changes — without it, a two-admin tenant
-- whose edit was revised after one signature could never promote it, and a
-- control shaped like an outage is a control people remove.
-- The two index NAMES are Prisma's own, truncated at 63 characters exactly as
-- `prisma migrate diff --from-empty --to-schema` renders them. They are not
-- readable and they are not negotiable: a hand-chosen name here (or a `map:` in
-- the schema to match a hand-chosen one) is drift, and the fresh-DB drift gate
-- fails on it in both directions. Verified by diffing this file's statements
-- against that command's output rather than by reading the truncation rule.
CREATE UNIQUE INDEX "ExternalToolParameterSetApproval_tenantId_parameterSetId_re_key" ON "ExternalToolParameterSetApproval"("tenantId", "parameterSetId", "revision", "approverUserId", "pendingHash");

CREATE INDEX "ExternalToolParameterSetApproval_tenantId_parameterSetId_re_idx"
    ON "ExternalToolParameterSetApproval"("tenantId", "parameterSetId", "revision");

ALTER TABLE "ExternalToolParameterSetApproval"
    ADD CONSTRAINT "ExternalToolParameterSetApproval_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalToolParameterSetApproval"
    ADD CONSTRAINT "ExternalToolParameterSetApproval_parameterSetId_tenantId_fkey"
    FOREIGN KEY ("parameterSetId", "tenantId")
    REFERENCES "ExternalToolParameterSet"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 3) Signature-time refusals ─────────────────────────────────────
--
-- Everything here the promotion trigger below also enforces. These exist for
-- the error message: an admin told AT THE MOMENT OF SIGNING that they proposed
-- this edit, or that the content moved under them, can act on it — whereas the
-- same refusal surfacing later, against whoever happens to promote, names the
-- wrong person.
--
-- No `USING ERRCODE`, deliberately, for the reason the proposal trigger states:
-- this fires on the ordinary typed Prisma path, and a mapped SQLSTATE reaches
-- the caller as a foreign-key message about a foreign key that does not exist.
-- Left at P0001 the text survives, and the usecase matches on it.

CREATE OR REPLACE FUNCTION external_tool_parameter_set_approval_guard()
RETURNS TRIGGER AS $$
DECLARE
    v_pending_hash TEXT;
    v_pending_by   TEXT;
    v_revision     INTEGER;
    v_template     BOOLEAN;
BEGIN
    SELECT s."pendingHash", s."pendingByUserId", s."revision",
           (s."openFields" IS NOT NULL OR s."pendingOpenFields" IS NOT NULL)
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

    -- The exclusion applies only where two signatures are required, so a
    -- one-admin tenant is not locked out of its own single-approval edits.
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

DROP TRIGGER IF EXISTS external_tool_parameter_set_approval_guard_trg
    ON "ExternalToolParameterSetApproval";
CREATE TRIGGER external_tool_parameter_set_approval_guard_trg
    BEFORE INSERT OR UPDATE ON "ExternalToolParameterSetApproval"
    FOR EACH ROW EXECUTE FUNCTION external_tool_parameter_set_approval_guard();

-- ─── 4) THE GATE: open fields come into force only with the signatures ──
--
-- Fires on every INSERT and UPDATE of "ExternalToolParameterSet", and returns
-- early for everything that is not about open fields — so the exact-value path
-- that has shipped since #2860 is unaffected.
--
-- WHAT COUNTS AS A PROMOTION is spelled the way `approveParameterChange` writes
-- it: there WAS a pending edit, there is none now, and what is in force is what
-- was pending. Anything else that moves "openFields" is refused outright —
-- including a direct UPDATE that sets it with no pending edit at all, which is
-- the bypass a gate keyed only on promotions would leave open.
--
-- AN INSERT MAY NOT CARRY OPEN FIELDS. A row is created by `saveParameterSet`
-- as a BASELINE: trust-on-first-use, no approver, nothing to have compared it
-- against. A template created that way is a predicate nobody reviewed, which is
-- the one outcome step 5b exists to prevent — and it would make the four-eyes
-- requirement avoidable by deleting a set and saving it again. A data migration
-- that needs open fields inserts the row without them and promotes.
--
-- THE REQUIREMENT IS COMPUTED HERE, not read from a column the application
-- wrote. `AgentProposal` pins its requirement and then defends that pin with a
-- write-once trigger; the equivalent here is cheaper and stronger — the
-- requirement is a function of the row (does either side of it have open
-- fields?), so there is no stored number for anybody to lower. The signature
-- rows carry `requiredApprovals` as self-describing evidence of what the signer
-- was told, and nothing gates on it.
--
-- NOTE THE WIDER READING of "2 when the row being edited has open fields".
-- Taken to mean only the IN-FORCE side, a single approver could turn an
-- exact-value set INTO a template — which is precisely the transition this gate
-- exists for. So either side having open fields makes it two. That is strictly
-- stricter than the narrow reading and fails toward the expensive answer.

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

    v_required := CASE WHEN v_template THEN 2 ELSE 1 END;

    -- The SET property: the proposer is excluded from the counted approvers
    -- rather than from one ordinal position among them.
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
            'signature(s) on revision % from humans other than the one who proposed it, and '
            'has %. A template opens a field to whatever the agent chooses within a bound, so '
            'the predicate review is the only gate on it — and one pair of eyes is not a '
            'review.',
            OLD."id", v_required, OLD."revision" + 1, v_signatures;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS external_tool_parameter_set_open_fields_four_eyes_trg
    ON "ExternalToolParameterSet";
CREATE TRIGGER external_tool_parameter_set_open_fields_four_eyes_trg
    BEFORE INSERT OR UPDATE ON "ExternalToolParameterSet"
    FOR EACH ROW EXECUTE FUNCTION external_tool_parameter_set_open_fields_four_eyes();

-- ═══════════════════════════════════════════════════════════════════
-- 5) Privileges + Row-Level Security (Epic A.1)
-- ═══════════════════════════════════════════════════════════════════
-- `tenantId` is NOT NULL, so the split USING / WITH CHECK form is correct.
--
-- APPEND-ONLY, enforced by the GRANT rather than by a trigger. `app_user` holds
-- SELECT and INSERT and neither UPDATE nor DELETE, the same split
-- `AgentProposalApproval` makes. DELETE is withheld but not trigger-blocked: a
-- signature row is removed only by CASCADE from the parameter set it signs or
-- from the tenant — i.e. only when the thing it signs is itself gone — and a
-- trigger refusing that would make deleting a tenant impossible. Referential
-- CASCADE runs as the table owner and so is unaffected by the withheld grant.

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT ON "ExternalToolParameterSetApproval" TO app_user;
        REVOKE UPDATE, DELETE ON "ExternalToolParameterSetApproval" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "ExternalToolParameterSetApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalToolParameterSetApproval" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "ExternalToolParameterSetApproval";
CREATE POLICY tenant_isolation ON "ExternalToolParameterSetApproval"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "ExternalToolParameterSetApproval";
CREATE POLICY tenant_isolation_insert ON "ExternalToolParameterSetApproval"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "ExternalToolParameterSetApproval";
CREATE POLICY superuser_bypass ON "ExternalToolParameterSetApproval"
    USING (current_setting('role') != 'app_user');
