-- #4557 — AN ORGANIZATION DECIDES THE TWO AGENT SWITCHES FOR ITS WORKSPACES.
--
-- `AGENT_PROFILES` and `AGENT_DRIVER_TOOL_RUNNER` were deployment-wide. They
-- are now read as three states (owner decision, 2026-10-30): `1` on everywhere,
-- any other set value off everywhere, and UNSET leaves each organization to
-- decide. These two columns hold that decision.
--
-- ─── Defaults: false, so nothing moves ──────────────────────────────
--
-- An UNSET variable used to mean "off". With every organization at false it
-- still does, for every workspace in every deployment, until an org admin turns
-- a switch on. The columns are NOT NULL with a constant default, so the ADD is a
-- catalogue change on Postgres 11+ and rewrites no rows.
--
-- ─── The enum value, added in one deploy ────────────────────────────
--
-- `ALTER TYPE … ADD VALUE` affects only a reader that ENCOUNTERS the value, and
-- only the new usecase writes it — the argument
-- `20261006090000_org_tenant_deleted_audit_action` made for the action before
-- this one. An old container reading the org audit log during the roll could
-- meet a row only if an org admin flipped a switch inside that window.

ALTER TYPE "OrgAuditAction" ADD VALUE IF NOT EXISTS 'ORG_AGENT_SWITCHES_CHANGED';

ALTER TABLE "Organization"
    ADD COLUMN "agentProfilesEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "agentToolRunnerEnabled" BOOLEAN NOT NULL DEFAULT false;
