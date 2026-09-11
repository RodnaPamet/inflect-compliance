-- ═══════════════════════════════════════════════════════════════════
-- #2356 carve-out: the EIGHT sites whose referential action is SET NULL.
--
-- Batch 1 (20260911150000) made ten Asset/Task-component FKs composite and
-- left these eight alone, because they are the sites where "make the FK
-- tenant-carrying" and "keep the referential action" pull against each
-- other. This migration does both, using the same column-scoped SET NULL
-- that 20260911120000_controlexception_setnull_column_scoped installed for
-- ControlException.
--
-- ─── Why these eight are not mechanical ────────────────────────────
--
-- A composite FK that carries `tenantId` cannot use plain SET NULL:
-- Postgres nulls EVERY referencing column, `tenantId` is NOT NULL, and the
-- parent delete aborts with SQLSTATE 23502 — reported against a column the
-- DELETE never mentioned. #2356's own header calls SetNull -> Restrict "a
-- real behavioural decision per site" rather than a mechanical
-- standardisation, and at these eight the evidence points away from
-- RESTRICT: every one is an OPTIONAL pointer whose parent has a live delete
-- path, and every one is currently ON DELETE SET NULL in the database.
--
--   AccessReview.evidenceFileRecordId    -> FileRecord
--   AssetVulnerability.remediationTaskId -> Task
--   ScannerFinding.assetId               -> Asset
--   Evidence.assetId                     -> Asset
--   Evidence.taskId                      -> Task
--   Evidence.fileRecordId                -> FileRecord
--   FileRecord.previousFileRecordId      -> FileRecord   (self-referential)
--   RiskSuggestionItem.assetId           -> Asset
--
-- RESTRICT would not preserve behaviour, it would MOVE the failure: the
-- data-lifecycle sweep (jobs/data-lifecycle.ts) hard-deletes Asset, Task
-- and FileRecord rows with raw SQL in a per-row loop with no try/catch, so
-- one un-purgeable parent stops the sweep for every soft-delete model after
-- it. That is the blast radius #2411 documented for ControlException,
-- reached here through three more parents.
--
-- ─── What changes, and what does not ───────────────────────────────
--
-- Changes: the FK gains `tenantId`, so a cross-tenant reference stops being
-- representable at the database. That is the whole point of #2356 — FK
-- checks run as the table owner and bypass RLS, so the application filter
-- is currently the only thing preventing it.
--
-- Does NOT change: the referential action. All eight are ON DELETE SET NULL
-- before this migration and ON DELETE SET NULL (<column>) after it. The
-- column list is the only difference, and it exists solely to keep
-- `tenantId` out of the nulling.
--
-- ─── Deliberate schema/DB divergence ───────────────────────────────
--
-- Prisma's DSL cannot express a column-scoped SET NULL. With a required
-- `tenantId` in the FK it renders RESTRICT, so prisma/schema will disagree
-- with the database on all eight — sixteen statements of expected residue
-- (one DROP + one ADD each), recorded verbatim in
-- prisma/fresh-db-schema-drift.expected.sql and pinned member-by-member in
-- tests/guardrails/schema-drift-gate-runs-in-ci.test.ts. The three relations
-- that declared `onDelete: SetNull` have it REMOVED in the same commit,
-- because Prisma rejects SetNull once a required field joins the FK.
--
-- Rollback: restore the single-column FKs. That re-opens the cross-tenant
-- reference. This repo forward-fixes (docs/change-management-policy.md).
-- ═══════════════════════════════════════════════════════════════════

-- ── Precondition: column-scoped SET NULL needs Postgres 15+ ────────
--
-- A named refusal rather than a bare syntax error 80 lines down. Every
-- compose file and CI service in this repo pins postgres:16-alpine.

DO $$
BEGIN
    IF current_setting('server_version_num')::int < 150000 THEN
        RAISE EXCEPTION
            '#2356 SET NULL carve-out needs Postgres 15+ for "ON DELETE SET NULL (column)"; this server is %',
            current_setting('server_version');
    END IF;
END
$$;

