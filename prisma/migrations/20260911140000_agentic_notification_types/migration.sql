-- AGENTIC UI 1/4 (#2441) — the first two agentic in-app notification types.
--
-- ENGAGED has no lifted counterpart, and QUARANTINED has no CREATED
-- counterpart; both omissions are deliberate and the reasoning lives beside
-- the enum members in prisma/schema/enums.prisma.
--
-- ROLLING-DEPLOY SAFETY. `ADD VALUE` only — no value is renamed and none is
-- dropped, so an old container that has never heard of these two keeps
-- reading and writing every value it knows. (Postgres cannot drop an enum
-- value without recreating the type, and an `ALTER TYPE … RENAME` mid-deploy
-- makes still-running containers fail with SQLSTATE 42704 — the lesson the
-- `@@map("WorkItem*")` pins record.)
--
-- `IF NOT EXISTS` matches every prior NotificationType migration in this
-- folder, so a re-run is a no-op rather than a failed deploy.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'AGENT_KILL_SWITCH_ENGAGED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'AGENT_PROPOSAL_QUARANTINED';
