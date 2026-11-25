-- #5937 step 2 — the calendar writer's DISCONNECT state.
--
-- A person who disconnects their calendar has the events Inflect pushed
-- removed FIRST and the token dropped AFTER. When some removals fail (a
-- provider outage, a throttle, more events than one request removes), the
-- connection is marked as disconnecting: it keeps its token, the nightly run
-- retries only the removals, and it is revoked when they are done or after a
-- bounded number of days (docs/calendar-push-design.md, "Disconnect").
--
-- ADDITIVE AND FORWARD-ONLY: one nullable column, NULL on every existing row,
-- which is what a live connection reads as. An older container neither selects
-- nor writes it. No index: the per-tenant push scan already reads every live
-- connection of a tenant and branches on the value in memory. RLS and grants
-- are the table's own and are unchanged.

ALTER TABLE "UserCalendarConnection" ADD COLUMN "disconnectRequestedAt" TIMESTAMP(3);
