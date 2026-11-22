-- Phase 1 of docs/ai-architecture/mastercard-agent-pay.md: SPENDING AUTHORITY
-- ON THE REGISTER (owner decisions D-L1-8 and D-L1-9, 2026-11-11).
--
--   AgentSpendingAuthority  one agent's declared spending envelope on one rail:
--                           limits, budget, merchant scope, expiry, consenter,
--                           token requestor and its reference for the token.
--
-- The envelope is a DECLARATION to review, never a grant Inflect enforces at
-- payment time. The usecase (`src/app-layer/usecases/agent-spending-authority.ts`)
-- refuses first; this migration holds what a database can hold below it:
--
--   * no identifier column can carry a card number: both are pinned to short
--     shapes with no run of 13 or more digits (CHECK; D-L1-8);
--   * the reviewer is never the declarer nor the agent's owner at declaration
--     (CHECK; four eyes);
--   * a REVIEWED envelope changes only by narrowing; anything wider must move
--     the row back to DECLARED with fresh declaration stamps (trigger);
--   * a row is born DECLARED, and never for a RETIRED agent (trigger);
--   * no merchant domain can carry a card number either (CHECK; D-L1-8);
--   * an agent with an UNREVIEWED envelope (DECLARED, or SUSPENDED_REQUESTED
--     with no review stamp) never moves to ACTIVE (trigger on
--     RegisteredAgent; the usecase refuses SPENDING_AUTHORITY_UNREVIEWED
--     first).
--
-- ROLLING-DEPLOY SAFETY. Forward-only and additive: three NEW enum types, one
-- NEW table, and one NEW trigger on "RegisteredAgent" that refuses only a move
-- to ACTIVE while a row of the new table is unreviewed. The previous image never
-- writes the new table, so for it the trigger can never fire. A new enum type is
-- a single deploy; only a value added to an existing enum needs two.
--
-- Triggers raise at the default SQLSTATE (P0001), so Prisma passes the message
-- (which names the rule) through.

-- CreateEnum
CREATE TYPE "AgentSpendingRail" AS ENUM ('AGENT_PAY_TOKEN', 'AP4M', 'OTHER');

-- CreateEnum
CREATE TYPE "AgentSpendingAuthorityStatus" AS ENUM ('DECLARED', 'REVIEWED', 'SUSPENDED_REQUESTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AgentSpendingBudgetPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH');

-- CreateTable
CREATE TABLE "AgentSpendingAuthority" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "rail" "AgentSpendingRail" NOT NULL,
    "perTransactionLimitMinor" BIGINT NOT NULL,
    "periodBudgetMinor" BIGINT NOT NULL,
    "budgetPeriod" "AgentSpendingBudgetPeriod" NOT NULL,
    "currency" TEXT NOT NULL,
    "merchantDomains" TEXT[],
    "merchantCategoryCodes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consentedByUserId" TEXT NOT NULL,
    "tokenRequestor" TEXT NOT NULL,
    "tokenReference" TEXT NOT NULL,
    "status" "AgentSpendingAuthorityStatus" NOT NULL DEFAULT 'DECLARED',
    "declaredByUserId" TEXT NOT NULL,
    "declaredAt" TIMESTAMP(3) NOT NULL,
    "ownerUserIdAtDeclaration" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "suspensionRequestedAt" TIMESTAMP(3),
    "suspensionKillSwitchId" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSpendingAuthority_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentSpendingAuthority_tenantId_status_idx" ON "AgentSpendingAuthority"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSpendingAuthority_id_tenantId_key" ON "AgentSpendingAuthority"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSpendingAuthority_tenantId_agentId_rail_key" ON "AgentSpendingAuthority"("tenantId", "agentId", "rail");

-- AddForeignKey
ALTER TABLE "AgentSpendingAuthority" ADD CONSTRAINT "AgentSpendingAuthority_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: composite, so an envelope can never describe another tenant's agent.
ALTER TABLE "AgentSpendingAuthority" ADD CONSTRAINT "AgentSpendingAuthority_agentId_tenantId_fkey" FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── CHECKs ─────────────────────────────────────────────────────────

