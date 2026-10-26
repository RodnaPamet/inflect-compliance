-- Step 1a of docs/claude-agent-sdk-design.md (#4143): AGENT PROFILES.
--
--   AgentProfile         what one registered agent should DO: the mutable head,
--                        one per agent, pointing at the APPROVED version in force.
--   AgentProfileVersion  one immutable version: the instructions (encrypted at
--                        rest, Epic B) and their hash, the tools, skills, model
--                        tier, effort, turn bound, output kind and triggers, and
--                        the review stamps.
--   WorkflowRun          gains the pin of the profile version a run executes.
--
-- A version runs only once a person other than its author has approved it
-- (owner decision 3, 2026-10-25). The usecase
-- (`src/app-layer/usecases/agent-profiles.ts`) refuses it first; this migration
-- holds the parts a database can hold, below the usecase:
--
--   * the approver or rejecter is never the author (CHECK);
--   * the status moves one way and every stamp is written once (trigger);
--   * a version's text and settings never change after insert, for any role,
--     so a DECIDED version is frozen except the move to RETIRED (trigger);
--   * one APPROVED and one open version per profile (partial unique indexes);
--   * a run's profile pin is written once (trigger) and both-or-neither (CHECK).
--
-- ROLLING-DEPLOY SAFETY. Forward-only and additive: two NEW enum types, two NEW
-- tables and two NEW nullable columns that the previous image never reads. A new
-- enum type is a single deploy; only a value added to an existing enum needs two.
--
-- No `USING ERRCODE` on the lifecycle triggers, for the reason the tenant-skill
-- migration gives: they fire on the typed Prisma path, and the default P0001
-- keeps the message, which names the rule.

-- CreateEnum
CREATE TYPE "AgentProfileVersionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RETIRED');

-- CreateEnum
CREATE TYPE "AgentProfileOutputKind" AS ENUM ('ANSWER_ONLY', 'ANSWER_AND_PROPOSALS');

-- CreateTable
CREATE TABLE "AgentProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "currentApprovedVersion" INTEGER,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentProfileVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "instructions" TEXT NOT NULL,
    "instructionsHash" TEXT NOT NULL,
    "toolNames" TEXT[],
    "skillRefs" JSONB NOT NULL,
    "modelTier" TEXT NOT NULL,
    "effort" TEXT NOT NULL,
    "maxTurns" INTEGER NOT NULL,
    "outputKind" "AgentProfileOutputKind" NOT NULL,
    "allowedTriggers" TEXT[],
    "status" "AgentProfileVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "authoredByUserId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "submittedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "retiredAt" TIMESTAMP(3),
    "retiredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentProfileVersion_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN "profileVersionId" TEXT,
ADD COLUMN "profileInstructionsHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_id_tenantId_key" ON "AgentProfile"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_tenantId_agentId_key" ON "AgentProfile"("tenantId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_agentId_tenantId_key" ON "AgentProfile"("agentId", "tenantId");

-- CreateIndex
CREATE INDEX "AgentProfileVersion_tenantId_status_idx" ON "AgentProfileVersion"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfileVersion_id_tenantId_key" ON "AgentProfileVersion"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfileVersion_tenantId_profileId_version_key" ON "AgentProfileVersion"("tenantId", "profileId", "version");

-- AddForeignKey
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: composite, so a profile can never point at another tenant's agent.
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_agentId_tenantId_fkey" FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: composite, so a version can never be attached to another
-- tenant's profile.
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_profileId_tenantId_fkey" FOREIGN KEY ("profileId", "tenantId") REFERENCES "AgentProfile"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── CHECKs ─────────────────────────────────────────────────────────

ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_current_version_positive"
    CHECK ("currentApprovedVersion" IS NULL OR "currentApprovedVersion" >= 1);

ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_version_positive"
    CHECK ("version" >= 1);

ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_instructions_hash_format"
    CHECK ("instructionsHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_instructions_present"
    CHECK (char_length(btrim("instructions")) > 0);

-- Prisma emits a list column as a nullable TEXT[]; a NULL list is no answer, so
-- it is refused here rather than in the schema, where NOT NULL would read as
-- drift. A profile uses at least one tool: an empty list would admit a run that
-- can read nothing and answer anyway.
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_tool_names_present"
    CHECK ("toolNames" IS NOT NULL AND cardinality("toolNames") BETWEEN 1 AND 128);

ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_skill_refs_array"
    CHECK (jsonb_typeof("skillRefs") = 'array' AND jsonb_array_length("skillRefs") <= 32);

-- The deployment's model tiers, never a model id. `PROFILE_MODEL_TIERS` in
-- `src/lib/agentic/agent-profile.ts`; widening one is this CHECK's change.
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_model_tier_allowed"
    CHECK ("modelTier" IN ('balanced', 'deep'));

-- `PROFILE_EFFORTS`.
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_effort_allowed"
    CHECK ("effort" IN ('low', 'medium', 'high'));

-- 1 to `ENGINE_CAPS.MAX_STEPS`: a profile can only narrow the engine's bound.
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_max_turns_bounded"
    CHECK ("maxTurns" BETWEEN 1 AND 50);

-- `PROFILE_TRIGGERS`, at least one.
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_triggers_allowed"
    CHECK (
        "allowedTriggers" IS NOT NULL
        AND cardinality("allowedTriggers") >= 1
        AND "allowedTriggers" <@ ARRAY['ASK', 'AUTOMATION', 'TEST_RUN']::text[]
    );

-- THE AUTHOR CANNOT DECIDE THEIR OWN VERSION, approve or reject (owner decision
-- 3). The usecase refuses it first; this is the backstop for every path the
-- usecase does not own.
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_not_self_decided"
    CHECK ("decidedByUserId" IS NULL OR "decidedByUserId" <> "authoredByUserId");

-- The stamps agree with the status. Each pair is all-NULL or all-set:
--   DRAFT      no submission, decision or retirement
--   SUBMITTED  submitted, not decided
--   APPROVED   submitted and decided
--   REJECTED   submitted and decided
--   RETIRED    retired, from any of the four, keeping the stamps it had
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_stamps_agree_with_status"
    CHECK (
        (("submittedAt" IS NULL) = ("submittedByUserId" IS NULL))
        AND (("decidedAt" IS NULL) = ("decidedByUserId" IS NULL))
        AND (("retiredAt" IS NULL) = ("retiredByUserId" IS NULL))
        AND (("status" = 'RETIRED') = ("retiredAt" IS NOT NULL))
        AND ("decidedAt" IS NULL OR "submittedAt" IS NOT NULL)
        AND ("status" <> 'DRAFT' OR ("submittedAt" IS NULL AND "decidedAt" IS NULL))
        AND ("status" <> 'SUBMITTED' OR ("submittedAt" IS NOT NULL AND "decidedAt" IS NULL))
        AND ("status" NOT IN ('APPROVED', 'REJECTED') OR "decidedAt" IS NOT NULL)
    );

-- A run's profile pin is both-or-neither, and the hash is a hex SHA-256.
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_profile_pin_complete"
    CHECK (
        ("profileVersionId" IS NULL AND "profileInstructionsHash" IS NULL)
        OR ("profileVersionId" IS NOT NULL AND "profileInstructionsHash" ~ '^[0-9a-f]{64}$')
    );

-- ─── Partial unique indexes ─────────────────────────────────────────
--
-- Prisma cannot declare a partial index; the model says not to add a
-- `@@unique` for either, because the next `migrate dev` would replace it with
-- an unconditional one.

-- At most ONE version in force per profile, so "what is this agent told" has
-- one answer.
CREATE UNIQUE INDEX "AgentProfileVersion_one_approved_per_profile"
    ON "AgentProfileVersion"("tenantId", "profileId")
    WHERE "status" = 'APPROVED';

-- At most ONE open version (DRAFT or SUBMITTED) per profile. A new edit retires
-- the open one in the same transaction, so a reviewer never approves a version
-- its author has already replaced.
CREATE UNIQUE INDEX "AgentProfileVersion_one_open_per_profile"
    ON "AgentProfileVersion"("tenantId", "profileId")
    WHERE "status" IN ('DRAFT', 'SUBMITTED');

-- ─── Triggers ───────────────────────────────────────────────────────

-- A profile's identity never changes: which agent it describes, in which
-- tenant, created by whom. Only the pointer moves.
CREATE OR REPLACE FUNCTION agent_profile_identity_is_final()
RETURNS TRIGGER AS $$
BEGIN
    IF ROW(NEW."id", NEW."tenantId", NEW."agentId", NEW."createdByUserId", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."agentId", OLD."createdByUserId", OLD."createdAt")
    THEN
        RAISE EXCEPTION
            'IMMUTABLE_AGENT_PROFILE: a profile always describes the agent it was '
            'created for; only the version in force moves.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_profile_identity_is_final ON "AgentProfile";
CREATE TRIGGER agent_profile_identity_is_final
    BEFORE UPDATE ON "AgentProfile"
    FOR EACH ROW EXECUTE FUNCTION agent_profile_identity_is_final();

-- THE VERSION LIFECYCLE, for every role, the table owner included.
--
--   * A version is inserted at DRAFT.
--   * Its text and settings never change. An edit is a new version.
--   * The one exception is the rotation sweeps' re-wrap of `instructions`:
--     the tenant-DEK and master-KEK sweeps rewrite every manifest ciphertext in
--     place, so ciphertext to `v2:` ciphertext with EVERY other column unchanged
--     is admitted, and nothing else (`docs/epic-b-encryption.md`). Whoever
--     changes the ciphertext, the resolver recomputes the hash of the decrypted
--     text and refuses a version whose text no longer matches.
--   * The status moves one way: DRAFT → SUBMITTED | RETIRED,
--     SUBMITTED → APPROVED | REJECTED | RETIRED, APPROVED → RETIRED,
--     REJECTED → RETIRED. RETIRED is terminal. So a DECIDED version (APPROVED
--     or REJECTED) is frozen except the move to RETIRED.
--   * Every stamp is written once: NULL → value, never value → anything else.
CREATE OR REPLACE FUNCTION agent_profile_version_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'DRAFT' THEN
            RAISE EXCEPTION
                'AGENT_PROFILE_VERSION_STARTS_AT_DRAFT: a version is created as a '
                'DRAFT and reaches review only by being submitted.';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."instructions" IS DISTINCT FROM OLD."instructions" THEN
        IF (to_jsonb(NEW) - 'instructions') = (to_jsonb(OLD) - 'instructions')
           AND OLD."instructions" ~ '^v[12]:' AND NEW."instructions" ~ '^v2:' THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION
            'IMMUTABLE_AGENT_PROFILE_VERSION: a version''s instructions never change; '
            'an edit is a new version, which starts at DRAFT.';
    END IF;

    IF ROW(NEW."id", NEW."tenantId", NEW."profileId", NEW."version", NEW."instructionsHash",
           NEW."toolNames", NEW."skillRefs", NEW."modelTier", NEW."effort", NEW."maxTurns",
           NEW."outputKind", NEW."allowedTriggers", NEW."authoredByUserId", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."profileId", OLD."version", OLD."instructionsHash",
           OLD."toolNames", OLD."skillRefs", OLD."modelTier", OLD."effort", OLD."maxTurns",
           OLD."outputKind", OLD."allowedTriggers", OLD."authoredByUserId", OLD."createdAt")
    THEN
        RAISE EXCEPTION
            'IMMUTABLE_AGENT_PROFILE_VERSION: a version''s settings never change; '
            'an edit is a new version, which starts at DRAFT.';
    END IF;

    IF (OLD."submittedAt" IS NOT NULL AND NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt")
       OR (OLD."submittedByUserId" IS NOT NULL AND NEW."submittedByUserId" IS DISTINCT FROM OLD."submittedByUserId")
       OR (OLD."decidedAt" IS NOT NULL AND NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt")
       OR (OLD."decidedByUserId" IS NOT NULL AND NEW."decidedByUserId" IS DISTINCT FROM OLD."decidedByUserId")
       OR (OLD."retiredAt" IS NOT NULL AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt")
       OR (OLD."retiredByUserId" IS NOT NULL AND NEW."retiredByUserId" IS DISTINCT FROM OLD."retiredByUserId")
    THEN
        RAISE EXCEPTION
            'AGENT_PROFILE_STAMP_WRITE_ONCE: a review stamp is recorded once and '
            'never revised.';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'DRAFT' AND NEW."status" IN ('SUBMITTED', 'RETIRED'))
        OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('APPROVED', 'REJECTED', 'RETIRED'))
        OR (OLD."status" IN ('APPROVED', 'REJECTED') AND NEW."status" = 'RETIRED')
    ) THEN
        RAISE EXCEPTION
            'AGENT_PROFILE_STATUS_ONE_WAY: a version moves from % to % only one '
            'way; a decided version moves only to RETIRED, and RETIRED is terminal.',
            OLD."status", NEW."status";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_profile_version_lifecycle_trg ON "AgentProfileVersion";
CREATE TRIGGER agent_profile_version_lifecycle_trg
    BEFORE INSERT OR UPDATE ON "AgentProfileVersion"
    FOR EACH ROW EXECUTE FUNCTION agent_profile_version_lifecycle();

-- THE RUN'S PROFILE PIN is written in the CREATE and never after, for every
-- role, the way `mountedSkills` is: the version is resolved before the row
-- exists, so a later write could only be a reconstruction. Raised at the
-- default SQLSTATE (P0001), so Prisma passes the message through.
CREATE OR REPLACE FUNCTION workflow_run_profile_pin_immutable_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."profileVersionId" IS DISTINCT FROM OLD."profileVersionId"
       OR NEW."profileInstructionsHash" IS DISTINCT FROM OLD."profileInstructionsHash" THEN
        RAISE EXCEPTION
            'IMMUTABLE_PROFILE_PIN: WorkflowRun.profileVersionId and '
            'profileInstructionsHash are written once, when the run is created. '
            'They record what the agent was told; rewriting them would describe '
            'a different run.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_run_profile_pin_immutable ON "WorkflowRun";
CREATE TRIGGER workflow_run_profile_pin_immutable
    BEFORE UPDATE ON "WorkflowRun"
    FOR EACH ROW EXECUTE FUNCTION workflow_run_profile_pin_immutable_guard();

-- ─── Privileges and row-level security ──────────────────────────────
--
-- `app_user` may create a profile and its versions, move the pointer and move a
-- version through review, and may never delete either: a version is retired,
-- never deleted, so the record of who approved which text survives. Default
-- privileges grant DELETE to `app_user` (20260323180000), so it is revoked
-- explicitly. A tenant purge runs privileged, and a referential CASCADE runs as
-- the table owner.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "AgentProfile" TO app_user;
        REVOKE DELETE ON "AgentProfile" FROM app_user;
        GRANT SELECT, INSERT, UPDATE ON "AgentProfileVersion" TO app_user;
        REVOKE DELETE ON "AgentProfileVersion" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "AgentProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentProfile" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentProfile";
CREATE POLICY tenant_isolation ON "AgentProfile"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentProfile";
CREATE POLICY tenant_isolation_insert ON "AgentProfile"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentProfile";
CREATE POLICY superuser_bypass ON "AgentProfile"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "AgentProfileVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentProfileVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentProfileVersion";
CREATE POLICY tenant_isolation ON "AgentProfileVersion"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentProfileVersion";
CREATE POLICY tenant_isolation_insert ON "AgentProfileVersion"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentProfileVersion";
CREATE POLICY superuser_bypass ON "AgentProfileVersion"
    USING (current_setting('role') != 'app_user');
