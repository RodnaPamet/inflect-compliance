-- ═══════════════════════════════════════════════════════════════════
-- Step 3d (#3677): internal audit's human sampling of the auditor agent's
-- workpapers.
--
--   TenantSecuritySettings.workpaperReviewSamplePercent
--                                    the share of workpapers drawn, 1..100,
--                                    default 100 (owner decision 2026-10-19:
--                                    every workpaper in the pilot). A setting,
--                                    so lowering it is not a code change.
--   AuditWorkpaperSampleReview       one row per sampled workpaper: who in
--                                    internal audit was asked (or why nobody
--                                    could be), and their write-once answer —
--                                    CONCURRED, DISSENTED or INDETERMINATE, with
--                                    stable dissent codes and no free text.
--
-- The new table is a Regulatory artefact the tenant purge retains, so its only
-- foreign keys are to "Tenant" (kept as a tombstone) and to "AuditWorkpaper"
-- (also retained). The finding proposal a dissent raises, the reviewer and the
-- assignee are plain ids: proposals and memberships are purged, this row is
-- not.
--
-- ── ROLLING-DEPLOY SAFETY ───────────────────────────────────────────
--
--   • The column is NOT NULL DEFAULT 100, a constant default: PostgreSQL 11+
--     adds it without rewriting the table. An old container's client never
--     selects it and inserts settings rows without it, which is 100.
--   • Its CHECK is added NOT VALID and validated only when no row offends (see
--     §1), so a migrate deploy can never fail on a scan.
--   • A new table the previous image never reads. No enum is altered: the
--     outcome reuses "AgentSampleAuditOutcome" as it stands.
--
-- FORWARD-ONLY. A dissent code added later needs §4's CHECK dropped and
-- re-added, widened, under the same name, in a new migration.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1) The rate ────────────────────────────────────────────────────

ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN "workpaperReviewSamplePercent" INTEGER NOT NULL DEFAULT 100;

-- 0 would be a sampling plan that samples nothing while looking configured.
-- NOT VALID, then a conditional VALIDATE: the column is new and defaulted, so
-- no row can offend today, but the shape is the one #3720 set for every CHECK
-- on an existing table — a plain ADD CONSTRAINT scans, and a scan that finds an
-- offending row fails `migrate deploy` on every container start (P3009).
ALTER TABLE "TenantSecuritySettings"
    ADD CONSTRAINT "TenantSecuritySettings_workpaper_review_sample_percent"
    CHECK ("workpaperReviewSamplePercent" BETWEEN 1 AND 100)
    NOT VALID;

DO $$
DECLARE
    offending INTEGER;
BEGIN
    SELECT COUNT(*) INTO offending
      FROM "TenantSecuritySettings"
     WHERE "workpaperReviewSamplePercent" NOT BETWEEN 1 AND 100;

    IF offending = 0 THEN
        ALTER TABLE "TenantSecuritySettings"
            VALIDATE CONSTRAINT "TenantSecuritySettings_workpaper_review_sample_percent";
    ELSE
        RAISE WARNING
            'TenantSecuritySettings_workpaper_review_sample_percent left NOT VALID: % row(s) hold a rate outside 1..100.',
            offending;
    END IF;
END
$$;

-- ─── 2) The review ──────────────────────────────────────────────────

CREATE TABLE "AuditWorkpaperSampleReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workpaperId" TEXT NOT NULL,
    "samplingEpoch" TEXT NOT NULL,
    "seedFingerprint" TEXT NOT NULL,
    "samplePercent" INTEGER NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedToUserId" TEXT,
    "unassignedReason" TEXT,
    "assignmentPoolSize" INTEGER NOT NULL,
    "assignmentPoolDigest" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" "AgentSampleAuditOutcome" NOT NULL DEFAULT 'PENDING',
    "dissentCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "findingProposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditWorkpaperSampleReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditWorkpaperSampleReview_tenantId_assignedToUserId_sample_idx" ON "AuditWorkpaperSampleReview"("tenantId", "assignedToUserId", "sampledAt");
CREATE INDEX "AuditWorkpaperSampleReview_tenantId_sampledAt_idx" ON "AuditWorkpaperSampleReview"("tenantId", "sampledAt");
CREATE UNIQUE INDEX "AuditWorkpaperSampleReview_tenantId_workpaperId_key" ON "AuditWorkpaperSampleReview"("tenantId", "workpaperId");

