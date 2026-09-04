-- Control task content plumbing (PR 1/8 of Actionable Control Tasks).
--
-- Purely additive: one new enum, eight nullable-or-defaulted columns on
-- ControlTemplateTask, one on ControlTemplate, two on Task, four indexes.
-- Nothing is dropped, nothing is backfilled, and every existing row remains
-- valid — a ControlTemplateTask written before today reads back as
-- phase=IMPLEMENT, sortOrder=0 and NULL everywhere else, which is exactly
-- what it was.
--
-- WHY sortOrder AND phase CARRY DEFAULTS while the rest are nullable: those
-- two are read on every install path (ordering, and grouping the plan), so a
-- NULL would force every reader to decide what absence means. The other six
-- are authored content, and absent genuinely means "not authored yet".

-- The control lifecycle a template task belongs to. Not a state machine —
-- TaskStatus owns progress; this is a reading order.
CREATE TYPE "TaskPhase" AS ENUM ('SCOPE', 'IMPLEMENT', 'OPERATE', 'REVIEW');

ALTER TABLE "ControlTemplateTask"
    ADD COLUMN "sortOrder"     INTEGER      NOT NULL DEFAULT 0,
    ADD COLUMN "phase"         "TaskPhase"  NOT NULL DEFAULT 'IMPLEMENT',
    ADD COLUMN "stepsJson"     JSONB,
    ADD COLUMN "evidenceHint"  TEXT,
    ADD COLUMN "suggestedRole" TEXT,
    ADD COLUMN "contentHash"   TEXT,
    ADD COLUMN "i18nJson"      JSONB,
    ADD COLUMN "deprecatedAt"  TIMESTAMP(3);

-- Reconcile reads (templateId, contentHash); install reads
-- (templateId, deprecatedAt) and orders by sortOrder.
CREATE INDEX "ControlTemplateTask_templateId_contentHash_idx"
    ON "ControlTemplateTask" ("templateId", "contentHash");
CREATE INDEX "ControlTemplateTask_templateId_deprecatedAt_idx"
    ON "ControlTemplateTask" ("templateId", "deprecatedAt");

-- The role a control is typically owned by. Five curated fixtures have
-- carried this key since they were written and the seeder dropped it every
-- time, because there was no column to put it in.
ALTER TABLE "ControlTemplate"
    ADD COLUMN "defaultOwnerHint" TEXT;

ALTER TABLE "Task"
    ADD COLUMN "templateTaskId" TEXT,
    ADD COLUMN "checklistJson"  JSONB;

-- tenantId-leading, like all ten of its neighbours on this table: Layer B of
-- the schema-index ratchet accepts a [tenantId, fk] composite, and a bare
-- [templateTaskId] would be the only non-tenant-leading index here.
CREATE INDEX "Task_tenantId_templateTaskId_idx"
    ON "Task" ("tenantId", "templateTaskId");