-- Positive amounts, and one transaction never larger than the period's budget.
ALTER TABLE "AgentSpendingAuthority" ADD CONSTRAINT "AgentSpendingAuthority_amounts_bounded"
    CHECK (
        "perTransactionLimitMinor" > 0
        AND "periodBudgetMinor" > 0
        AND "perTransactionLimitMinor" <= "periodBudgetMinor"
    );

ALTER TABLE "AgentSpendingAuthority" ADD CONSTRAINT "AgentSpendingAuthority_currency_iso4217"
    CHECK ("currency" ~ '^[A-Z]{3}$');

-- Prisma emits a list column as a nullable TEXT[]; a NULL list is no answer.
ALTER TABLE "AgentSpendingAuthority" ADD CONSTRAINT "AgentSpendingAuthority_merchant_scope_shape"
    CHECK (
        "merchantDomains" IS NOT NULL
        AND "merchantCategoryCodes" IS NOT NULL
        AND cardinality("merchantDomains") <= 100
        AND cardinality("merchantCategoryCodes") <= 100
        AND array_to_string("merchantCategoryCodes", ',') ~ '^([0-9]{4}(,[0-9]{4})*)?$'
    );

-- D-L1-8, held below the usecase: neither identifier can carry a card number.
-- The usecase refuses the same shapes first, and the shared harness-contract
-- secret check (`looksLikeSecret`) on top.
ALTER TABLE "AgentSpendingAuthority" ADD CONSTRAINT "AgentSpendingAuthority_identifiers_carry_no_card_number"
    CHECK (
        "tokenReference" ~ '^[A-Za-z0-9._:-]{1,128}$'
        AND char_length(btrim("tokenRequestor")) BETWEEN 1 AND 80
        AND regexp_replace("tokenReference", '[^0-9A-Za-z]+', '', 'g') !~ '[0-9]{13,}'
        AND regexp_replace("tokenRequestor", '[^0-9A-Za-z]+', '', 'g') !~ '[0-9]{13,}'
    );

-- The merchant domains are free text too (a host label may be all digits), so
-- they are held to the same rule. Joined with a LETTER, which the
-- regexp_replace keeps, so digits at the end of one domain and the start of the
-- next never read as one run. Postgres allows no subquery in a CHECK, so the
-- array is checked as one string rather than per element.
ALTER TABLE "AgentSpendingAuthority" ADD CONSTRAINT "AgentSpendingAuthority_merchant_domains_carry_no_card_number"
    CHECK (
        regexp_replace(array_to_string("merchantDomains", 'x'), '[^0-9A-Za-z]+', '', 'g') !~ '[0-9]{13,}'
    );

-- FOUR EYES (D-L1-9). The reviewer is never the person who declared the
-- envelope now on the row, and never the agent's owner at that moment. The
-- usecase refuses both first, and the agent's CURRENT owner too.
ALTER TABLE "AgentSpendingAuthority" ADD CONSTRAINT "AgentSpendingAuthority_not_self_reviewed"
    CHECK (
        "reviewedByUserId" IS NULL
        OR ("reviewedByUserId" <> "declaredByUserId" AND "reviewedByUserId" <> "ownerUserIdAtDeclaration")
    );

-- The stamps agree with the status:
--   DECLARED             not reviewed, not withdrawn, no suspension asked
--   REVIEWED             reviewed, not withdrawn, no suspension asked
--   SUSPENDED_REQUESTED  a suspension was asked for, by a named kill or none
--   WITHDRAWN            withdrawn
ALTER TABLE "AgentSpendingAuthority" ADD CONSTRAINT "AgentSpendingAuthority_stamps_agree_with_status"
    CHECK (
        (("reviewedAt" IS NULL) = ("reviewedByUserId" IS NULL))
        AND (("withdrawnAt" IS NULL) = ("withdrawnByUserId" IS NULL))
        AND ("status" <> 'DECLARED' OR ("reviewedAt" IS NULL AND "withdrawnAt" IS NULL AND "suspensionRequestedAt" IS NULL))
        AND ("status" <> 'REVIEWED' OR ("reviewedAt" IS NOT NULL AND "withdrawnAt" IS NULL AND "suspensionRequestedAt" IS NULL))
        AND ("status" <> 'SUSPENDED_REQUESTED' OR ("suspensionRequestedAt" IS NOT NULL AND "withdrawnAt" IS NULL))
        AND ("status" <> 'WITHDRAWN' OR "withdrawnAt" IS NOT NULL)
    );