ALTER TABLE "AuditWorkpaperSampleReview" ADD CONSTRAINT "AuditWorkpaperSampleReview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditWorkpaperSampleReview" ADD CONSTRAINT "AuditWorkpaperSampleReview_workpaperId_tenantId_fkey" FOREIGN KEY ("workpaperId", "tenantId") REFERENCES "AuditWorkpaper"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 3) The draw's shapes ───────────────────────────────────────────
--
-- The epoch is the workpaper's period behind a fixed prefix (the insert guard
-- below binds it to THIS workpaper's period); the fingerprint and the pool
-- digest are SHA-256 hex; the rate is the one the setting allows.
ALTER TABLE "AuditWorkpaperSampleReview" ADD CONSTRAINT "AuditWorkpaperSampleReview_draw_shapes" CHECK (
        "samplingEpoch" ~ '^audit-workpaper-review@[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'
    AND "seedFingerprint" ~ '^[0-9a-f]{64}$'
    AND "samplePercent" BETWEEN 1 AND 100
    AND "assignmentPoolDigest" ~ '^[0-9a-f]{64}$'
    AND "assignmentPoolSize" >= 0
    AND "dissentCodes" IS NOT NULL
);

-- Assigned, or UNASSIGNED with a named reason — never neither and never both.
-- An assignee was drawn from a pool of at least one; nobody is assigned from
-- nothing.
ALTER TABLE "AuditWorkpaperSampleReview" ADD CONSTRAINT "AuditWorkpaperSampleReview_assigned_or_reasoned" CHECK (
    ("assignedToUserId" IS NULL) <> ("unassignedReason" IS NULL)
    AND (
        "unassignedReason" IS NULL
        OR "unassignedReason" IN ('NO_THIRD_LINE_MEMBER', 'ONLY_THIRD_LINE_MEMBER_OWNS_AUDITOR', 'AUDITOR_OWNER_UNKNOWN')
    )
    AND ("assignedToUserId" IS NULL OR "assignmentPoolSize" >= 1)
);

-- ─── 4) The answer's shapes ─────────────────────────────────────────
--
-- The stamp travels as a pair and only with an answer; the person who answered
-- is the person who was asked (an UNASSIGNED item cannot be answered at all);
-- dissent codes belong to a DISSENTED row and to no other, a DISSENTED row
-- names at least one, and every code is one of the stable vocabulary in
-- `WORKPAPER_REVIEW_DISSENT_CODES` (src/lib/agentic/workpaper-review-sampling.ts).
-- That vocabulary pin is what makes "no free text" a property of the column
-- rather than of the one usecase that writes it. A finding proposal is linked
-- only to a dissent.
ALTER TABLE "AuditWorkpaperSampleReview" ADD CONSTRAINT "AuditWorkpaperSampleReview_answer_shapes" CHECK (
    ("outcome" = 'PENDING') = ("reviewedAt" IS NULL)
    AND ("reviewedAt" IS NULL) = ("reviewedByUserId" IS NULL)
    AND ("outcome" = 'PENDING' OR "reviewedByUserId" = "assignedToUserId")
    AND ("outcome" = 'DISSENTED') = (cardinality("dissentCodes") > 0)
    AND "dissentCodes" <@ ARRAY[
        'POPULATION_NOT_AS_DEFINED',
        'SAMPLE_NOT_REPRODUCIBLE',
        'ATTRIBUTE_NOT_TESTED',
        'ITEM_OUTCOME_WRONG',
        'EXCEPTION_MISSED',
        'EXCEPTION_NOT_SUPPORTED',
        'PARAMETERS_MISAPPLIED',
        'EVIDENCE_INSUFFICIENT',
        'CONCLUSION_NOT_SUPPORTED'
    ]::TEXT[]
    AND ("findingProposalId" IS NULL OR "outcome" = 'DISSENTED')
);

-- ─── 5) Who may be asked, and who may answer — below the usecase ────
--
-- `isEligibleReviewer` (src/lib/agentic/workpaper-review-sampling.ts) refuses
-- first, with a named reason. This function refuses the same people for any
-- writer that skips it: an assignee, and the person who answers, must hold an
-- ACTIVE membership of the tenant whose line of defence is THIRD, and must not
-- be the CURRENT owner of the auditor agent that wrote the workpaper. An
-- auditor agent the register no longer holds has no owner to exclude, so
-- nobody can be asked about its workpaper (the sweep records it UNASSIGNED,
-- AUDITOR_OWNER_UNKNOWN).
--
-- No `USING ERRCODE`: P0001 keeps the text, and the code leads it.

CREATE OR REPLACE FUNCTION audit_workpaper_sample_review_assert_reviewer(
    p_tenant_id TEXT,
    p_workpaper_id TEXT,
    p_user_id TEXT
) RETURNS VOID AS $$
DECLARE
    v_line   TEXT;
    v_status TEXT;
    v_owner  TEXT;
