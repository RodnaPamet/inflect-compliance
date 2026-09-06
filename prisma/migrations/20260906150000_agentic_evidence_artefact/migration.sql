-- The AGENTIC EVIDENCE LEDGER — receipts and decision records become artefacts.
--
-- ROLLING-DEPLOY SAFETY. One table, created EMPTY, with no `ALTER TYPE` and no
-- new Postgres enum: `kind`, `status` and `withdrawnReason` are TEXT with CHECK
-- constraints, for the reason the `@@map("WorkItem*")` pins record — an enum
-- rename or value add mid-deploy makes still-running old containers fail with
-- SQLSTATE 42704, and both vocabularies here are ones a follow-up will widen.
-- No already-running container reads or writes this table.

CREATE TABLE "AgenticEvidenceArtefact" (
    "id"              TEXT NOT NULL,
    "tenantId"        TEXT NOT NULL,
    "controlId"       TEXT NOT NULL,
    "kind"            TEXT NOT NULL,
    "periodStart"     TIMESTAMP(3) NOT NULL,
    "periodEnd"       TIMESTAMP(3) NOT NULL,
    "evidenceId"      TEXT NOT NULL,
    "sourceDigest"    TEXT NOT NULL,
    "recordCount"     INTEGER NOT NULL DEFAULT 0,
    "status"          TEXT NOT NULL DEFAULT 'CURRENT',
    "withdrawnAt"     TIMESTAMP(3),
    "withdrawnReason" TEXT,
    "lastEmittedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgenticEvidenceArtefact_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_kind_known"
    CHECK ("kind" IN ('AGENT_ACTION_RECEIPTS', 'AI_DECISION_RECORDS'));

ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_status_known"
    CHECK ("status" IN ('CURRENT', 'WITHDRAWN'));

-- A withdrawn artefact must say WHEN and WHY, and a current one must claim
-- neither. The pairing is here rather than only at the usecase because the whole
-- value of not deleting the row is that it goes on explaining itself: a
-- withdrawn artefact with no reason is indistinguishable from an emitter that
-- stopped running, which is the ambiguity this table exists to remove.
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_withdrawal_accountability"
    CHECK (
        ("status" = 'CURRENT'  AND "withdrawnAt" IS NULL AND "withdrawnReason" IS NULL)
        OR
        ("status" = 'WITHDRAWN' AND "withdrawnAt" IS NOT NULL AND "withdrawnReason" IS NOT NULL)
    );

ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_withdrawn_reason_known"
    CHECK ("withdrawnReason" IS NULL
           OR "withdrawnReason" IN ('CONTROL_REMOVED', 'SOURCE_UNVERIFIABLE'));

-- A count is a count.
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_record_count_nonnegative"
    CHECK ("recordCount" >= 0);

-- The period is half-open and non-empty. An inverted or empty window would make
-- two artefacts' populations overlap or vanish with nothing failing.
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_period_ordered"
    CHECK ("periodEnd" > "periodStart");

-- ═══════════════════════════════════════════════════════════════════
-- THE IDENTITY
-- ═══════════════════════════════════════════════════════════════════
-- `(tenant, control, kind, period)`. A unique index rather than a read-then-write
-- in the usecase, because two overlapping ticks — a retry racing a schedule —
-- would both read "absent" and both insert, which is precisely the duplication
-- the identity exists to prevent. Tenant-leading, so it also serves the
-- tenant-scoped lookup and `controlId`'s foreign-key index.
CREATE UNIQUE INDEX "AgenticEvidenceArtefact_tenantId_controlId_kind_periodStart_key"
    ON "AgenticEvidenceArtefact"("tenantId", "controlId", "kind", "periodStart");

CREATE INDEX "AgenticEvidenceArtefact_tenantId_periodStart_idx"
    ON "AgenticEvidenceArtefact"("tenantId", "periodStart");

CREATE INDEX "AgenticEvidenceArtefact_tenantId_evidenceId_idx"
    ON "AgenticEvidenceArtefact"("tenantId", "evidenceId");

ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CASCADE from the control, matching `EvidenceControlLink`. Note this is a HARD
-- delete of the control row; UNINSTALLING a control in this product is a soft
-- delete (`Control.deletedAt`), which does NOT cascade — that case is handled by
-- withdrawing the artefact, which keeps the evidence and records why it stopped.
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_controlId_fkey"
    FOREIGN KEY ("controlId") REFERENCES "Control"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FK to `Evidence(id, tenantId)` so RLS chains through the parent, the
-- shape `EvidenceControlLink` and `EvidenceReview` already use. It also makes a
-- cross-tenant artefact unrepresentable rather than merely refused.
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_evidenceId_tenantId_fkey"
    FOREIGN KEY ("evidenceId", "tenantId") REFERENCES "Evidence"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-Level Security (Epic A.1)
-- ═══════════════════════════════════════════════════════════════════
-- `tenantId` is NOT NULL, so the split USING / WITH CHECK form is correct and the
-- single-policy exception `UserSession` needs does not apply.
GRANT SELECT, INSERT, UPDATE, DELETE ON "AgenticEvidenceArtefact" TO app_user;

ALTER TABLE "AgenticEvidenceArtefact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgenticEvidenceArtefact" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AgenticEvidenceArtefact";
CREATE POLICY tenant_isolation ON "AgenticEvidenceArtefact"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgenticEvidenceArtefact";
CREATE POLICY tenant_isolation_insert ON "AgenticEvidenceArtefact"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgenticEvidenceArtefact";
CREATE POLICY superuser_bypass ON "AgenticEvidenceArtefact"
    USING (current_setting('role') != 'app_user');
