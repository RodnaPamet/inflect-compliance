-- A BIA NOW NAMES ITS PROCESS NODE BY THE KEY THE CLIENT CONSIDERS STABLE.
--
-- `BusinessImpactAnalysis.processNodeId` referenced `ProcessNode.id` — the row
-- cuid. It was the ONE reference in this schema pointing at a storage detail:
-- everything else in the graph (`ProcessEdge.sourceKey`/`targetKey`,
-- `ProcessNode.parentNodeKey`) references `nodeKey`, deliberately, because that
-- is the id the client keeps stable across saves.
--
-- That difference was not academic. Until #2967, saving a process map deleted
-- every node and recreated it with a fresh cuid, and the FK's ON DELETE SET
-- NULL nulled the BIA link on EVERY save — identical graph, no user edit,
-- autosave alone was enough. No error, no 409: the save succeeded and the
-- version bumped while the BIA came unattached from the process it analyses.
--
-- #2967 stopped the churn by preserving node identity. This removes the reason
-- it could happen, so a future bulk import, restore path or migration that
-- legitimately recreates nodes cannot bring it back.

-- ── 1. The new columns ──
ALTER TABLE "BusinessImpactAnalysis"
    ADD COLUMN IF NOT EXISTS "processMapId"   TEXT,
    ADD COLUMN IF NOT EXISTS "processNodeKey" TEXT;

-- ── 2. Backfill from the link that exists today ──
--
-- Every BIA that currently names a node keeps naming the same node, by a
-- different route. Rows with a NULL `processNodeId` stay null — they were never
-- attached to a node and this is not the place to invent one.
--
-- Scoped on tenantId as well as id: the old FK was (processNodeId, tenantId),
-- so joining on id alone would be a WIDER join than the constraint that has
-- been guarding these rows, and would silently pair a BIA with another
-- tenant's node if an id ever collided.
UPDATE "BusinessImpactAnalysis" AS b
   SET "processMapId"   = n."processMapId",
       "processNodeKey" = n."nodeKey"
  FROM "ProcessNode" AS n
 WHERE b."processNodeId" = n."id"
   AND b."tenantId"      = n."tenantId";

-- ── 3. The foreign key sits on the MAP, not the node ──
--
-- A constraint on the NODE would carry ON DELETE SET NULL, and that reproduces
-- the defect one layer along: deleting and recreating a node under the same key
-- — which a bulk import, a restore path or a future migration may legitimately
-- do — unlinks the BIA before the replacement exists. Measured, not assumed:
-- the first version of this migration had exactly that constraint, and the
-- delete-and-recreate test failed with `stillLinked: false`.
--
-- Naming the node by key makes "does this node exist right now" a READ-time
-- question, which is what it actually is. A node genuinely removed resolves to
-- nothing; a node recreated under the same key resolves again, because as far
-- as the product is concerned it is the same node.
--
-- The MAP keeps a real FK, so tenant isolation still fails on referential
-- integrity rather than on RLS alone, and deleting a map clears both columns.
-- Column-scoped SET NULL so `tenantId` survives — it is a tenancy column, not
-- part of what is being forgotten, and nulling it would orphan the row from its
-- tenant. Same reason #2356 moved the rest of these to the scoped form.
ALTER TABLE "BusinessImpactAnalysis"
    ADD CONSTRAINT "BusinessImpactAnalysis_processMapId_tenantId_fkey"
    FOREIGN KEY ("processMapId", "tenantId")
    REFERENCES "ProcessMap" ("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("processMapId");

-- ONLY `processMapId` is nulled, and not by choice: Postgres refuses a
-- column-scoped SET NULL naming a column outside the key —
--   "column processNodeKey referenced in ON DELETE SET action must be part of
--    foreign key"  (42P10)
-- — and `tenantId`, the other key column, must survive because nulling a
-- tenancy column orphans the row from its tenant.
--
-- So a deleted map leaves `processNodeKey` behind as a vestigial string. That
-- is inert: every read resolves a node by the PAIR, and a null `processMapId`
-- matches nothing, so the row reads as unlinked exactly as it should. The key
-- on its own names nothing and can address no node.

-- ── 4. Retire the cuid reference ──
--
-- Dropped in the SAME migration as the backfill, not left behind as a
-- deprecated column. A column nothing writes drifts from the truth the moment
-- the first row is created without it, and a half-migrated reference is the
-- state this change exists to remove — leaving one behind would reproduce the
-- ambiguity in a new place.
DROP INDEX IF EXISTS "BusinessImpactAnalysis_tenantId_processNodeId_idx";

ALTER TABLE "BusinessImpactAnalysis"
    DROP CONSTRAINT IF EXISTS "BusinessImpactAnalysis_processNodeId_tenantId_fkey";

ALTER TABLE "BusinessImpactAnalysis"
    DROP COLUMN IF EXISTS "processNodeId";

-- ── 5. The lookup index for the new shape ──
CREATE INDEX IF NOT EXISTS "BusinessImpactAnalysis_tenantId_processMapId_processNodeKey_idx"
    ON "BusinessImpactAnalysis" ("tenantId", "processMapId", "processNodeKey");
