-- `risk` and `asset` nodes on the process canvas link to their Risk and Asset
-- records through real tables, as `control` nodes do since
-- 20261119120000_process_node_control_link. This retires the last use of
-- `ProcessNode.dataJson.linkedEntityId` as a link: no foreign key, no tenant
-- check at save, a JSON-path read in traceability, and a stale string after the
-- record was deleted.
--
-- Same shape and rules as `ProcessNodeControl`: one row per linked node, rebuilt
-- by `replaceGraph` from the save payload in the transaction that upserts the
-- nodes; composite (nodeId, tenantId) and (<entity>Id, tenantId) keys make a
-- cross-tenant link unrepresentable; cascades on node, map and record delete.
--
-- ROLLBACK SAFETY: the backfill COPIES the JSON link and does not strip it, so a
-- previous image keeps reading every risk and asset node's link for maps nobody
-- has saved since this deploy. The new save path strips the key from a node it
-- writes; on a previous image such a node reads as unlinked in traceability (a
-- missing placement, never a wrong one).

-- CreateTable
CREATE TABLE "ProcessNodeRisk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "processMapId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "riskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessNodeRisk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcessNodeRisk_tenantId_processMapId_idx" ON "ProcessNodeRisk"("tenantId", "processMapId");

-- CreateIndex
CREATE INDEX "ProcessNodeRisk_tenantId_riskId_idx" ON "ProcessNodeRisk"("tenantId", "riskId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessNodeRisk_nodeId_tenantId_key" ON "ProcessNodeRisk"("nodeId", "tenantId");

-- AddForeignKey
ALTER TABLE "ProcessNodeRisk" ADD CONSTRAINT "ProcessNodeRisk_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNodeRisk" ADD CONSTRAINT "ProcessNodeRisk_processMapId_tenantId_fkey" FOREIGN KEY ("processMapId", "tenantId") REFERENCES "ProcessMap"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNodeRisk" ADD CONSTRAINT "ProcessNodeRisk_nodeId_tenantId_fkey" FOREIGN KEY ("nodeId", "tenantId") REFERENCES "ProcessNode"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNodeRisk" ADD CONSTRAINT "ProcessNodeRisk_riskId_tenantId_fkey" FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "ProcessNodeRisk" TO app_user;

ALTER TABLE "ProcessNodeRisk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProcessNodeRisk" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "ProcessNodeRisk";
CREATE POLICY tenant_isolation ON "ProcessNodeRisk"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "ProcessNodeRisk";
CREATE POLICY tenant_isolation_insert ON "ProcessNodeRisk"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "ProcessNodeRisk";
CREATE POLICY superuser_bypass ON "ProcessNodeRisk"
    USING (current_setting('role') != 'app_user');

-- CreateTable
CREATE TABLE "ProcessNodeAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "processMapId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessNodeAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcessNodeAsset_tenantId_processMapId_idx" ON "ProcessNodeAsset"("tenantId", "processMapId");

-- CreateIndex
CREATE INDEX "ProcessNodeAsset_tenantId_assetId_idx" ON "ProcessNodeAsset"("tenantId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessNodeAsset_nodeId_tenantId_key" ON "ProcessNodeAsset"("nodeId", "tenantId");

-- AddForeignKey
ALTER TABLE "ProcessNodeAsset" ADD CONSTRAINT "ProcessNodeAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNodeAsset" ADD CONSTRAINT "ProcessNodeAsset_processMapId_tenantId_fkey" FOREIGN KEY ("processMapId", "tenantId") REFERENCES "ProcessMap"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNodeAsset" ADD CONSTRAINT "ProcessNodeAsset_nodeId_tenantId_fkey" FOREIGN KEY ("nodeId", "tenantId") REFERENCES "ProcessNode"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessNodeAsset" ADD CONSTRAINT "ProcessNodeAsset_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "ProcessNodeAsset" TO app_user;

ALTER TABLE "ProcessNodeAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProcessNodeAsset" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "ProcessNodeAsset";
CREATE POLICY tenant_isolation ON "ProcessNodeAsset"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "ProcessNodeAsset";
CREATE POLICY tenant_isolation_insert ON "ProcessNodeAsset"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "ProcessNodeAsset";
CREATE POLICY superuser_bypass ON "ProcessNodeAsset"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- Backfill from the JSON link
-- ═══════════════════════════════════════════════════════════════════
-- `md5(...)` gives each row a deterministic id without an extension.

-- Backfill `risk` nodes: a same-tenant Risk only (the join on (id, tenantId) is
-- the tenant check the old save path never made); a soft-deleted risk is
-- still the tenant's and is kept.
INSERT INTO "ProcessNodeRisk" ("id", "tenantId", "processMapId", "nodeId", "riskId")
SELECT
    'pnr_' || md5(n."id"),
    n."tenantId",
    n."processMapId",
    n."id",
    e."id"
FROM "ProcessNode" n
JOIN "Risk" e
  ON e."id" = n."dataJson"->>'linkedEntityId'
 AND e."tenantId" = n."tenantId"
WHERE n."nodeType" = 'risk'
  AND jsonb_typeof(n."dataJson") = 'object'
  AND jsonb_typeof(n."dataJson"->'linkedEntityId') = 'string'
ON CONFLICT DO NOTHING;

-- Backfill `asset` nodes: a same-tenant Asset only (the join on (id, tenantId) is
-- the tenant check the old save path never made); a soft-deleted asset is
-- still the tenant's and is kept.
INSERT INTO "ProcessNodeAsset" ("id", "tenantId", "processMapId", "nodeId", "assetId")
SELECT
    'pna_' || md5(n."id"),
    n."tenantId",
    n."processMapId",
    n."id",
    e."id"
FROM "ProcessNode" n
JOIN "Asset" e
  ON e."id" = n."dataJson"->>'linkedEntityId'
 AND e."tenantId" = n."tenantId"
WHERE n."nodeType" = 'asset'
  AND jsonb_typeof(n."dataJson") = 'object'
  AND jsonb_typeof(n."dataJson"->'linkedEntityId') = 'string'
ON CONFLICT DO NOTHING;
