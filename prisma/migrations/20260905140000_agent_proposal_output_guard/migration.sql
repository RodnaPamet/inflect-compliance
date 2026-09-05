-- Epic Agentic 6 — the AGENTIC OUTPUT GUARD verdict, persisted on the proposal.
--
-- The AI FEATURES have had `AiDecisionLog` since the EU AI Act Art 12 work:
-- an input DIGEST (never the prompt), a bounded output summary, and a guard
-- verdict. The agentic path — the one place where content authored by an
-- external agent becomes a live compliance record — had none of that. It
-- scanned its content and discarded the result.
--
-- Worse, the scan it ran could not refuse. `guardUntrustedInput` resolves
-- enforcement through `TenantSecuritySettings."aiGuardMode"`, whose DEFAULT is
-- BALANCED, where a *malicious* input verdict resolves to `flag` — and `flag`
-- does not throw. So a proposal whose own text tripped a high-severity
-- injection rule was written as an ordinary PENDING row and appeared in the
-- reviewer's queue indistinguishable from a clean one. The human was the only
-- control, and the human was told nothing.
--
-- This migration adds the four columns that make the verdict a fact about the
-- row, plus the terminal QUARANTINED status the review path refuses.
--
-- NO BACKFILL, and the defaults say why: every existing row entered a queue
-- that had no guard, so CLEAN here means "not refused", not "scanned and
-- found clean". Inventing a scan for historical rows would be inventing a
-- decision nobody made. `guardInputDigest` is NULL for exactly those rows,
-- which is how you tell the two apart.

-- ─── The terminal status ────────────────────────────────────────────
--
-- Additive on a SHARED enum (`RiskSuggestionItem` uses it too and never writes
-- this value). Adding a value is the safe half of the enum hazard: an
-- `ALTER TYPE … RENAME` mid-rolling-deploy makes still-running old containers
-- fail with SQLSTATE 42704, but an added value only affects readers that
-- encounter it — and only new code writes QUARANTINED.
--
-- The value is NOT used anywhere in this transaction; PostgreSQL forbids that,
-- not the ADD itself.
ALTER TYPE "SuggestionItemStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED';

-- ─── The verdict + provenance vocabularies ──────────────────────────
CREATE TYPE "AgentGuardVerdict" AS ENUM ('CLEAN', 'FLAGGED', 'QUARANTINED');

CREATE TYPE "AgentContentProvenance" AS ENUM (
    'TENANT_AUTHORED',
    'THIRD_PARTY_INGESTED',
    'SYSTEM'
);

-- ─── The columns ────────────────────────────────────────────────────
ALTER TABLE "AgentProposal"
    ADD COLUMN "guardVerdict"     "AgentGuardVerdict" NOT NULL DEFAULT 'CLEAN',
    ADD COLUMN "guardRuleIds"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "guardInputDigest" TEXT,
    -- Fail-closed default. An agent proposal is third-party content by
    -- construction; a row that somehow arrives without a label must not read
    -- as tenant-authored.
    ADD COLUMN "guardProvenance"  "AgentContentProvenance" NOT NULL DEFAULT 'THIRD_PARTY_INGESTED';

-- A quarantined row is only ever read by the triage surface, so the index is
-- the verdict, not the status. Tenant-leading like every other index on this
-- table — RLS still filters, but the planner should not have to.
CREATE INDEX "AgentProposal_tenantId_guardVerdict_createdAt_idx"
    ON "AgentProposal" ("tenantId", "guardVerdict", "createdAt");

-- No RLS work: `AgentProposal` already carries the canonical policy triple
-- (`tenant_isolation`, `tenant_isolation_insert`, `superuser_bypass`) under
-- FORCE ROW LEVEL SECURITY from the migration that created it. Adding columns
-- to an RLS-protected table inherits its policies; there is nothing to declare.