-- ─── Triggers ───────────────────────────────────────────────────────

-- THE ENVELOPE'S LIFECYCLE, for every role, the table owner included.
--
--   * A row is inserted at DECLARED, and never for a RETIRED agent. FOR SHARE
--     on the agent row serialises the insert with retirement's and activation's
--     status UPDATE, in the shape of 20261017235800's insert triggers.
--   * Its identity (tenant, agent, rail, creation) never changes.
--   * A REVIEWED row's envelope changes only by NARROWING: no larger amount, no
--     later expiry, the same currency, period, consenter, token requestor and
--     reference, and a merchant scope inside the reviewed one (an unrestricted
--     scope may be restricted; a restricted one may only lose entries, never
--     all of them). Anything wider moves the row to DECLARED, with a new
--     `declaredAt` and the review cleared, in the same UPDATE.
--   * A move back to DECLARED carries a NEW declaration: `declaredAt` changes.
--   * A move to REVIEWED comes only from DECLARED, and the review stamp is
--     written once per declaration.
CREATE OR REPLACE FUNCTION agent_spending_authority_lifecycle()
RETURNS TRIGGER AS $$
DECLARE
    agent_status "AgentStatus";
    narrowing BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'DECLARED' THEN
            RAISE EXCEPTION
                'SPENDING_AUTHORITY_STARTS_DECLARED: an envelope is created DECLARED and '
                'reaches REVIEWED only through a second person''s review.';
        END IF;
        SELECT ra."status" INTO agent_status
          FROM "RegisteredAgent" ra
         WHERE ra."id" = NEW."agentId" AND ra."tenantId" = NEW."tenantId"
           FOR SHARE;
        IF agent_status = 'RETIRED' THEN
            RAISE EXCEPTION
                'AGENT_RETIRED: a retired agent holds no authority, so no spending '
                'authority can be declared for it.';
        END IF;
        RETURN NEW;
    END IF;

    IF ROW(NEW."id", NEW."tenantId", NEW."agentId", NEW."rail", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."agentId", OLD."rail", OLD."createdAt")
    THEN
        RAISE EXCEPTION
            'IMMUTABLE_SPENDING_AUTHORITY: an envelope always describes the agent and '
            'rail it was declared for.';
    END IF;

    IF NEW."status" = 'DECLARED' AND OLD."status" <> 'DECLARED'
       AND NEW."declaredAt" IS NOT DISTINCT FROM OLD."declaredAt" THEN
        RAISE EXCEPTION
            'SPENDING_AUTHORITY_REDECLARATION_NEEDS_STAMPS: moving an envelope back to '
            'DECLARED is a new declaration and records who made it and when.';
    END IF;

    IF NEW."status" = 'REVIEWED' AND OLD."status" NOT IN ('REVIEWED', 'DECLARED') THEN
        RAISE EXCEPTION
            'SPENDING_AUTHORITY_REVIEW_ONLY_FROM_DECLARED: only a declared envelope is '
            'reviewed; a suspended or withdrawn one is declared again first.';
    END IF;

    IF OLD."status" = 'REVIEWED' AND NEW."status" IN ('REVIEWED', 'SUSPENDED_REQUESTED', 'WITHDRAWN') THEN
        narrowing :=
            NEW."perTransactionLimitMinor" <= OLD."perTransactionLimitMinor"
            AND NEW."periodBudgetMinor" <= OLD."periodBudgetMinor"
            AND NEW."expiresAt" <= OLD."expiresAt"
            AND NEW."currency" = OLD."currency"
            AND NEW."budgetPeriod" = OLD."budgetPeriod"
            AND NEW."consentedByUserId" = OLD."consentedByUserId"
            AND NEW."tokenRequestor" = OLD."tokenRequestor"
            AND NEW."tokenReference" = OLD."tokenReference"
            AND NEW."declaredByUserId" = OLD."declaredByUserId"
            AND NEW."declaredAt" = OLD."declaredAt"
            AND NEW."ownerUserIdAtDeclaration" = OLD."ownerUserIdAtDeclaration"
            AND (
                (cardinality(OLD."merchantDomains") = 0 AND cardinality(OLD."merchantCategoryCodes") = 0)
                OR (
                    (cardinality(NEW."merchantDomains") + cardinality(NEW."merchantCategoryCodes")) > 0
                    AND NEW."merchantDomains" <@ OLD."merchantDomains"
                    AND NEW."merchantCategoryCodes" <@ OLD."merchantCategoryCodes"
                )
            );
        IF NOT narrowing THEN
            RAISE EXCEPTION
                'SPENDING_AUTHORITY_WIDENING_NEEDS_REVIEW: a reviewed envelope changes '
                'in place only by narrowing; a wider one is declared again and reviewed '
                'by a second person.';
        END IF;
        IF NEW."status" = 'REVIEWED'
           AND (NEW."reviewedByUserId" IS DISTINCT FROM OLD."reviewedByUserId"
                OR NEW."reviewedAt" IS DISTINCT FROM OLD."reviewedAt") THEN
            RAISE EXCEPTION
                'SPENDING_AUTHORITY_REVIEW_WRITE_ONCE: a review stamps the envelope it '
                'reviewed and is not rewritten.';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_spending_authority_lifecycle_trg ON "AgentSpendingAuthority";
