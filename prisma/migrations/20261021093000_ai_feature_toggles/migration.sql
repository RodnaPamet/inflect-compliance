-- Per-tenant AI feature toggles, the UI-flippable half of the four env flags.
--
-- The env flags (`AI_RISK_ENABLED` and the three per-feature ones) are
-- process-global and read at module load, so nothing in the product can change
-- them at runtime. These columns are the per-tenant half, and the effective
-- answer is the AND of both:
--
--   effective = env_global AND env_feature AND tenant_toggle
--
-- The env keeps the power to force OFF because it is the kill switch: if a
-- tenant row could override an env `false`, an operator would have no way to
-- stop AI without a deploy.
--
-- DEFAULT TRUE, and the opposite of `processCanvasEnabled` on the same table.
-- A module is opt-in because granting it is a commercial act. These are not
-- grants — they say whether a tenant wants a capability the platform already
-- offers — so a tenant inherits whatever env allows and opting OUT is the
-- deliberate act. Defaulting false would silently withdraw AI from every
-- existing tenant the moment this migration ran.
ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN "aiEnabled"                BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "aiRiskSuggestionsEnabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "aiAssistantEnabled"       BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "aiQuestionnaireEnabled"   BOOLEAN NOT NULL DEFAULT true;