BEGIN
    SELECT m."lineOfDefence"::TEXT, m."status"::TEXT
      INTO v_line, v_status
      FROM "TenantMembership" m
     WHERE m."tenantId" = p_tenant_id AND m."userId" = p_user_id;

    IF NOT FOUND OR v_status <> 'ACTIVE' OR v_line IS DISTINCT FROM 'THIRD' THEN
        RAISE EXCEPTION
            'AUDIT_WORKPAPER_REVIEWER_NOT_THIRD_LINE: user % is not an ACTIVE third-line member of tenant %; '
            'a sampled workpaper is reviewed by internal audit.',
            p_user_id, p_tenant_id;
    END IF;

    SELECT a."ownerUserId" INTO v_owner
      FROM "AuditWorkpaper" w
      JOIN "RegisteredAgent" a
        ON a."id" = w."auditorAgentId" AND a."tenantId" = w."tenantId"
     WHERE w."id" = p_workpaper_id AND w."tenantId" = p_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'AUDIT_WORKPAPER_REVIEWER_OWNER_UNKNOWN: the auditor agent of workpaper % is not in the register, '
            'so its owner cannot be excluded.',
            p_workpaper_id;
    END IF;

    IF v_owner = p_user_id THEN
        RAISE EXCEPTION
            'AUDIT_WORKPAPER_REVIEWER_OWNS_AUDITOR: user % owns the auditor agent that wrote workpaper %; '
            'the owner of the auditor never reviews its workpapers.',
            p_user_id, p_workpaper_id;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ─── 6) The insert guard: born undecided, epoch bound to the period ─

CREATE OR REPLACE FUNCTION audit_workpaper_sample_review_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
    v_period TEXT;
BEGIN
    IF NEW."outcome" <> 'PENDING' OR NEW."reviewedAt" IS NOT NULL OR NEW."reviewedByUserId" IS NOT NULL
       OR cardinality(NEW."dissentCodes") > 0 OR NEW."findingProposalId" IS NOT NULL THEN
        RAISE EXCEPTION
            'AUDIT_WORKPAPER_SAMPLE_REVIEW_BORN_ANSWERED: a sampled workpaper is drawn PENDING; the answer '
            'is a separate act by the assigned reviewer.';
    END IF;

    SELECT w."periodLabel" INTO v_period
      FROM "AuditWorkpaper" w
     WHERE w."id" = NEW."workpaperId" AND w."tenantId" = NEW."tenantId";

    IF NOT FOUND OR NEW."samplingEpoch" <> 'audit-workpaper-review@' || v_period THEN
        RAISE EXCEPTION
            'AUDIT_WORKPAPER_SAMPLE_REVIEW_EPOCH: the review epoch of workpaper % is fixed by its period.',
            NEW."workpaperId";
    END IF;

    IF NEW."assignedToUserId" IS NOT NULL THEN
        PERFORM audit_workpaper_sample_review_assert_reviewer(NEW."tenantId", NEW."workpaperId", NEW."assignedToUserId");
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_workpaper_sample_review_insert_guard_trg ON "AuditWorkpaperSampleReview";
CREATE TRIGGER audit_workpaper_sample_review_insert_guard_trg
    BEFORE INSERT ON "AuditWorkpaperSampleReview"
    FOR EACH ROW EXECUTE FUNCTION audit_workpaper_sample_review_insert_guard();

-- ─── 7) The one-way record ──────────────────────────────────────────
--
-- What the draw fixed never moves. After that, exactly three moves exist, and
-- every other UPDATE is refused for every role, the table owner included:
--
--   RE-ASSIGN  PENDING → PENDING, unanswered, unlinked: only the assignment
--              columns change (a later sweep re-draws an UNASSIGNED item, or an
--              assignee who is no longer eligible). The new assignee is checked.
--   ANSWER     PENDING → an answer, once, by the assigned reviewer (the CHECK
--              pins reviewer = assignee). The assignment is frozen by it, and
--              the answerer is checked as they are at that moment.
--   LINK       a DISSENTED row's finding proposal, NULL → an id, once.
--
-- An answered row is otherwise frozen: a verdict that could be revised is the
-- only way the agreement rate could be improved after the fact.

CREATE OR REPLACE FUNCTION audit_workpaper_sample_review_one_way()
RETURNS TRIGGER AS $$
DECLARE
    v_draw_same       BOOLEAN;
    v_assign_same     BOOLEAN;
    v_answer_same     BOOLEAN;
