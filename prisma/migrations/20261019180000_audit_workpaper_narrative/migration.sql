-- ═══════════════════════════════════════════════════════════════════
-- #3749: the auditor agent's narrative of a workpaper.
--
--   AuditWorkpaperNarrative   one row per narrated workpaper: the run that
--                             drafted it, the exception codes it discusses,
--                             and the narrative (model text, at most 400
--                             characters, encrypted at rest by the
--                             application). WRITE-ONCE.
--
-- The table is a Regulatory artefact the tenant purge retains, as its
-- workpaper is, so its only foreign keys are to "Tenant" (kept as a tombstone)
-- and to "AuditWorkpaper" (also retained). The run is a plain id: runs are
-- purged on their own schedule.
--
-- ── ROLLING-DEPLOY SAFETY ───────────────────────────────────────────
--
--   A new table the previous image never reads. No column is added to an
--   existing table and no enum is altered.
--
-- FORWARD-ONLY.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1) The table ───────────────────────────────────────────────────

CREATE TABLE "AuditWorkpaperNarrative" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workpaperId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "exceptionCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditWorkpaperNarrative_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuditWorkpaperNarrative_tenantId_workpaperId_key" ON "AuditWorkpaperNarrative"("tenantId", "workpaperId");

ALTER TABLE "AuditWorkpaperNarrative" ADD CONSTRAINT "AuditWorkpaperNarrative_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditWorkpaperNarrative" ADD CONSTRAINT "AuditWorkpaperNarrative_workpaperId_tenantId_fkey" FOREIGN KEY ("workpaperId", "tenantId") REFERENCES "AuditWorkpaper"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 2) Shapes ──────────────────────────────────────────────────────
--
-- The codes are the workpaper's own vocabulary (`CODE` in
-- src/lib/agentic/audit-workpaper.ts), at most 20 of them; the run id and the
-- text are never empty. The text has no length CHECK: the column holds the
-- ciphertext, which is longer than the 400 characters the contract admits.
ALTER TABLE "AuditWorkpaperNarrative" ADD CONSTRAINT "AuditWorkpaperNarrative_shapes" CHECK (
        "exceptionCodes" IS NOT NULL
    AND cardinality("exceptionCodes") <= 20
    AND array_to_string("exceptionCodes", ',') ~ '^([A-Z][A-Z0-9_]{0,63}(,[A-Z][A-Z0-9_]{0,63})*)?$'
    AND char_length("runId") BETWEEN 1 AND 128
    AND char_length("text") >= 1
);

-- ─── 3) The insert guard — below the usecase ────────────────────────
--
-- `checkNarrativesAgainstRecord` (src/lib/agentic/audit-narrative.ts) refuses
-- first, with a named reason. This refuses the one part of that a database can
-- see for any writer that skips it: every exception code the narrative lists
-- is a code its workpaper's `exceptionsJson` records.
--
-- No `USING ERRCODE`: P0001 keeps the text, and the code leads it.

CREATE OR REPLACE FUNCTION audit_workpaper_narrative_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
    v_recorded TEXT[];
BEGIN
    SELECT COALESCE(array_agg(e->>'code'), ARRAY[]::TEXT[])
      INTO v_recorded
      FROM "AuditWorkpaper" w,
           jsonb_array_elements(w."exceptionsJson") e
     WHERE w."id" = NEW."workpaperId" AND w."tenantId" = NEW."tenantId";

    IF NOT (NEW."exceptionCodes" <@ v_recorded) THEN
        RAISE EXCEPTION
            'AUDIT_WORKPAPER_NARRATIVE_UNRECORDED_CODE: the narrative of workpaper % lists an exception code '
            'the workpaper does not record.',
            NEW."workpaperId";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_workpaper_narrative_insert_guard_trg ON "AuditWorkpaperNarrative";
CREATE TRIGGER audit_workpaper_narrative_insert_guard_trg
    BEFORE INSERT ON "AuditWorkpaperNarrative"
    FOR EACH ROW EXECUTE FUNCTION audit_workpaper_narrative_insert_guard();

-- ─── 4) Write-once ──────────────────────────────────────────────────
--
-- Refused for every role, `app_user` and the owner alike: a narrative that
-- could be revised is a narrative whose reviewer cannot know what they read.

CREATE OR REPLACE FUNCTION audit_workpaper_narrative_write_once()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'IMMUTABLE_AUDIT_WORKPAPER_NARRATIVE: narrative % of workpaper % is written once and never changed.',
        OLD."id", OLD."workpaperId";
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_workpaper_narrative_write_once_trg ON "AuditWorkpaperNarrative";
CREATE TRIGGER audit_workpaper_narrative_write_once_trg
    BEFORE UPDATE ON "AuditWorkpaperNarrative"
    FOR EACH ROW EXECUTE FUNCTION audit_workpaper_narrative_write_once();

-- ─── 5) Privileges + RLS ────────────────────────────────────────────
--
-- `app_user` reads and inserts; it never updates or deletes. Default
-- privileges grant both to `app_user` (20260323180000), so they are revoked
-- explicitly, as 20261018170000 does for "AuditWorkpaper".

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT ON "AuditWorkpaperNarrative" TO app_user;
        REVOKE UPDATE, DELETE ON "AuditWorkpaperNarrative" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "AuditWorkpaperNarrative" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditWorkpaperNarrative" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditWorkpaperNarrative";
CREATE POLICY tenant_isolation ON "AuditWorkpaperNarrative"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditWorkpaperNarrative";
CREATE POLICY tenant_isolation_insert ON "AuditWorkpaperNarrative"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AuditWorkpaperNarrative";
CREATE POLICY superuser_bypass ON "AuditWorkpaperNarrative"
    USING (current_setting('role') != 'app_user');
