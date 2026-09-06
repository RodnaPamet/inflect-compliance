-- OWASP ASI09 (human-agent trust exploitation) — the two things that make the
-- propose-not-commit queue's approval MEAN something.
--
--   1. AN EXPIRY WINDOW on a proposal. Queue depth is itself a driver of
--      rubber-stamping, so an unbounded queue is part of the threat model
--      rather than a housekeeping matter. A proposal past its window cannot be
--      approved, and the nightly sweep moves it to the terminal EXPIRED status.
--
--   2. A SAMPLE AUDIT of already-approved proposals. Every other signal this
--      subsystem emits measures the SHAPE of the review behaviour; this one
--      measures whether the approvals were RIGHT, which is the only way to
--      know whether the human gate is doing anything at all.
--
-- ─── Rolling-deploy safety ──────────────────────────────────────────
--
-- `ALTER TYPE ... ADD VALUE` is the additive half of the enum hazard, and the
-- safe half: a RENAME makes still-running old containers fail with SQLSTATE
-- 42704, whereas an added value only affects readers that encounter it — and
-- only new code writes EXPIRED. The value is deliberately NOT used anywhere in
-- this transaction; PostgreSQL forbids that, not the ADD itself. (Same shape as
-- 20260905140000_agent_proposal_output_guard, which added QUARANTINED.)
--
-- `expiresAt` is added NULLABLE with no default and IS NOT BACKFILLED. Both
-- halves are deliberate:
--
--   * NOT NULL with a default on a populated table would invent a deadline for
--     every existing proposal, and the deadline would be wrong — the window's
--     length comes from the approval rung of the policy-card version in force
--     when the proposal was made, which SQL here cannot resolve.
--   * A NULL therefore means NO DEADLINE RECORDED, never "expired". The
--     application reads it that way (`isProposalExpired` returns false for
--     NULL), so pre-existing proposals stay approvable until the sweep stamps a
--     real deadline onto them. Reading the absence as "window closed" would
--     retire every in-flight proposal at the moment of deploy.

-- ─── The terminal status ────────────────────────────────────────────
ALTER TYPE "SuggestionItemStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

-- ─── The sample-audit verdict vocabulary ────────────────────────────
-- PENDING is first and is the column default: a sample nobody has re-reviewed
-- must not read as agreement, or the disagreement rate would improve every time
-- the sampler ran and nobody did the work.
CREATE TYPE "AgentSampleAuditOutcome" AS ENUM (
    'PENDING',
    'CONCURRED',
    'DISSENTED',
    'INDETERMINATE'
);

-- ─── The review window on a proposal ────────────────────────────────
ALTER TABLE "AgentProposal" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- The expiry sweep's query, and the one index on this table that is
-- deliberately NOT tenant-leading: the sweep runs system-wide over every tenant
-- at once (`status = 'PENDING' AND "expiresAt" <= now()`), so a tenantId-leading
-- composite would be a prefix it never supplies. The existing
-- ("tenantId", "status", "createdAt") index is untouched and still serves every
-- per-tenant read.
CREATE INDEX "AgentProposal_status_expiresAt_idx" ON "AgentProposal"("status", "expiresAt");

-- Composite parent key so a sample-audit row can never point at another
-- tenant's proposal — the same shape "AgentPolicyCard" carries for its versions.
CREATE UNIQUE INDEX "AgentProposal_id_tenantId_key" ON "AgentProposal"("id", "tenantId");

-- ═══════════════════════════════════════════════════════════════════
-- The sample-audit table
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "AgentProposalSampleAudit" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT NOT NULL,
    "proposalId"       TEXT NOT NULL,
    "sampledAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "samplingEpoch"    TEXT NOT NULL,
    "assignedToUserId" TEXT,
    "outcome"          "AgentSampleAuditOutcome" NOT NULL DEFAULT 'PENDING',
    "dissentCodes"     TEXT[],
    "reviewedByUserId" TEXT,
    "reviewedAt"       TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentProposalSampleAudit_pkey" PRIMARY KEY ("id")
);