BEGIN
    v_draw_same := ROW(NEW."id", NEW."tenantId", NEW."workpaperId", NEW."samplingEpoch",
                       NEW."seedFingerprint", NEW."samplePercent", NEW."sampledAt", NEW."createdAt")
                   IS NOT DISTINCT FROM
                   ROW(OLD."id", OLD."tenantId", OLD."workpaperId", OLD."samplingEpoch",
                       OLD."seedFingerprint", OLD."samplePercent", OLD."sampledAt", OLD."createdAt");
    v_assign_same := ROW(NEW."assignedToUserId", NEW."unassignedReason", NEW."assignmentPoolSize",
                         NEW."assignmentPoolDigest", NEW."assignedAt")
                     IS NOT DISTINCT FROM
                     ROW(OLD."assignedToUserId", OLD."unassignedReason", OLD."assignmentPoolSize",
                         OLD."assignmentPoolDigest", OLD."assignedAt");
    v_answer_same := ROW(NEW."outcome", NEW."dissentCodes", NEW."reviewedByUserId", NEW."reviewedAt")
                     IS NOT DISTINCT FROM
                     ROW(OLD."outcome", OLD."dissentCodes", OLD."reviewedByUserId", OLD."reviewedAt");

    IF NOT v_draw_same THEN
        RAISE EXCEPTION
            'IMMUTABLE_AUDIT_WORKPAPER_SAMPLE_REVIEW: what the draw fixed (workpaper, epoch, seed, rate) never changes.';
    END IF;

    -- RE-ASSIGN
    IF OLD."outcome" = 'PENDING' AND NEW."outcome" = 'PENDING' THEN
        IF NOT v_answer_same OR NEW."findingProposalId" IS DISTINCT FROM OLD."findingProposalId" THEN
            RAISE EXCEPTION
                'IMMUTABLE_AUDIT_WORKPAPER_SAMPLE_REVIEW: an unanswered review changes only its assignment.';
        END IF;
        IF NEW."assignedToUserId" IS NOT NULL
           AND NEW."assignedToUserId" IS DISTINCT FROM OLD."assignedToUserId" THEN
            PERFORM audit_workpaper_sample_review_assert_reviewer(NEW."tenantId", NEW."workpaperId", NEW."assignedToUserId");
        END IF;
        RETURN NEW;
    END IF;

    -- ANSWER
    IF OLD."outcome" = 'PENDING' AND NEW."outcome" <> 'PENDING' THEN
        IF NOT v_assign_same OR NEW."findingProposalId" IS NOT NULL THEN
            RAISE EXCEPTION
                'IMMUTABLE_AUDIT_WORKPAPER_SAMPLE_REVIEW: an answer changes neither the assignment nor the proposal link.';
        END IF;
        PERFORM audit_workpaper_sample_review_assert_reviewer(NEW."tenantId", NEW."workpaperId", NEW."reviewedByUserId");
        RETURN NEW;
    END IF;

    -- LINK
    IF OLD."outcome" = 'DISSENTED' AND v_assign_same AND v_answer_same
       AND OLD."findingProposalId" IS NULL AND NEW."findingProposalId" IS NOT NULL THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'IMMUTABLE_AUDIT_WORKPAPER_SAMPLE_REVIEW_ANSWER: review % was answered % at %; the answer is set once and '
        'never changed, and only a dissent''s proposal link may be added, once.',
        OLD."id", OLD."outcome", OLD."reviewedAt";
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_workpaper_sample_review_one_way_trg ON "AuditWorkpaperSampleReview";
CREATE TRIGGER audit_workpaper_sample_review_one_way_trg
    BEFORE UPDATE ON "AuditWorkpaperSampleReview"
    FOR EACH ROW EXECUTE FUNCTION audit_workpaper_sample_review_one_way();

-- ─── 8) Privileges + RLS ────────────────────────────────────────────
--
-- `app_user` reads, inserts and (for the three moves) updates; it never
-- deletes. A review leaves only with its workpaper, which leaves only with its
-- tenant. Default privileges grant DELETE to `app_user` (20260323180000), so it
-- is revoked explicitly, as 20261018170000 does for "AuditWorkpaper".

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "AuditWorkpaperSampleReview" TO app_user;
        REVOKE DELETE ON "AuditWorkpaperSampleReview" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "AuditWorkpaperSampleReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditWorkpaperSampleReview" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditWorkpaperSampleReview";
CREATE POLICY tenant_isolation ON "AuditWorkpaperSampleReview"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditWorkpaperSampleReview";
CREATE POLICY tenant_isolation_insert ON "AuditWorkpaperSampleReview"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AuditWorkpaperSampleReview";
CREATE POLICY superuser_bypass ON "AuditWorkpaperSampleReview"
    USING (current_setting('role') != 'app_user');
