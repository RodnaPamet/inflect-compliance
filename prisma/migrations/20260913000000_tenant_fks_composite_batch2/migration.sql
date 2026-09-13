-- ═══════════════════════════════════════════════════════════════════
-- #2356 batch 2: TEN sites whose target already carries
-- @@unique([id, tenantId]) AND whose target's `tenantId` is NOT NULL.
--
-- Re-measured on this commit rather than taken from the issue body, which
-- records 121 -> 120 -> 85 across earlier commits as the sweep landed:
--
--     single-column FKs between tenant-scoped models: 67
--       target already composite-capable:             14
--       of those, SAFE to convert:                    10   <- this migration
--       of those, BLOCKED by a NULLABLE parent tenant:  4   <- see below
--       target still needs the unique first:          53
--
-- ─── FOUR SITES ARE EXCLUDED, AND THE REASON IS A HOLE IN THE SWEEP ─
--
-- #2356's method — and the re-measurement in its comments — defines a
-- "tenant-scoped model" as one declaring a `tenantId` field. `Control`
-- declares `tenantId String?`. It is the single member of
-- `NULLABLE_TENANT_MODELS` in src/app-layer/jobs/data-lifecycle.ts, and a
-- Control with `tenantId IS NULL` is a GLOBAL library control:
-- ControlRepository reads `OR: [{ tenantId: ctx.tenantId }, { tenantId: null }]`
-- in four places.
--
-- A composite FK carrying `tenantId` would make a tenant-scoped child
-- UNABLE to reference a global control, because the child's NOT NULL
-- tenantId can never equal the parent's NULL. That is not hardening, it is
-- removing the shared control library from Findings, Tasks and integration
-- executions. So these four are NOT mechanical and are left alone:
--
--     Finding.controlId              -> Control
--     Finding.compensatingControlId  -> Control
--     IntegrationExecution.controlId -> Control
--     Task.controlId                 -> Control
--
-- They need a different design (a tenant-or-global CHECK, or promoting
-- library controls to per-tenant copies) and belong on their own issue.
-- The other ten parents — AiSystem, Audit, Evidence, Finding, Risk — all
-- have NOT NULL `tenantId`, verified against information_schema on a fresh
-- database built from these migrations.
--
-- ─── Why every one of the ten is column-scoped SET NULL ─────────────
--
-- ALL TEN ARE OPTIONAL, and Prisma's default referential action on an
-- optional relation IS SetNull — so the ones carrying no explicit
-- `onDelete:` are SET NULL in the database exactly like the ones that name
-- it. Reading "(default)" as "no action to preserve" would have silently
-- converted live behaviours to RESTRICT.
--
-- A composite FK carrying `tenantId` cannot use plain SET NULL: Postgres
-- nulls EVERY referencing column, `tenantId` is NOT NULL, and the parent
-- delete aborts with SQLSTATE 23502 against a column the DELETE never
-- mentioned. The column-scoped form from 20260911120000 and
-- 20260911160000 nulls only the FK column.
--
-- RESTRICT was considered and rejected on the same evidence those two
-- migrations used: Audit, Evidence, Finding and Risk are in
-- SOFT_DELETE_MODELS, so `purgeSoftDeleted` hard-deletes them with raw SQL
-- in a per-row loop with no try/catch after the grace period, and AiSystem
-- is not soft-deleted at all. RESTRICT would not preserve behaviour, it
-- would move the failure into that sweep, where one un-purgeable parent
-- stops every soft-delete model after it (#2411's blast radius).
--
-- Rollback: restore the single-column FKs. That re-opens the cross-tenant
-- hole this closes, so it is a deliberate act, not a convenience.
-- ═══════════════════════════════════════════════════════════════════

-- ── Precondition: the column-scoped syntax needs PG15+ ─────────────

DO $$
BEGIN
    IF current_setting('server_version_num')::int < 150000 THEN
        RAISE EXCEPTION
            '#2356 batch 2 needs Postgres 15+ for "ON DELETE SET NULL (column)"; this server is %',
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
-- generic "violates foreign key constraint" on the ALTER into a named
-- error naming table, column and count.

DO $$
DECLARE
    site      RECORD;
    offenders BIGINT;
    total     BIGINT := 0;
    report    TEXT := '';
BEGIN
    FOR site IN
        SELECT * FROM (VALUES
            ('AiDecisionLog', 'aiSystemId', 'AiSystem'),
            ('ControlTestEvidenceLink', 'evidenceId', 'Evidence'),
            ('Evidence', 'riskId', 'Risk'),
            ('Finding', 'auditId', 'Audit'),
            ('KeyRiskIndicator', 'riskId', 'Risk'),
            ('LossEvent', 'riskId', 'Risk'),
            ('PolicyEvidenceItem', 'evidenceId', 'Evidence'),
            ('RiskAppetiteBreach', 'riskId', 'Risk'),
            ('Task', 'findingId', 'Finding'),
            ('VendorAssessmentAnswer', 'evidenceId', 'Evidence')
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
            E'#2356 batch 2: % existing row(s) reference a parent in ANOTHER tenant and would be refused by the composite FK.%\n\nThese are the cross-tenant references #2356 exists to make unrepresentable. They must be resolved (re-pointed or nulled) before this migration can apply.',
            total, report;
    END IF;
END
$$;

-- ── AiDecisionLog.aiSystemId -> AiSystem ──

ALTER TABLE "AiDecisionLog"
    DROP CONSTRAINT "AiDecisionLog_aiSystemId_fkey";

ALTER TABLE "AiDecisionLog"
    ADD CONSTRAINT "AiDecisionLog_aiSystemId_tenantId_fkey"
    FOREIGN KEY ("aiSystemId", "tenantId") REFERENCES "AiSystem"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("aiSystemId");

-- ── ControlTestEvidenceLink.evidenceId -> Evidence ──

ALTER TABLE "ControlTestEvidenceLink"
    DROP CONSTRAINT "ControlTestEvidenceLink_evidenceId_fkey";

ALTER TABLE "ControlTestEvidenceLink"
    ADD CONSTRAINT "ControlTestEvidenceLink_evidenceId_tenantId_fkey"
    FOREIGN KEY ("evidenceId", "tenantId") REFERENCES "Evidence"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("evidenceId");

-- ── Evidence.riskId -> Risk ──

ALTER TABLE "Evidence"
    DROP CONSTRAINT "Evidence_riskId_fkey";

ALTER TABLE "Evidence"
    ADD CONSTRAINT "Evidence_riskId_tenantId_fkey"
    FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("riskId");

-- ── Finding.auditId -> Audit ──

ALTER TABLE "Finding"
    DROP CONSTRAINT "Finding_auditId_fkey";

ALTER TABLE "Finding"
    ADD CONSTRAINT "Finding_auditId_tenantId_fkey"
    FOREIGN KEY ("auditId", "tenantId") REFERENCES "Audit"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("auditId");

-- ── KeyRiskIndicator.riskId -> Risk ──

ALTER TABLE "KeyRiskIndicator"
    DROP CONSTRAINT "KeyRiskIndicator_riskId_fkey";

ALTER TABLE "KeyRiskIndicator"
    ADD CONSTRAINT "KeyRiskIndicator_riskId_tenantId_fkey"
    FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("riskId");

-- ── LossEvent.riskId -> Risk ──

ALTER TABLE "LossEvent"
    DROP CONSTRAINT "LossEvent_riskId_fkey";

ALTER TABLE "LossEvent"
    ADD CONSTRAINT "LossEvent_riskId_tenantId_fkey"
    FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("riskId");

-- ── PolicyEvidenceItem.evidenceId -> Evidence ──

ALTER TABLE "PolicyEvidenceItem"
    DROP CONSTRAINT "PolicyEvidenceItem_evidenceId_fkey";

ALTER TABLE "PolicyEvidenceItem"
    ADD CONSTRAINT "PolicyEvidenceItem_evidenceId_tenantId_fkey"
    FOREIGN KEY ("evidenceId", "tenantId") REFERENCES "Evidence"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("evidenceId");

-- ── RiskAppetiteBreach.riskId -> Risk ──

ALTER TABLE "RiskAppetiteBreach"
    DROP CONSTRAINT "RiskAppetiteBreach_riskId_fkey";

ALTER TABLE "RiskAppetiteBreach"
    ADD CONSTRAINT "RiskAppetiteBreach_riskId_tenantId_fkey"
    FOREIGN KEY ("riskId", "tenantId") REFERENCES "Risk"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("riskId");

-- ── Task.findingId -> Finding ──

ALTER TABLE "Task"
    DROP CONSTRAINT "Task_findingId_fkey";

ALTER TABLE "Task"
    ADD CONSTRAINT "Task_findingId_tenantId_fkey"
    FOREIGN KEY ("findingId", "tenantId") REFERENCES "Finding"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("findingId");

-- ── VendorAssessmentAnswer.evidenceId -> Evidence ──

ALTER TABLE "VendorAssessmentAnswer"
    DROP CONSTRAINT "VendorAssessmentAnswer_evidenceId_fkey";

ALTER TABLE "VendorAssessmentAnswer"
    ADD CONSTRAINT "VendorAssessmentAnswer_evidenceId_tenantId_fkey"
    FOREIGN KEY ("evidenceId", "tenantId") REFERENCES "Evidence"("id", "tenantId")
    ON UPDATE CASCADE ON DELETE SET NULL ("evidenceId");

-- ── Post-condition: the SET NULL must be COLUMN-SCOPED ─────────────
--
-- Plain and column-scoped SET NULL are BOTH `confdeltype = 'n'`; only
-- `confdelsetcols` separates them. Asserting the column list here means a
-- silently-degraded ALTER cannot ship green — the same post-condition
-- 20260911120000 and 20260911160000 carry.

DO $$
DECLARE
    bad TEXT;
BEGIN
    SELECT string_agg(conname, ', ')
      INTO bad
      FROM pg_constraint
     WHERE contype = 'f'
       AND conname IN (
               'AiDecisionLog_aiSystemId_tenantId_fkey',
               'ControlTestEvidenceLink_evidenceId_tenantId_fkey',
               'Evidence_riskId_tenantId_fkey',
               'Finding_auditId_tenantId_fkey',
               'KeyRiskIndicator_riskId_tenantId_fkey',
               'LossEvent_riskId_tenantId_fkey',
               'PolicyEvidenceItem_evidenceId_tenantId_fkey',
               'RiskAppetiteBreach_riskId_tenantId_fkey',
               'Task_findingId_tenantId_fkey',
               'VendorAssessmentAnswer_evidenceId_tenantId_fkey'
           )
       AND (confdeltype <> 'n' OR confdelsetcols IS NULL OR cardinality(confdelsetcols) <> 1);

    IF bad IS NOT NULL THEN
        RAISE EXCEPTION
            '#2356 batch 2: these constraints are not column-scoped SET NULL: %', bad;
    END IF;
END
$$;
