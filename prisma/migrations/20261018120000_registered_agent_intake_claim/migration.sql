-- Step 2a (#3669), deploy 2 of the UNCLASSIFIED tier: the registration intake.
--
-- The intake turns a SHADOW_AGENT harness finding into a DRAFT RegisteredAgent
-- and a provisional AiSystem entry at UNCLASSIFIED, in one transaction. This
-- column is its idempotency claim: the DiscoveredAgent the row was registered
-- from, NULL for every agent registered any other way. The unique index is
-- what refuses a second intake for one discovered agent when two requests race;
-- Postgres treats NULLs as distinct, so no existing row is constrained and no
-- partial index is needed.
--
-- No FK: DiscoveredAgent already references RegisteredAgent, and a reference
-- back would make the pair a cycle neither side can be deleted out of row by
-- row. See the column's comment in prisma/schema/agentic.prisma.
--
-- Forward-only and additive. A nullable column with no default is a catalogue
-- change, and the previous image never selects it (Prisma names its columns),
-- so a rolling deploy is safe in either order. RLS on RegisteredAgent covers
-- the new column unchanged.

-- AlterTable
ALTER TABLE "RegisteredAgent" ADD COLUMN "intakeDiscoveredAgentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RegisteredAgent_tenantId_intakeDiscoveredAgentId_key" ON "RegisteredAgent"("tenantId", "intakeDiscoveredAgentId");
