-- ═══════════════════════════════════════════════════════════════════
-- #2356 batch 1 of 8 — the Asset/Task connected component.
--
-- 5 composite parent keys + 10 single-column child FKs rewritten to the
-- tenant-carrying composite form. Referential actions UNCHANGED: all ten
-- are `ON DELETE CASCADE` before and after.
--
-- ─── Why ────────────────────────────────────────────────────────────
--
-- Postgres runs foreign-key checks AS THE TABLE OWNER, which bypasses
-- row-level security. RLS does not constrain what a FK will accept. So a
-- single-column `xId -> Target(id)` between two tenant-scoped tables makes a
-- CROSS-TENANT reference REPRESENTABLE at the database, however carefully the
-- application filters. A composite `[xId, tenantId] -> Target[id, tenantId]`
-- makes it unrepresentable.
--
-- Hardening, not a live bug. Every site is already defended at the
-- application layer, and reaching a foreign tenant's id also requires
-- KNOWING an id RLS prevents reading. Production was checked for the first
-- instance of this class (#2355, `RegisteredAgent.vendor`): 0 cross-tenant
-- pairs. What this buys is the second isolation layer CLAUDE.md says should
-- exist, enforced by the database rather than by every future caller.
--
-- Precedent: 20260906190000_registered_agent_vendor_composite_fk (1 site) and
-- 20260907120000_tenant_scoped_fks_composite_mechanical (35 sites).
--
-- ─── Why THESE five targets, and all five together ──────────────────
--
-- Measured on prisma/schema at 3b554bfed: 85 single-column FK sites between
-- tenant-scoped models across 45 distinct targets; 71 sites / 39 targets are
-- blocked on the target lacking `@@unique([id, tenantId])`.
--
-- Batching those 71 by CONNECTED COMPONENT of the target↔referencing-model
-- graph yields 22 components. This is the largest: 5 targets, 18 sites.
--
--     Asset, Task, FileRecord, ScannerRun, RiskSuggestionSession
--
-- They are one component because their children join them: `Evidence` points
-- at Asset AND Task AND FileRecord, `AssetVulnerability` at Asset AND Task,
-- `ScannerFinding` at Asset AND ScannerRun, `RiskSuggestionItem` at Asset AND
-- RiskSuggestionSession. Splitting the component to hit a target count would
-- put two halves of one model block in two PRs.
--
-- ─── What this migration deliberately does NOT convert ──────────────
--
-- 8 of the component's 18 sites are effectively `ON DELETE SET NULL` today —
-- 3 declared, 5 inherited from a nullable FK column, which Prisma resolves to
-- SetNull. They are NOT in this migration:
--
--     AccessReview.evidenceFileRecordId  -> FileRecord   (declared)
--     AssetVulnerability.remediationTaskId -> Task       (declared)
--     ScannerFinding.assetId             -> Asset        (declared)
--     Evidence.assetId                   -> Asset        (implicit)
--     Evidence.taskId                    -> Task         (implicit)
--     Evidence.fileRecordId              -> FileRecord   (implicit)
--     FileRecord.previousFileRecordId    -> FileRecord   (implicit)
--     RiskSuggestionItem.assetId         -> Asset        (implicit)
--
-- Converting one means choosing a new referential action, because a composite
-- SET NULL is not available to us:
--
--   • Prisma's DSL cannot express Postgres 15+ `ON DELETE SET NULL (col)`.
--     Writing plain `SetNull` on a composite relation only WARNS, validates,
--     and emits the two-column form — which nulls `tenantId` too and aborts
--     the parent delete with `23502 null value in column "tenantId"`, a NOT
--     NULL error naming a column the DELETE never mentioned. That is the
--     defect 20260911120000_controlexception_setnull_column_scoped just fixed.
--   • Installing the column-scoped form in raw SQL works (measured on 16.13)
--     but is invisible to Prisma introspection, so it would ADD permanent
--     schema-vs-DB drift — the thing #2367's gate exists to forbid.
--   • `Restrict` is expressible and drift-free, but CHANGES DELETE BEHAVIOUR,
--     and all three targets are hard-deletable on a LIVE path:
--       - `purgeEntity` (src/app-layer/usecases/soft-delete-operations.ts)
--         issues `DELETE FROM "Asset" WHERE "id" = $1 AND "tenantId" = $2`,
--         reached from POST /api/t/[tenantSlug]/assets/[id]/purge;
--       - `purgeSoftDeletedOlderThan` (src/app-layer/jobs/data-lifecycle.ts,
--         registered as the `data-lifecycle` executor) issues
--         `DELETE FROM "<Model>" WHERE "id" = $1` for every member of
--         SOFT_DELETE_MODELS, which includes Asset, Task AND FileRecord.
--     The sweep's per-row loop has no try/catch and `runJob` re-throws, so one
--     refusal stops the whole sweep for all thirteen models.
--
-- So each of the 8 is a product decision about what deleting an asset, a task
-- or a file version should do to the rows pointing at it — the same decision
-- GROUP 3 of prisma/fresh-db-schema-drift.expected.sql files rather than
-- guesses for `ControlException`. Filed, not smuggled in here.
--
-- `FileRecord` therefore gets its composite key with no FK referencing it yet:
-- all three of its children are in that set. The key is additive and
-- drift-free, and landing it here keeps the follow-up decision PR free of
-- index work on a table this component already owns.
--
-- ─── Safety ─────────────────────────────────────────────────────────
--
-- The DO block below refuses the migration with a NAMED, counted error if any
-- row already violates a constraint it is about to add. Without it, the first
-- offending row surfaces as an opaque FK failure on an ALTER halfway down the
-- file, and the operator has to guess which of ten.
--
-- The five `CREATE UNIQUE INDEX` statements cannot themselves fail on
-- duplicates: `id` is already each table's primary key, so `(id, tenantId)` is
-- unique by construction. They do take a SHARE lock for the index build, which
-- blocks writes to Asset / Task / FileRecord / ScannerRun /
-- RiskSuggestionSession for its duration — see the PR's risk assessment.
--
-- ─── Rollback ───────────────────────────────────────────────────────
--
-- docs/change-management-policy.md is forward-fix, never revert. The forward
-- fix is a new migration that drops each composite constraint and restores the
-- single-column one (`FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON
-- DELETE CASCADE ON UPDATE CASCADE`), plus the matching one-line revert in
-- prisma/schema so the drift gate stays green. The five unique indexes can be
-- left in place — they are additive and harmless.
-- ═══════════════════════════════════════════════════════════════════

-- ── Precondition: no existing row already violates these constraints ──
--
-- Named and counted per site, so a refusal says which table and how many
-- rows rather than which ALTER happened to run first.

DO $$
DECLARE
    site      RECORD;
    offending BIGINT;
    total     BIGINT := 0;
    detail    TEXT   := '';
BEGIN
    FOR site IN
        SELECT * FROM (VALUES
            ('AssetRiskLink',      'assetId',      'Asset'),
            ('AssetVulnerability', 'assetId',      'Asset'),
            ('ControlAsset',       'assetId',      'Asset'),
            ('EvidenceAssetLink',  'assetId',      'Asset'),
            ('FindingAsset',       'assetId',      'Asset'),
            ('RiskSuggestionItem', 'sessionId',    'RiskSuggestionSession'),
            ('ScannerFinding',     'scannerRunId', 'ScannerRun'),
            ('TaskComment',        'taskId',       'Task'),
            ('TaskLink',           'taskId',       'Task'),
            ('TaskWatcher',        'taskId',       'Task')
        ) AS t(child, fkcol, parent)
    LOOP
        EXECUTE format(
            'SELECT count(*) FROM %I c JOIN %I p ON p."id" = c.%I '
            'WHERE c."tenantId" IS DISTINCT FROM p."tenantId"',
            site.child, site.parent, site.fkcol
        ) INTO offending;

        IF offending > 0 THEN
            total  := total + offending;
            detail := detail || '  ' || site.child || '.' || site.fkcol
                      || ' -> ' || site.parent || ': ' || offending || E' row(s)\n';
        END IF;
    END LOOP;

    IF total > 0 THEN
        RAISE EXCEPTION
            E'#2356 batch 1 refused: % cross-tenant reference(s) already exist and would violate the composite foreign keys this migration adds.\n%Repair the rows (re-point or delete them) and re-run. Do NOT relax the constraint.',
            total, detail;
    END IF;
END
$$;

-- ── Composite parent keys ──────────────────────────────────────────
--
-- `(id, tenantId)` — the key a tenant-carrying child FK references. `id` is
-- already the primary key of each of these tables, so no row can collide.

-- CreateIndex
CREATE UNIQUE INDEX "Asset_id_tenantId_key" ON "Asset"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FileRecord_id_tenantId_key" ON "FileRecord"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RiskSuggestionSession_id_tenantId_key" ON "RiskSuggestionSession"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ScannerRun_id_tenantId_key" ON "ScannerRun"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_id_tenantId_key" ON "Task"("id", "tenantId");

-- ── Drop the single-column constraints ─────────────────────────────

-- DropForeignKey
ALTER TABLE "AssetRiskLink" DROP CONSTRAINT "AssetRiskLink_assetId_fkey";

-- DropForeignKey
ALTER TABLE "AssetVulnerability" DROP CONSTRAINT "AssetVulnerability_assetId_fkey";

-- DropForeignKey
ALTER TABLE "ControlAsset" DROP CONSTRAINT "ControlAsset_assetId_fkey";

-- DropForeignKey
ALTER TABLE "EvidenceAssetLink" DROP CONSTRAINT "EvidenceAssetLink_assetId_fkey";

-- DropForeignKey
ALTER TABLE "FindingAsset" DROP CONSTRAINT "FindingAsset_assetId_fkey";

-- DropForeignKey
ALTER TABLE "RiskSuggestionItem" DROP CONSTRAINT "RiskSuggestionItem_sessionId_fkey";

-- DropForeignKey
ALTER TABLE "ScannerFinding" DROP CONSTRAINT "ScannerFinding_scannerRunId_fkey";

-- DropForeignKey
ALTER TABLE "TaskComment" DROP CONSTRAINT "TaskComment_taskId_fkey";

-- DropForeignKey
ALTER TABLE "TaskLink" DROP CONSTRAINT "TaskLink_taskId_fkey";

-- DropForeignKey
ALTER TABLE "TaskWatcher" DROP CONSTRAINT "TaskWatcher_taskId_fkey";

-- ── Add the tenant-carrying composite constraints ──────────────────
--
-- ON DELETE CASCADE on every one of these ten, which is what they already
-- were. Only the column list changes.

-- AddForeignKey
ALTER TABLE "AssetVulnerability" ADD CONSTRAINT "AssetVulnerability_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScannerFinding" ADD CONSTRAINT "ScannerFinding_scannerRunId_tenantId_fkey" FOREIGN KEY ("scannerRunId", "tenantId") REFERENCES "ScannerRun"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetRiskLink" ADD CONSTRAINT "AssetRiskLink_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingAsset" ADD CONSTRAINT "FindingAsset_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlAsset" ADD CONSTRAINT "ControlAsset_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceAssetLink" ADD CONSTRAINT "EvidenceAssetLink_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskSuggestionItem" ADD CONSTRAINT "RiskSuggestionItem_sessionId_tenantId_fkey" FOREIGN KEY ("sessionId", "tenantId") REFERENCES "RiskSuggestionSession"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskLink" ADD CONSTRAINT "TaskLink_taskId_tenantId_fkey" FOREIGN KEY ("taskId", "tenantId") REFERENCES "Task"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_taskId_tenantId_fkey" FOREIGN KEY ("taskId", "tenantId") REFERENCES "Task"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskWatcher" ADD CONSTRAINT "TaskWatcher_taskId_tenantId_fkey" FOREIGN KEY ("taskId", "tenantId") REFERENCES "Task"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Post-condition: all ten landed composite and tenant-carrying ───
--
-- A green migration that silently kept a single-column constraint would be
-- worse than a red one: the schema would claim protection the database does
-- not provide. Asserted on pg_constraint rather than inferred.

DO $$
DECLARE
    site   RECORD;
    cols   TEXT[];
    refs   TEXT[];
    deltyp "char";
BEGIN
    FOR site IN
        SELECT * FROM (VALUES
            ('AssetRiskLink',      'AssetRiskLink_assetId_tenantId_fkey',           'assetId',      'Asset'),
            ('AssetVulnerability', 'AssetVulnerability_assetId_tenantId_fkey',      'assetId',      'Asset'),
            ('ControlAsset',       'ControlAsset_assetId_tenantId_fkey',            'assetId',      'Asset'),
            ('EvidenceAssetLink',  'EvidenceAssetLink_assetId_tenantId_fkey',       'assetId',      'Asset'),
            ('FindingAsset',       'FindingAsset_assetId_tenantId_fkey',            'assetId',      'Asset'),
            ('RiskSuggestionItem', 'RiskSuggestionItem_sessionId_tenantId_fkey',    'sessionId',    'RiskSuggestionSession'),
            ('ScannerFinding',     'ScannerFinding_scannerRunId_tenantId_fkey',     'scannerRunId', 'ScannerRun'),
            ('TaskComment',        'TaskComment_taskId_tenantId_fkey',              'taskId',       'Task'),
            ('TaskLink',           'TaskLink_taskId_tenantId_fkey',                 'taskId',       'Task'),
            ('TaskWatcher',        'TaskWatcher_taskId_tenantId_fkey',              'taskId',       'Task')
        ) AS t(child, conname, fkcol, parent)
    LOOP
        SELECT c.confdeltype,
               ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                     ORDER BY k.ord),
               ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                     ORDER BY k.ord)
          INTO deltyp, cols, refs
          FROM pg_constraint c
         WHERE c.contype  = 'f'
           AND c.conname  = site.conname
           AND c.conrelid = format('%I', site.child)::regclass
           AND c.confrelid = format('%I', site.parent)::regclass;

        IF deltyp IS NULL THEN
            RAISE EXCEPTION
                '#2356 batch 1: composite constraint % on % -> % is missing',
                site.conname, site.child, site.parent;
        END IF;

        IF cols IS DISTINCT FROM ARRAY[site.fkcol, 'tenantId']
           OR refs IS DISTINCT FROM ARRAY['id', 'tenantId'] THEN
            RAISE EXCEPTION
                '#2356 batch 1: % did not land tenant-carrying: referencing %, references %; expected (%, tenantId) -> (id, tenantId)',
                site.conname, cols, refs, site.fkcol;
        END IF;

        -- Every one of the ten was CASCADE before this migration and must
        -- still be CASCADE after it. 'c' = ON DELETE CASCADE.
        IF deltyp <> 'c' THEN
            RAISE EXCEPTION
                '#2356 batch 1: % changed its ON DELETE action to confdeltype=%; this migration must not move referential semantics (expected c = CASCADE)',
                site.conname, deltyp;
        END IF;
    END LOOP;

    -- And the single-column constraints must be GONE, not merely shadowed by
    -- a second composite one. Two constraints on the same column would leave
    -- the cross-tenant reference refused for the wrong reason today and
    -- permitted again the moment someone drops "the duplicate".
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE contype = 'f'
           AND conname IN (
               'AssetRiskLink_assetId_fkey', 'AssetVulnerability_assetId_fkey',
               'ControlAsset_assetId_fkey', 'EvidenceAssetLink_assetId_fkey',
               'FindingAsset_assetId_fkey', 'RiskSuggestionItem_sessionId_fkey',
               'ScannerFinding_scannerRunId_fkey', 'TaskComment_taskId_fkey',
               'TaskLink_taskId_fkey', 'TaskWatcher_taskId_fkey'
           )
    ) THEN
        RAISE EXCEPTION
            '#2356 batch 1: a single-column constraint survived the rewrite';
    END IF;
END
$$;
