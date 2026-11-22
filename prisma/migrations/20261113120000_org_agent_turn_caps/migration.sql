-- #4594 (Step 2e, pull request B) — AN ORGANIZATION SETS THE CEILING OF TWO
-- PER-TURN CAPS FOR EVERY WORKSPACE UNDER IT, AND A WORKSPACE MAY ONLY NARROW.
--
-- Owner decision 3 of 2026-11-13. "Org-level turn caps" in
-- docs/claude-tool-runner-design.md is the design. The value that applies is
-- the lower of the organization's ceiling and the workspace's value, and a
-- NULL workspace value follows the organization.
--
-- ─── The enum value, added in one deploy ────────────────────────────
--
-- `ALTER TYPE … ADD VALUE` affects only a reader that ENCOUNTERS the value, and
-- only the new usecase (`usecases/org-agent-turn-caps.ts`) writes it — the
-- argument `20261030120000_org_agent_switches` made for the action before this
-- one. An old container reading the org audit log during the roll could meet a
-- row only if an org admin changed a ceiling inside that window.

ALTER TYPE "OrgAuditAction" ADD VALUE IF NOT EXISTS 'ORG_AGENT_TURN_CAPS_CHANGED';

-- ─── The two ceilings: today's behaviour as the default ─────────────
--
-- NOT NULL with a constant default, so the ADD is a catalogue change on
-- Postgres 11+ and rewrites no rows, and nothing moves on deploy: 3 is the
-- delegation cap every workspace holds today, and 1 is the serial request the
-- Tool Runner engine sends today. Each upper bound is 10, the top of the
-- tool-call range, because a turn cannot start more delegations than tool
-- calls. A delegation ceiling of 0 is legal and withdraws delegation for every
-- workspace under the organization; a tool-call ceiling of 0 is not, because
-- a turn that can call no tool is not a narrowing but a different engine.

ALTER TABLE "Organization"
    ADD COLUMN "agentMaxSubagentsPerTurn" INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN "agentMaxToolCallsPerTurn" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Organization"
    ADD CONSTRAINT "Organization_agentMaxSubagentsPerTurn_range"
    CHECK ("agentMaxSubagentsPerTurn" BETWEEN 0 AND 10),
    ADD CONSTRAINT "Organization_agentMaxToolCallsPerTurn_range"
    CHECK ("agentMaxToolCallsPerTurn" BETWEEN 1 AND 10);

-- ─── The workspace's tool-call narrowing: new, nullable ─────────────
--
-- NULL is "this workspace has not narrowed", so the organization's ceiling
-- applies. Every existing row reads NULL, which is today's behaviour under the
-- default ceiling of 1.

ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN "agentMaxToolCallsPerTurn" INTEGER;

ALTER TABLE "TenantSecuritySettings"
    ADD CONSTRAINT "TenantSecuritySettings_agentMaxToolCallsPerTurn_range"
    CHECK ("agentMaxToolCallsPerTurn" IS NULL OR "agentMaxToolCallsPerTurn" BETWEEN 1 AND 10);

-- ─── The workspace's delegation narrowing: relaxed, and the defaults cleared ─
--
-- The column moves to the shape its twin has: NULL follows the organization.
--
-- The stored 3s are cleared HERE, in the same migration, because this is the
-- last moment at which every one of them is certainly the 20261015060000
-- default: the column has had no writer since #3473, and this change adds the
-- first one. A later data migration could no longer tell a default from a
-- workspace that saved 3 on purpose, and would erase that choice.
--
-- One deploy is safe, measured rather than assumed: main's generated client
-- (Prisma 7.10.1) reads a NULL in its required `Int` as `null` without
-- throwing, and the only reader of the column, the previous build's
-- `readFanOutCap`, turns that into its default of 3, today's value. A previous
-- build that CREATES a settings row during the roll sends 3 itself (the schema
-- default lives in the client), which reads as a workspace narrowing to 3:
-- today's value again, and changeable on the security page.
--
-- The CHECK `TenantSecuritySettings_agentMaxSubagentsPerTurn_nonneg` (>= 0)
-- already admits NULL — a CHECK is satisfied by an unknown — so it stays as
-- written and is the "NULL or >= 0" the design names.

ALTER TABLE "TenantSecuritySettings"
    ALTER COLUMN "agentMaxSubagentsPerTurn" DROP NOT NULL,
    ALTER COLUMN "agentMaxSubagentsPerTurn" DROP DEFAULT;

UPDATE "TenantSecuritySettings"
   SET "agentMaxSubagentsPerTurn" = NULL
 WHERE "agentMaxSubagentsPerTurn" = 3;
