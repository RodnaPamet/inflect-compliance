-- #5068 — a vendor answer's questionId points at the question it actually holds.
--
-- `VendorAssessmentAnswer.questionId` carries a
-- `VendorAssessmentTemplateQuestion` id: `submitResponse` writes
-- `questionId: a.questionId, templateQuestionId: a.questionId` from the same
-- value, and so does `approveProposal` on the vendor-doc extraction path.
--
-- But the column kept the foreign key 20260309132815 gave it, to the LEGACY
-- `QuestionnaireQuestion` table, which the product does not populate. Be
-- precise about that, because a grep for `questionnaireQuestion.create` says
-- "no writer" and is WRONG: `prisma/seed-vendor-questionnaire.ts` writes 20 of
-- them through a NESTED `questions: { create: [...] }`, which never names the
-- model. That script is unwired — run by hand per its own docblock — while the
-- one `scripts/entrypoint.sh` runs on every container start is the PLURAL
-- `scripts/seed-vendor-questionnaires.ts`, which writes the G-3 tables
-- (VendorAssessmentTemplate / Section / TemplateQuestion) and no legacy row.
--
-- So no id the product mints for a G-3 answer could satisfy this FK: the first
-- answer upsert raised P2003, the transaction rolled back, and no G-3
-- assessment built in the product could ever reach SUBMITTED. Review, close,
-- the risk writeback and the evidence attach were all unreachable behind it.
--
-- `tests/integration/vendor-assessment-lifecycle.test.ts` passed only because
-- its fixture fabricates a matching legacy row "with the SAME explicit id" —
-- the test documented the workaround in a comment. That fixture is removed in
-- this change, so the suite exercises the real path.
--
-- ─── Why RE-POINT rather than drop ──────────────────────────────────────────
--
-- Dropping the constraint would unblock the feature and leave `questionId` an
-- unchecked string, with nothing stopping an answer naming a question that does
-- not exist. The column is also the one the upsert keys on
-- (`@@unique([assessmentId, questionId])`), so it has to stay NOT NULL and
-- cannot simply be retired here. `VendorAssessmentTemplateQuestion.id` is a
-- single-column `@id`, so a one-column FK to it is available — which keeps
-- referential integrity and points it at the table the value comes from.
--
-- Owner decision, 2026-11-13.
--
-- ─── Why NOT VALID, then a conditional VALIDATE ─────────────────────────────
--
-- The same reasoning as 20261019005000 (#3734) and 20261018180000 (#3720):
-- nobody can see production from here, and a plain `ADD CONSTRAINT ... FOREIGN
-- KEY` scans the table and FAILS `migrate deploy` on an offending row. The
-- entrypoint re-runs that on every container start (P3009, the #2745 outage
-- shape). An offending row is plausible here: a legacy answer written before
-- G-3 may genuinely point at a `QuestionnaireQuestion`.
--
--   1. ADD ... NOT VALID — no scan, and from this statement on every INSERT and
--      every UPDATE is checked, which is what unblocks the feature.
--   2. VALIDATE only when no offending row exists. Otherwise RAISE WARNING with
--      the count and leave it NOT VALID for a person to look at.
--
-- Consequence while an offending row exists: NOT VALID still checks updates, so
-- that row refuses an UPDATE that keeps its questionId outside the template
-- table. DELETE is never checked.
--
-- Post-deploy, confirm with:
--   SELECT conname, convalidated FROM pg_constraint
--    WHERE conname = 'VendorAssessmentAnswer_questionId_fkey';
--   SELECT a.id, a."tenantId", a."questionId" FROM "VendorAssessmentAnswer" a
--    LEFT JOIN "VendorAssessmentTemplateQuestion" q ON q.id = a."questionId"
--    WHERE q.id IS NULL;
-- and, once the second query returns nothing:
--   ALTER TABLE "VendorAssessmentAnswer"
--     VALIDATE CONSTRAINT "VendorAssessmentAnswer_questionId_fkey";
--
-- FORWARD-ONLY. The constraint keeps its original NAME, so the Prisma relation
-- change in vendor.prisma produces no `migrate diff` residue.

ALTER TABLE "VendorAssessmentAnswer"
    DROP CONSTRAINT IF EXISTS "VendorAssessmentAnswer_questionId_fkey";

ALTER TABLE "VendorAssessmentAnswer"
    ADD CONSTRAINT "VendorAssessmentAnswer_questionId_fkey"
    FOREIGN KEY ("questionId")
    REFERENCES "VendorAssessmentTemplateQuestion"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
    NOT VALID;

DO $$
DECLARE
    offending INTEGER;
BEGIN
    SELECT COUNT(*) INTO offending
    FROM "VendorAssessmentAnswer" a
    LEFT JOIN "VendorAssessmentTemplateQuestion" q ON q.id = a."questionId"
    WHERE q.id IS NULL;

    IF offending = 0 THEN
        ALTER TABLE "VendorAssessmentAnswer"
            VALIDATE CONSTRAINT "VendorAssessmentAnswer_questionId_fkey";
    ELSE
        RAISE WARNING
            '#5068: % VendorAssessmentAnswer row(s) have a questionId that is not a '
            'VendorAssessmentTemplateQuestion — most likely legacy answers pointing at the '
            'retired QuestionnaireQuestion table. FK "VendorAssessmentAnswer_questionId_fkey" '
            'is left NOT VALID: new writes are enforced, so G-3 submissions work, and these '
            'rows refuse an update that keeps questionId outside the template table. '
            'A person must review them, then VALIDATE the constraint.',
            offending;
    END IF;
END $$;

-- POST-CONDITION: the constraint exists and points at the template table.
DO $$
DECLARE
    target TEXT;
BEGIN
    SELECT c.confrelid::regclass::text INTO target
    FROM pg_constraint c
    WHERE c.conname = 'VendorAssessmentAnswer_questionId_fkey'
      AND c.conrelid = '"VendorAssessmentAnswer"'::regclass;

    IF target IS NULL THEN
        RAISE EXCEPTION '#5068: VendorAssessmentAnswer_questionId_fkey is missing after this migration';
    END IF;
    IF target <> '"VendorAssessmentTemplateQuestion"' THEN
        RAISE EXCEPTION '#5068: questionId FK points at %, expected VendorAssessmentTemplateQuestion', target;
    END IF;
END $$;
