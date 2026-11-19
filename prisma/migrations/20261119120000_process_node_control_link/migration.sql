-- A `control` node on the process canvas links to its Control record through a
-- real table, replacing `ProcessNode.dataJson.linkedEntityId`.
--
-- Before: the link was a string inside an opaque JSON blob. Nothing in the UI
-- wrote it, it had no foreign key, `replaceGraph` checked it against no tenant,
-- and traceability read it with a JSON path query. A deleted control left the
-- string behind.
--
-- After: `ProcessNodeControl`, one row per linked node, written by
-- `replaceGraph` from the save payload in the same transaction as the nodes.
-- The composite (nodeId, tenantId) and (controlId, tenantId) keys make a
-- cross-tenant reference unrepresentable. Deleting the node, the map or the
-- control (a hard delete) cascades the link away.
--
-- ROLLBACK SAFETY: the backfill below COPIES the JSON link and does not strip
-- it. A previous image still reads `dataJson.linkedEntityId` and keeps working
-- for every map nobody has saved since this deploy. The new save path strips
-- the key from a control node it writes, so a map saved after the deploy and
-- then read by a previous image shows its control nodes as unlinked in
-- traceability: a missing placement, never a wrong one.

-- CreateTable
CREATE TABLE "ProcessNodeControl" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "processMapId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "controlId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessNodeControl_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcessNodeControl_tenantId_processMapId_idx" ON "ProcessNodeControl"("tenantId", "processMapId");

-- CreateIndex
CREATE INDEX "ProcessNodeControl_tenantId_controlId_idx" ON "ProcessNodeControl"("tenantId", "controlId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessNodeControl_nodeId_tenantId_key" ON "ProcessNodeControl"("nodeId", "tenantId");

-- AddForeignKey
ALTER TABLE "ProcessNodeControl" ADD CONSTRAINT "ProcessNodeControl_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNodeControl" ADD CONSTRAINT "ProcessNodeControl_processMapId_tenantId_fkey" FOREIGN KEY ("processMapId", "tenantId") REFERENCES "ProcessMap"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNodeControl" ADD CONSTRAINT "ProcessNodeControl_nodeId_tenantId_fkey" FOREIGN KEY ("nodeId", "tenantId") REFERENCES "ProcessNode"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNodeControl" ADD CONSTRAINT "ProcessNodeControl_controlId_tenantId_fkey" FOREIGN KEY ("controlId", "tenantId") REFERENCES "Control"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: the canonical triple
-- ═══════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE, DELETE ON "ProcessNodeControl" TO app_user;

ALTER TABLE "ProcessNodeControl" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProcessNodeControl" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "ProcessNodeControl";
CREATE POLICY tenant_isolation ON "ProcessNodeControl"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "ProcessNodeControl";
CREATE POLICY tenant_isolation_insert ON "ProcessNodeControl"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "ProcessNodeControl";
CREATE POLICY superuser_bypass ON "ProcessNodeControl"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- Backfill from the JSON link
-- ═══════════════════════════════════════════════════════════════════
-- Only a `control` node whose `linkedEntityId` names a Control of the SAME
-- tenant is carried over: the join on (id, tenantId) is the tenant check the
-- old save path never made, so a foreign or dead id is dropped rather than
-- stored. A soft-deleted control is still the tenant's (#5105) and is kept,
-- matching what the save path accepts. A node in a soft-deleted map is
-- backfilled too: the map can be restored, and its link should come with it.
--
-- `md5(...)` gives each row a deterministic id without an extension; the
-- column is an opaque TEXT primary key, as Prisma's cuids are.
INSERT INTO "ProcessNodeControl" ("id", "tenantId", "processMapId", "nodeId", "controlId")
SELECT
    'pnc_' || md5(n."id"),
    n."tenantId",
    n."processMapId",
    n."id",
    c."id"
FROM "ProcessNode" n
JOIN "Control" c
  ON c."id" = n."dataJson"->>'linkedEntityId'
 AND c."tenantId" = n."tenantId"
WHERE n."nodeType" = 'control'
  AND jsonb_typeof(n."dataJson") = 'object'
  AND jsonb_typeof(n."dataJson"->'linkedEntityId') = 'string'
ON CONFLICT DO NOTHING;
