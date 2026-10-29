-- A HARNESS ACCEPTANCE IS ONE-WAY AT THE DATABASE (#4435).
--
-- `AgentHarnessAcceptance` records a PERSON's decision — who accepted an
-- agent's HARNESS_SHORTFALL, on what justification, until when — about a
-- shortfall DERIVED FROM machine-written rows (the scanner's ingested scan
-- items). `docs/new-subsystem-checklist.md` §2 requires that shape to be
-- one-way at the database, with `AgentServicePrincipalConfirmation` as the
-- worked example, and this table shipped in `20261017210000` — one day BEFORE
-- that example established the pattern, so it never got it.
--
-- App-level rules already hold (owner-only acceptance, a 365-day cap, a
-- justification floor, one write seam). The database layer is asked for
-- because those can be bypassed by a future seam change, a migration, or a
-- direct connection — and for a risk acceptance in a compliance product,
-- append-only is what makes the row evidence rather than a mutable field.
--
-- OWNER DECISION, 2026-10-29: invalidate only, NEVER extend. A longer
-- acceptance is a NEW row with its own approver, justification and expiry —
-- which is already how the model expresses it, via `renewedFromId`. So
-- `expiresAt` is frozen here deliberately: that single line is the decision.

CREATE OR REPLACE FUNCTION agent_harness_acceptance_one_way()
RETURNS TRIGGER AS $$
BEGIN
    -- The decision itself never changes. `expiresAt` is in this list BY
    -- DESIGN: extending an acceptance in place would make one row stand for
    -- several decisions and lose which approver granted which extension.
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
       OR NEW."discoveredAgentId" IS DISTINCT FROM OLD."discoveredAgentId"
       OR NEW."acceptedLevel" IS DISTINCT FROM OLD."acceptedLevel"
       OR NEW."justification" IS DISTINCT FROM OLD."justification"
       OR NEW."acceptedByUserId" IS DISTINCT FROM OLD."acceptedByUserId"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
       OR NEW."renewedFromId" IS DISTINCT FROM OLD."renewedFromId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION
            'AGENT_HARNESS_ACCEPTANCE_ONE_WAY: an acceptance is never rewritten or extended; revoke it and accept again, which records the new approver.';
    END IF;

    -- Revocation is one-way too, or a revoked acceptance could be quietly
    -- reinstated and the shortfall suppressed again under the original
    -- approver's name.
    IF OLD."revokedAt" IS NOT NULL
       AND (NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
            OR NEW."revokedByUserId" IS DISTINCT FROM OLD."revokedByUserId") THEN
        RAISE EXCEPTION
            'AGENT_HARNESS_ACCEPTANCE_ONE_WAY: a revoked acceptance stays revoked.';
    END IF;

    -- A revocation names its actor. Without this, `revokedAt` could be set
    -- with no `revokedByUserId` and the audit trail would record that an
    -- acceptance was revoked by nobody.
    IF NEW."revokedAt" IS NOT NULL AND NEW."revokedByUserId" IS NULL THEN
        RAISE EXCEPTION
            'AGENT_HARNESS_ACCEPTANCE_ONE_WAY: a revocation records who made it.';
    END IF;

    -- `revokedAt`, `revokedByUserId`, `expiryProcessedAt` and `updatedAt` are
    -- deliberately NOT frozen: the first two are the invalidation this trigger
    -- exists to permit, `expiryProcessedAt` is the expiry job's own bookkeeping
    -- (a machine write about a person's row, not a change to the decision), and
    -- Prisma sets `updatedAt` on every update.
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_harness_acceptance_one_way ON "AgentHarnessAcceptance";
CREATE TRIGGER agent_harness_acceptance_one_way
    BEFORE UPDATE ON "AgentHarnessAcceptance"
    FOR EACH ROW
    EXECUTE FUNCTION agent_harness_acceptance_one_way();

-- `20261017210000` granted DELETE along with the rest. An acceptance that can
-- be deleted is not evidence: the record of who suppressed a shortfall, and
-- why, would be removable by the same path that created it.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        REVOKE DELETE ON "AgentHarnessAcceptance" FROM app_user;
    END IF;
END
$$;