CREATE TRIGGER agent_spending_authority_lifecycle_trg
    BEFORE INSERT OR UPDATE ON "AgentSpendingAuthority"
    FOR EACH ROW EXECUTE FUNCTION agent_spending_authority_lifecycle();

-- ACTIVATION, for every writer of "RegisteredAgent": an agent holding an
-- UNREVIEWED envelope never moves to ACTIVE. Unreviewed is DECLARED, and also
-- SUSPENDED_REQUESTED with no review stamp: a kill moves a DECLARED envelope
-- out of DECLARED without a review, and lifting it reverses nothing, so
-- DECLARED alone would let one person declare, kill, lift and activate.
-- `assertActivatable`
-- refuses SPENDING_AUTHORITY_UNREVIEWED first with a sentence for the
-- operator; this is the backstop, and it closes the race with a declaration in
-- flight: the declaration takes FOR SHARE on the agent row, so this UPDATE
-- waits for it and then reads the committed row.
CREATE OR REPLACE FUNCTION registered_agent_spending_authority_reviewed()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."status" = 'ACTIVE' AND OLD."status" IS DISTINCT FROM 'ACTIVE'
       AND EXISTS (
           SELECT 1 FROM "AgentSpendingAuthority" asa
            WHERE asa."agentId" = NEW."id"
              AND asa."tenantId" = NEW."tenantId"
              AND (
                  asa."status" = 'DECLARED'
                  OR (asa."status" = 'SUSPENDED_REQUESTED' AND asa."reviewedAt" IS NULL)
              )
       ) THEN
        RAISE EXCEPTION
            'SPENDING_AUTHORITY_UNREVIEWED: this agent has a declared spending authority '
            'nobody else has reviewed, so it cannot go into service.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS registered_agent_spending_authority_reviewed ON "RegisteredAgent";
CREATE TRIGGER registered_agent_spending_authority_reviewed
    BEFORE UPDATE OF "status" ON "RegisteredAgent"
    FOR EACH ROW EXECUTE FUNCTION registered_agent_spending_authority_reviewed();

-- ─── Privileges and row-level security ──────────────────────────────
--
-- `app_user` may declare, review, narrow, suspend and withdraw, and may never
-- delete: an envelope is withdrawn, never deleted, so the record of what an
-- agent could spend, and who reviewed it, survives. Default privileges grant
-- DELETE to `app_user` (20260323180000), so it is revoked explicitly. A tenant
-- purge runs privileged, and a referential CASCADE runs as the table owner.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "AgentSpendingAuthority" TO app_user;
        REVOKE DELETE ON "AgentSpendingAuthority" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "AgentSpendingAuthority" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentSpendingAuthority" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentSpendingAuthority";
CREATE POLICY tenant_isolation ON "AgentSpendingAuthority"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentSpendingAuthority";
CREATE POLICY tenant_isolation_insert ON "AgentSpendingAuthority"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentSpendingAuthority";
CREATE POLICY superuser_bypass ON "AgentSpendingAuthority"
    USING (current_setting('role') != 'app_user');