-- ── Precondition: no existing row already violates the composite ───
--
-- The single-column FK guarantees the parent id EXISTS; it says nothing
-- about whose tenant the parent is in. So the only way an existing row can
-- fail the new constraint is a genuine cross-tenant reference — exactly
-- what #2356 is about. Counting them FIRST turns what would surface as a
-- generic "insert or update violates foreign key constraint" on the ALTER
-- into a named error that says which table, which column and how many.

DO $$
DECLARE
    site     RECORD;
    offenders BIGINT;
    total    BIGINT := 0;
    report   TEXT := '';
BEGIN
    FOR site IN
        SELECT * FROM (VALUES
            ('AccessReview',       'evidenceFileRecordId', 'FileRecord'),
            ('AssetVulnerability', 'remediationTaskId',    'Task'),
            ('ScannerFinding',     'assetId',              'Asset'),
            ('Evidence',           'assetId',              'Asset'),
            ('Evidence',           'taskId',               'Task'),
            ('Evidence',           'fileRecordId',         'FileRecord'),
            ('FileRecord',         'previousFileRecordId', 'FileRecord'),
            ('RiskSuggestionItem', 'assetId',              'Asset')
        ) AS t(child, col, parent)
    LOOP
        EXECUTE format(
            'SELECT count(*) FROM %I c JOIN %I p ON p.id = c.%I WHERE c.%I IS NOT NULL AND p."tenantId" IS DISTINCT FROM c."tenantId"',
            site.child, site.parent, site.col, site.col
        ) INTO offenders;

        IF offenders > 0 THEN
            total := total + offenders;
            report := report || format(E'\n  %s.%s -> %s: %s row(s)', site.child, site.col, site.parent, offenders);
        END IF;
    END LOOP;

    IF total > 0 THEN
        RAISE EXCEPTION
            E'#2356 SET NULL carve-out: % existing row(s) reference a parent in ANOTHER tenant and would be refused by the composite FK.%\n\nThese are the cross-tenant references #2356 exists to make unrepresentable. They must be resolved (re-pointed or nulled) before this migration can apply.',
            total, report;
    END IF;
END
$$;

-- ── AccessReview.evidenceFileRecordId -> FileRecord ────────────────

ALTER TABLE "AccessReview"
    DROP CONSTRAINT "AccessReview_evidenceFileRecordId_fkey";

ALTER TABLE "AccessReview"
    ADD CONSTRAINT "AccessReview_evidenceFileRecordId_tenantId_fkey"
    FOREIGN KEY ("evidenceFileRecordId", "tenantId") REFERENCES "FileRecord"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("evidenceFileRecordId");

-- ── AssetVulnerability.remediationTaskId -> Task ───────────────────

ALTER TABLE "AssetVulnerability"
    DROP CONSTRAINT "AssetVulnerability_remediationTaskId_fkey";

ALTER TABLE "AssetVulnerability"
    ADD CONSTRAINT "AssetVulnerability_remediationTaskId_tenantId_fkey"
    FOREIGN KEY ("remediationTaskId", "tenantId") REFERENCES "Task"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("remediationTaskId");

-- ── ScannerFinding.assetId -> Asset ────────────────────────────────

ALTER TABLE "ScannerFinding"
    DROP CONSTRAINT "ScannerFinding_assetId_fkey";

ALTER TABLE "ScannerFinding"
    ADD CONSTRAINT "ScannerFinding_assetId_tenantId_fkey"
    FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("assetId");

-- ── Evidence.assetId -> Asset ──────────────────────────────────────

ALTER TABLE "Evidence"
    DROP CONSTRAINT "Evidence_assetId_fkey";

ALTER TABLE "Evidence"
    ADD CONSTRAINT "Evidence_assetId_tenantId_fkey"
    FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("assetId");

-- ── Evidence.taskId -> Task ────────────────────────────────────────

ALTER TABLE "Evidence"
    DROP CONSTRAINT "Evidence_taskId_fkey";

ALTER TABLE "Evidence"
    ADD CONSTRAINT "Evidence_taskId_tenantId_fkey"
    FOREIGN KEY ("taskId", "tenantId") REFERENCES "Task"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("taskId");

