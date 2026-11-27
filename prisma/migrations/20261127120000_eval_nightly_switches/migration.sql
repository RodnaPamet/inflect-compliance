-- OWNER DECISION 2026-11-27 — THE EVALUATION NIGHTLIES ARE SWITCHED IN THE PRODUCT.
--
-- garak, Ragas and Inspect run as GitHub Actions nightlies against a throwaway
-- copy of the app on the CI runner. Each was switched by a GitHub repository
-- variable (`GARAK_ENABLED`, `RAG_EVAL_ENABLED`, `AGENT_EVALS_ENABLED`). The
-- switch now lives here: a scheduled run asks production, over a read-only
-- endpoint behind a CI bearer token, whether its nightly is on, and stays off
-- on any answer but `true`. Production holds no GitHub credential.
--
-- ─── Platform-level, so no RLS ──────────────────────────────────────
--
-- The table has no tenantId and no organization axis to isolate on: the three
-- rows are deployment-wide state, read by the CI endpoint and by the org
-- settings card of every organization that shows it. It is written only by the
-- usecase, through the global client, after an ORG_OWNER of an operator
-- organization (`EVALS_SWITCH_ORG_SLUGS`) is checked. As
-- `PlatformAgentKillSwitch` (20260906090000), it carries no RLS policy.
--
-- ─── Absent is off ──────────────────────────────────────────────────
--
-- The table starts EMPTY and the reader treats a missing row as off, so this
-- migration turns nothing on. The scheduled runs were already off unless a
-- repository variable said otherwise; after this deploy they are off until an
-- operator's owner switches one on. A CHECK holds the key set, so a row for a
-- nightly the workflows do not ask about cannot be written.
--
-- ─── No DELETE for app_user ─────────────────────────────────────────
--
-- Turning a nightly off is an UPDATE to `enabled = false`, which keeps who did
-- it and when. A DELETE would erase that and read the same as "never switched".
--
-- ─── The enum value, added in one deploy ────────────────────────────
--
-- `ALTER TYPE … ADD VALUE` affects only a reader that ENCOUNTERS the value, and
-- only the new usecase writes it — the argument
-- `20261030120000_org_agent_switches` made for `ORG_AGENT_SWITCHES_CHANGED`.
-- An old container reading the org audit log during the roll could meet a row
-- only if an operator's owner flipped a switch inside that window.

ALTER TYPE "OrgAuditAction" ADD VALUE IF NOT EXISTS 'ORG_EVAL_NIGHTLY_SWITCHED';

CREATE TABLE "EvalNightlySwitch" (
    "nightly" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedByUserId" TEXT,
    "changedInOrganizationId" TEXT,

    CONSTRAINT "EvalNightlySwitch_pkey" PRIMARY KEY ("nightly"),
    CONSTRAINT "EvalNightlySwitch_nightly_known" CHECK ("nightly" IN ('garak', 'ragas', 'inspect'))
);

CREATE INDEX "EvalNightlySwitch_changedByUserId_idx" ON "EvalNightlySwitch"("changedByUserId");
CREATE INDEX "EvalNightlySwitch_changedInOrganizationId_idx" ON "EvalNightlySwitch"("changedInOrganizationId");

ALTER TABLE "EvalNightlySwitch"
    ADD CONSTRAINT "EvalNightlySwitch_changedByUserId_fkey"
    FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EvalNightlySwitch"
    ADD CONSTRAINT "EvalNightlySwitch_changedInOrganizationId_fkey"
    FOREIGN KEY ("changedInOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "EvalNightlySwitch" TO app_user;
        REVOKE DELETE ON "EvalNightlySwitch" FROM app_user;
    END IF;
END
$$;