-- ─── Value constraints ──────────────────────────────────────────────
-- Dissent codes belong to a DISSENTED verdict and nothing else. Without this a
-- CONCURRED row could carry reasons for disagreeing, and a reader aggregating
-- "which kind of wrong" would count agreements as complaints. The usecase
-- enforces the same rule; this is the backstop for the paths it does not own.
ALTER TABLE "AgentProposalSampleAudit"
    ADD CONSTRAINT "AgentProposalSampleAudit_dissent_codes_only_when_dissented"
    CHECK (
        ("outcome" = 'DISSENTED' AND array_length("dissentCodes", 1) IS NOT NULL)
        OR ("outcome" <> 'DISSENTED' AND array_length("dissentCodes", 1) IS NULL)
    );

-- A decided row names its reviewer and when; a PENDING row names neither. The
-- two columns move together for the same reason `riskTier` / `riskTierScoredAt`
-- do on "RegisteredAgent": a verdict that can be read without knowing who gave
-- it is not evidence.
ALTER TABLE "AgentProposalSampleAudit"
    ADD CONSTRAINT "AgentProposalSampleAudit_review_stamp_together"
    CHECK (
        ("outcome" = 'PENDING' AND "reviewedByUserId" IS NULL AND "reviewedAt" IS NULL)
        OR ("outcome" <> 'PENDING' AND "reviewedByUserId" IS NOT NULL AND "reviewedAt" IS NOT NULL)
    );

-- ─── Indexes ────────────────────────────────────────────────────────
-- One audit per proposal, ever. This is the sweep's DURABLE IDEMPOTENCY KEY —
-- `schedules.ts` requires one of any job whose double-fire would be visible,
-- and BullMQ's jobId dedupe holds only within the retention window. It doubles
-- as the tenant-leading uniqueness construct that indexes the "proposalId" FK
-- as its second column, so there is deliberately no separate
-- ("tenantId", "proposalId") index: it would be the same b-tree twice.
CREATE UNIQUE INDEX "AgentProposalSampleAudit_tenantId_proposalId_key"
    ON "AgentProposalSampleAudit"("tenantId", "proposalId");

-- The reviewer's queue: open audits for this tenant, oldest first.
CREATE INDEX "AgentProposalSampleAudit_tenantId_outcome_sampledAt_idx"
    ON "AgentProposalSampleAudit"("tenantId", "outcome", "sampledAt");

-- ─── Foreign keys ───────────────────────────────────────────────────
ALTER TABLE "AgentProposalSampleAudit"
    ADD CONSTRAINT "AgentProposalSampleAudit_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FK to the proposal's (id, tenantId) parent key: an audit can never
-- name another tenant's proposal, and Postgres enforces it even though it runs
-- FK checks as the table owner and therefore bypasses row security.
--
-- CASCADE, not RESTRICT: the audit is a statement ABOUT a proposal, so it
-- cannot outlive its subject. A proposal row is only ever deleted by cascade
-- from its tenant anyway — expiry does not delete anything.
ALTER TABLE "AgentProposalSampleAudit"
    ADD CONSTRAINT "AgentProposalSampleAudit_proposalId_tenantId_fkey"
    FOREIGN KEY ("proposalId", "tenantId") REFERENCES "AgentProposal"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-Level Security (Epic A.1)
-- ═══════════════════════════════════════════════════════════════════
-- "tenantId" is NOT NULL, so the split USING / WITH CHECK form is correct and
-- the single-policy exception "UserSession" needs does not apply.
--
-- No RLS work on "AgentProposal": it already carries the canonical policy
-- triple under FORCE ROW LEVEL SECURITY from the migration that created it, and
-- adding a column to an RLS-protected table inherits its policies.

-- 1) app_user grants
GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentProposalSampleAudit" TO app_user;

-- 2) Enable + FORCE RLS
ALTER TABLE "AgentProposalSampleAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentProposalSampleAudit" FORCE ROW LEVEL SECURITY;

-- 3) tenant_isolation (USING) + tenant_isolation_insert (WITH CHECK)
DROP POLICY IF EXISTS tenant_isolation ON "AgentProposalSampleAudit";
CREATE POLICY tenant_isolation ON "AgentProposalSampleAudit"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentProposalSampleAudit";
CREATE POLICY tenant_isolation_insert ON "AgentProposalSampleAudit"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- 4) superuser_bypass — non-app_user roles (postgres) keep full access
DROP POLICY IF EXISTS superuser_bypass ON "AgentProposalSampleAudit";
CREATE POLICY superuser_bypass ON "AgentProposalSampleAudit"
    USING (current_setting('role') != 'app_user');