-- ── Evidence.fileRecordId -> FileRecord ────────────────────────────

ALTER TABLE "Evidence"
    DROP CONSTRAINT "Evidence_fileRecordId_fkey";

ALTER TABLE "Evidence"
    ADD CONSTRAINT "Evidence_fileRecordId_tenantId_fkey"
    FOREIGN KEY ("fileRecordId", "tenantId") REFERENCES "FileRecord"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("fileRecordId");

-- ── FileRecord.previousFileRecordId -> FileRecord (self-referential) ─

ALTER TABLE "FileRecord"
    DROP CONSTRAINT "FileRecord_previousFileRecordId_fkey";

ALTER TABLE "FileRecord"
    ADD CONSTRAINT "FileRecord_previousFileRecordId_tenantId_fkey"
    FOREIGN KEY ("previousFileRecordId", "tenantId") REFERENCES "FileRecord"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("previousFileRecordId");

-- ── RiskSuggestionItem.assetId -> Asset ────────────────────────────

ALTER TABLE "RiskSuggestionItem"
    DROP CONSTRAINT "RiskSuggestionItem_assetId_fkey";

ALTER TABLE "RiskSuggestionItem"
    ADD CONSTRAINT "RiskSuggestionItem_assetId_tenantId_fkey"
    FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("assetId");

-- ── Post-condition: the column list actually landed, on all eight ──
--
-- `confdeltype = 'n'` alone does NOT distinguish the fix from the bug —
-- plain SET NULL and column-scoped SET NULL are both 'n'. The difference is
-- `confdelsetcols`: NULL for a whole-row SET NULL, holding the scoped
-- columns' attnums otherwise. Asserting the exact scoped column here means
-- a silently-degraded ALTER cannot ship green. This is the property
-- #2411 established for two sites; it matters more at eight.

DO $$
DECLARE
    expected RECORD;
    scoped   TEXT;
    deltype  "char";
    ncols    INTEGER;
BEGIN
    FOR expected IN
        SELECT * FROM (VALUES
            ('AccessReview',       'AccessReview_evidenceFileRecordId_tenantId_fkey',       'evidenceFileRecordId'),
            ('AssetVulnerability', 'AssetVulnerability_remediationTaskId_tenantId_fkey',    'remediationTaskId'),
            ('ScannerFinding',     'ScannerFinding_assetId_tenantId_fkey',                  'assetId'),
            ('Evidence',           'Evidence_assetId_tenantId_fkey',                        'assetId'),
            ('Evidence',           'Evidence_taskId_tenantId_fkey',                         'taskId'),
            ('Evidence',           'Evidence_fileRecordId_tenantId_fkey',                   'fileRecordId'),
            ('FileRecord',         'FileRecord_previousFileRecordId_tenantId_fkey',         'previousFileRecordId'),
            ('RiskSuggestionItem', 'RiskSuggestionItem_assetId_tenantId_fkey',              'assetId')
        ) AS t(tbl, conname, col)
    LOOP
        SELECT c.confdeltype,
               array_length(c.confdelsetcols, 1),
               (SELECT a.attname FROM pg_attribute a
                 WHERE a.attrelid = c.conrelid
                   AND a.attnum = c.confdelsetcols[1])
          INTO deltype, ncols, scoped
          FROM pg_constraint c
         WHERE c.conrelid = format('%I', expected.tbl)::regclass
           AND c.contype = 'f'
           AND c.conname = expected.conname;

        IF deltype IS NULL THEN
            RAISE EXCEPTION '#2356 SET NULL carve-out: constraint % is missing', expected.conname;
        END IF;

        IF deltype <> 'n' OR ncols IS DISTINCT FROM 1 OR scoped IS DISTINCT FROM expected.col THEN
            RAISE EXCEPTION
                '#2356 SET NULL carve-out did not land column-scoped on %: expected confdeltype=n with exactly one scoped column %, got confdeltype=%, scoped column count=%, scoped column=%',
                expected.conname, expected.col, deltype, ncols, scoped;
        END IF;
    END LOOP;
END
$$;
