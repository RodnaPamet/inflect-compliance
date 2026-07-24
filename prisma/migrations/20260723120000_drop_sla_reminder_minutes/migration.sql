-- AutomationRule.slaReminderMinutes was an orphan column: accepted by the
-- create/update schemas and persisted by the repository, but no builder input
-- ever set it and the sla-monitor watchdog never read it (it reads only
-- slaWindowMinutes + slaBreachActionType/Config). A real reminder sweep would
-- also need a per-execution "reminder sent" marker to avoid re-notifying every
-- 5-minute pass; that is a separate feature, not this reserved column. Drop it.
ALTER TABLE "AutomationRule" DROP COLUMN IF EXISTS "slaReminderMinutes";
