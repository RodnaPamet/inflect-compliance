-- #3864 — does a connection reach a third-party BUSINESS SYSTEM (an ERP, a
-- finance or HR system of record) rather than a tool or a directory?
--
-- Recorded for the MCP route (M4/M5), which calls such APIs and so has to tell
-- kinds of connection apart. The A2A host-consumer policy guard deliberately
-- does NOT read it: a guard gated on a flag passes for exactly the connection
-- it exists to catch — one nobody remembered to flag — so that guard refuses
-- every external tool a host consumer's receiving agent holds instead.
--
-- NULLABLE WITH NO DEFAULT, three states on purpose. NULL is "nobody has
-- said"; `false` is a REVIEWED claim that this connection is not a business
-- system. A `DEFAULT false` would have written that claim onto every existing
-- row, asserting on behalf of a reviewer who never looked.
ALTER TABLE "IntegrationConnection"
    ADD COLUMN "reachesBusinessSystem" BOOLEAN;
