-- #5066 — the two shipped questionnaire templates say what scale their
-- thresholds are on.
--
-- `vendor-questionnaire-supplier-security-assessment.json` and
-- `…-supplier-due-diligence.json` carry
-- `{"mode":"WEIGHTED_AVERAGE","ratingThresholds":[LOW 0-25, MEDIUM 26-50,
-- HIGH 51-75, CRITICAL 76-100]}` and NO `thresholdScale`. The engine reads an
-- absent scale as RAW and brackets `score` — which in WEIGHTED_AVERAGE is
-- points-per-unit-weight, and with option points in [-10,10] cannot exceed
-- about 10 — against buckets authored 0-100. Every achievable score lands in
-- the first bucket, so EVERY vendor auto-rated LOW whatever it answered; that
-- rating was written to `VendorAssessment.riskRating` and stamped onto
-- `Vendor.inherentRisk`. The engine's own comment at
-- `vendor-assessment-scoring-engine.ts:185` describes this exact defect.
--
-- The engine supports the fix already (`thresholdScale === 'PERCENT'` →
-- `toPercentScore`), and `prisma/aisvs-vendor-questionnaire.ts:111` declares
-- it. These two JSON fixtures never did. The parser also used to drop the
-- field, which #5136 fixed (PR #5468) — so the only thing still missing is the
-- declaration itself.
--
-- ─── WHY A MIGRATION AND NOT JUST THE FIXTURE ───────────────────────────────
--
-- Both seeders are idempotent by SKIPPING: `prisma/seed.ts` does
-- `if (existingVq) continue;` and `scripts/seed-vendor-questionnaires.ts` does
-- `if (existing) return false; // idempotent`. `scripts/entrypoint.sh` runs the
-- latter on every container start, so every existing tenant already holds a row
-- with the broken config and NO redeploy will ever update it. Editing the
-- fixture alone fixes new tenants and nobody else.
--
-- ─── WHY THE WHERE CLAUSE IS THIS NARROW ────────────────────────────────────
--
-- A tenant may have customised its copy. `ratingThresholds` is compared to the
-- shipped array EXACTLY, so a row whose thresholds were edited is left alone
-- even if it still lacks the scale — its author chose those numbers and we
-- cannot know which scale they meant. Likewise a row that already declares a
-- scale (either value) is never rewritten. The update is therefore idempotent
-- and safe to re-run.
--
-- FORWARD-ONLY, and deliberately NOT a recompute: existing persisted ratings
-- stay exactly as recorded (owner decision, 2026-11-13). This changes what
-- FUTURE reviews suggest, not the history. A vendor currently rated LOW by this
-- defect keeps that rating until somebody reviews the assessment again.

UPDATE "VendorAssessmentTemplate"
   SET "scoringConfigJson" = jsonb_set("scoringConfigJson", '{thresholdScale}', '"PERCENT"'::jsonb, true)
 WHERE "key" IN ('SUPPLIER_SECURITY_ASSESSMENT', 'SUPPLIER_DUE_DILIGENCE')
   AND "scoringConfigJson" IS NOT NULL
   AND NOT ("scoringConfigJson" ? 'thresholdScale')
   AND "scoringConfigJson"->>'mode' = 'WEIGHTED_AVERAGE'
   AND "scoringConfigJson"->'ratingThresholds' = '[
         {"rating":"LOW","minScore":0,"maxScore":25},
         {"rating":"MEDIUM","minScore":26,"maxScore":50},
         {"rating":"HIGH","minScore":51,"maxScore":75},
         {"rating":"CRITICAL","minScore":76,"maxScore":100}
       ]'::jsonb;

-- Report what moved, and what was deliberately left behind, so the deploy log
-- carries the figure rather than requiring somebody to go and count.
DO $$
DECLARE
    still_raw  INTEGER;
    customised INTEGER;
BEGIN
    SELECT COUNT(*) INTO still_raw
      FROM "VendorAssessmentTemplate"
     WHERE "key" IN ('SUPPLIER_SECURITY_ASSESSMENT', 'SUPPLIER_DUE_DILIGENCE')
       AND "scoringConfigJson" IS NOT NULL
       AND NOT ("scoringConfigJson" ? 'thresholdScale');

    SELECT COUNT(*) INTO customised
      FROM "VendorAssessmentTemplate"
     WHERE "key" IN ('SUPPLIER_SECURITY_ASSESSMENT', 'SUPPLIER_DUE_DILIGENCE')
       AND "scoringConfigJson" IS NOT NULL
       AND NOT ("scoringConfigJson" ? 'thresholdScale')
       AND "scoringConfigJson"->'ratingThresholds' <> '[
             {"rating":"LOW","minScore":0,"maxScore":25},
             {"rating":"MEDIUM","minScore":26,"maxScore":50},
             {"rating":"HIGH","minScore":51,"maxScore":75},
             {"rating":"CRITICAL","minScore":76,"maxScore":100}
           ]'::jsonb;

    IF still_raw > 0 THEN
        RAISE WARNING
            '#5066: % row(s) of the two shipped questionnaire keys still declare no thresholdScale, '
            'of which % have CUSTOMISED ratingThresholds and were deliberately left alone — their '
            'author chose those numbers and the intended scale is unknowable from here. Any remainder '
            'has an unexpected mode. Review them by hand; the engine reads an absent scale as RAW.',
            still_raw, customised;
    END IF;
END $$;
