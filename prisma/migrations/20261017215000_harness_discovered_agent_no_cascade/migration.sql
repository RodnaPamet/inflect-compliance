-- Scan items and acceptances no longer cascade from DiscoveredAgent (#3665).
--
-- The draft DPIA for the harness scanner (docs/agentic-harness-scanner-dpia.md,
-- step 0e) requires that nothing kept longer than a discovered agent is deleted
-- with it: a scan item is part of a scan's record and an acceptance is a risk
-- acceptance. 20261017210000 shipped both foreign keys ON DELETE CASCADE, so
-- deleting a DiscoveredAgent row would have taken its scan history and any
-- acceptance with it, silently.
--
-- NO ACTION makes such a delete fail instead. Nothing in the application
-- deletes a DiscoveredAgent; the tenant purge deletes children before parents
-- (its order is derived from these constraints), so it is unaffected.
--
-- A forward migration, not an edit: 20261017210000 is on main.
ALTER TABLE "AgentHarnessScanItem" DROP CONSTRAINT "AgentHarnessScanItem_discoveredAgentId_tenantId_fkey";
ALTER TABLE "AgentHarnessScanItem" ADD CONSTRAINT "AgentHarnessScanItem_discoveredAgentId_tenantId_fkey" FOREIGN KEY ("discoveredAgentId", "tenantId") REFERENCES "DiscoveredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "AgentHarnessAcceptance" DROP CONSTRAINT "AgentHarnessAcceptance_discoveredAgentId_tenantId_fkey";
ALTER TABLE "AgentHarnessAcceptance" ADD CONSTRAINT "AgentHarnessAcceptance_discoveredAgentId_tenantId_fkey" FOREIGN KEY ("discoveredAgentId", "tenantId") REFERENCES "DiscoveredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;
