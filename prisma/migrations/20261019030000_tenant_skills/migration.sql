-- Step 4c (#3680): tenant-authored skills under the review lifecycle.
--
--   TenantSkill         a skill's identity in one tenant: its name and who
--                       created it. Append-only.
--   TenantSkillVersion  one immutable version of it: the frontmatter fields,
--                       the instructions (encrypted at rest, Epic B), the
--                       workflows it mounts on, its content hash, its
--                       evaluation record, and the review stamps.
--
-- A tenant skill mounts only when a version is APPROVED by a person other
-- than its author, carries a passing evaluation record, passes the load-time
-- text scan and still hashes to the hash its approval pinned. The usecase
-- (`src/app-layer/usecases/tenant-skills.ts`) and the mount gate
-- (`src/lib/agentic/flue/skills/tenant-skill.ts`) enforce that; this migration
-- holds the parts a database can hold, below both of them:
--
--   * self-approval is unrepresentable (CHECK);
--   * approval pins the content hash it reviewed (CHECK);
--   * the status moves one way and every stamp is written once (trigger);
--   * a version's text never changes after insert (trigger), so an edit is a
--     new version that starts at DRAFT;
--   * one APPROVED and one open version per skill (partial unique indexes).
--
-- ROLLING-DEPLOY SAFETY. Forward-only and additive: two NEW enum types and two
-- NEW tables, which the previous image never reads. A new enum type is a single
-- deploy; only a value added to an existing enum would need two.
--
-- No `USING ERRCODE` on the triggers, for the reason the agent-proposal
-- approval triggers give: they fire on the typed Prisma path, and the default
-- P0001 keeps the message, which names the rule.

-- CreateEnum
CREATE TYPE "TenantSkillVersionStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'RETIRED');

-- CreateEnum
CREATE TYPE "TenantSkillRetiredReason" AS ENUM ('REJECTED', 'SUPERSEDED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "TenantSkill" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSkillVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "requiredInput" TEXT,
    "output" TEXT,
    "controls" TEXT,
    "tools" TEXT,
    "workflowKeys" TEXT[],
    "contentHash" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "status" "TenantSkillVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "evaluationRecordJson" TEXT,
    "evaluationAttachedAt" TIMESTAMP(3),
    "evaluationAttachedByUserId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "approvedContentHash" TEXT,
    "retiredAt" TIMESTAMP(3),
    "retiredByUserId" TEXT,
    "retiredReason" "TenantSkillRetiredReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantSkillVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantSkill_id_tenantId_key" ON "TenantSkill"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSkill_tenantId_name_key" ON "TenantSkill"("tenantId", "name");

-- CreateIndex
CREATE INDEX "TenantSkillVersion_tenantId_status_idx" ON "TenantSkillVersion"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSkillVersion_id_tenantId_key" ON "TenantSkillVersion"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSkillVersion_tenantId_skillId_version_key" ON "TenantSkillVersion"("tenantId", "skillId", "version");

-- AddForeignKey
ALTER TABLE "TenantSkill" ADD CONSTRAINT "TenantSkill_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSkillVersion" ADD CONSTRAINT "TenantSkillVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: composite, so a version can never be attached to another
-- tenant's skill.
ALTER TABLE "TenantSkillVersion" ADD CONSTRAINT "TenantSkillVersion_skillId_tenantId_fkey" FOREIGN KEY ("skillId", "tenantId") REFERENCES "TenantSkill"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── CHECKs ─────────────────────────────────────────────────────────

-- An Agent Skills identifier, as the loader requires of a repository skill.
ALTER TABLE "TenantSkill" ADD CONSTRAINT "TenantSkill_name_format"
    CHECK ("name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("name") <= 64);

ALTER TABLE "TenantSkillVersion" ADD CONSTRAINT "TenantSkillVersion_version_positive"
    CHECK ("version" >= 1);

ALTER TABLE "TenantSkillVersion" ADD CONSTRAINT "TenantSkillVersion_content_hash_format"
    CHECK ("contentHash" ~ '^sha256:[0-9a-f]{64}$');

-- Licensed and sourced (rule 4 of the standard): never blank.
ALTER TABLE "TenantSkillVersion" ADD CONSTRAINT "TenantSkillVersion_licensed_and_sourced"
    CHECK (char_length(btrim("license")) > 0 AND char_length(btrim("sourceRef")) > 0);

-- Prisma emits a list column as a nullable TEXT[]; a NULL list is not "mounts
-- on nothing", it is no answer, so it is refused here rather than in the schema
-- (where NOT NULL would read as drift).
ALTER TABLE "TenantSkillVersion" ADD CONSTRAINT "TenantSkillVersion_workflow_keys_present"
    CHECK ("workflowKeys" IS NOT NULL AND cardinality("workflowKeys") <= 32);

-- THE AUTHOR CANNOT APPROVE THEIR OWN SKILL. The usecase refuses it first;
-- this is the backstop for every path the usecase does not own.
ALTER TABLE "TenantSkillVersion" ADD CONSTRAINT "TenantSkillVersion_not_self_approved"
    CHECK ("approvedByUserId" IS NULL OR "approvedByUserId" <> "authorUserId");

-- APPROVAL PINS THE CONTENT HASH. The approval names the hash the reviewer
-- reviewed, and it must be this version's.
ALTER TABLE "TenantSkillVersion" ADD CONSTRAINT "TenantSkillVersion_approval_pins_hash"
    CHECK ("approvedContentHash" IS NULL OR "approvedContentHash" = "contentHash");

-- The stamps agree with the status. Each group of stamp columns is all-NULL or
-- all-set, and each status names which groups it carries:
--   DRAFT      no submission, approval or retirement
--   IN_REVIEW  submitted, with an evaluation record; not approved
--   APPROVED   submitted, evaluated and approved
--   RETIRED    retired, from any of the three; a REJECTED one was submitted
--              and never approved
ALTER TABLE "TenantSkillVersion" ADD CONSTRAINT "TenantSkillVersion_stamps_agree_with_status"
    CHECK (
        (("evaluationAttachedAt" IS NULL) = ("evaluationRecordJson" IS NULL))
        AND (("evaluationAttachedAt" IS NULL) = ("evaluationAttachedByUserId" IS NULL))
        AND (("submittedAt" IS NULL) = ("submittedByUserId" IS NULL))
        AND (("approvedAt" IS NULL) = ("approvedByUserId" IS NULL))
        AND (("approvedAt" IS NULL) = ("approvedContentHash" IS NULL))
        AND (("retiredAt" IS NULL) = ("retiredByUserId" IS NULL))
        AND (("retiredAt" IS NULL) = ("retiredReason" IS NULL))
        AND (("status" = 'RETIRED') = ("retiredAt" IS NOT NULL))
        AND ("status" <> 'DRAFT' OR ("submittedAt" IS NULL AND "approvedAt" IS NULL))
        AND ("status" <> 'IN_REVIEW'
             OR ("submittedAt" IS NOT NULL AND "evaluationAttachedAt" IS NOT NULL AND "approvedAt" IS NULL))
        AND ("status" <> 'APPROVED'
             OR ("submittedAt" IS NOT NULL AND "evaluationAttachedAt" IS NOT NULL AND "approvedAt" IS NOT NULL))
        AND ("retiredReason" IS DISTINCT FROM 'REJECTED' OR ("submittedAt" IS NOT NULL AND "approvedAt" IS NULL))
    );

-- ─── Partial unique indexes ─────────────────────────────────────────
--
-- Prisma cannot declare a partial index; the model says not to add a
-- `@@unique` for either, because the next `migrate dev` would replace it with
-- an unconditional one.

-- At most ONE version in service per skill, so "which text does this skill
-- teach" has one answer.
CREATE UNIQUE INDEX "TenantSkillVersion_one_approved_per_skill"
    ON "TenantSkillVersion"("tenantId", "skillId")
    WHERE "status" = 'APPROVED';

-- At most ONE open version (DRAFT or IN_REVIEW) per skill. Creating a version
-- supersedes the open one in the same transaction, so a reviewer never approves
-- a version its author has already replaced.
CREATE UNIQUE INDEX "TenantSkillVersion_one_open_per_skill"
    ON "TenantSkillVersion"("tenantId", "skillId")
    WHERE "status" IN ('DRAFT', 'IN_REVIEW');

-- ─── Triggers ───────────────────────────────────────────────────────

-- A skill's identity is append-only. Its name is what a run's catalogue shows
-- and what a pin records, so it never changes for any role.
CREATE OR REPLACE FUNCTION tenant_skill_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'IMMUTABLE_TENANT_SKILL: a tenant skill''s identity never changes; '
        'its text lives on its versions, and an edit is a new version.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_skill_append_only_trg ON "TenantSkill";
CREATE TRIGGER tenant_skill_append_only_trg
    BEFORE UPDATE ON "TenantSkill"
    FOR EACH ROW EXECUTE FUNCTION tenant_skill_append_only();

-- THE VERSION LIFECYCLE.
--
--   * A version is inserted at DRAFT.
--   * Its text and its plaintext metadata never change, for any role. An edit
--     is a new version.
--   * The two ENCRYPTED columns are frozen against `app_user` only. The DEK
--     rotation sweep (`src/app-layer/jobs/tenant-dek-rotation.ts`) re-encrypts
--     every ciphertext in place as the table owner, and a freeze it could not
--     pass would make a tenant's key unrotatable. Whoever changes the
--     instructions, the mount gate recomputes their hash and refuses a version
--     whose text no longer matches the hash its approval pinned.
--   * The evaluation record is written once, while the version is DRAFT, and is
--     never cleared.
--   * The status moves one way: DRAFT → IN_REVIEW | RETIRED,
--     IN_REVIEW → APPROVED | RETIRED, APPROVED → RETIRED. RETIRED is terminal.
--   * Every stamp is written once: NULL → value, never value → anything else.
--     Which stamp goes with which status is the CHECK's job above.
CREATE OR REPLACE FUNCTION tenant_skill_version_lifecycle()
RETURNS TRIGGER AS $$
DECLARE
    v_app_user BOOLEAN := current_setting('role', true) = 'app_user';
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'DRAFT' THEN
            RAISE EXCEPTION
                'TENANT_SKILL_VERSION_STARTS_AT_DRAFT: a version is created as a '
                'DRAFT and reaches review only by being submitted.';
        END IF;
        RETURN NEW;
    END IF;

    IF ROW(NEW."id", NEW."tenantId", NEW."skillId", NEW."version", NEW."description",
           NEW."license", NEW."sourceRef", NEW."requiredInput", NEW."output",
           NEW."controls", NEW."tools", NEW."workflowKeys", NEW."contentHash",
           NEW."authorUserId", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."skillId", OLD."version", OLD."description",
           OLD."license", OLD."sourceRef", OLD."requiredInput", OLD."output",
           OLD."controls", OLD."tools", OLD."workflowKeys", OLD."contentHash",
           OLD."authorUserId", OLD."createdAt")
    THEN
        RAISE EXCEPTION
            'IMMUTABLE_TENANT_SKILL_VERSION: a version''s text never changes; '
            'an edit is a new version, which starts at DRAFT.';
    END IF;

    IF v_app_user AND NEW."instructions" IS DISTINCT FROM OLD."instructions" THEN
        RAISE EXCEPTION
            'IMMUTABLE_TENANT_SKILL_VERSION: a version''s instructions never change; '
            'an edit is a new version, which starts at DRAFT.';
    END IF;

    IF OLD."evaluationRecordJson" IS NULL THEN
        IF NEW."evaluationRecordJson" IS NOT NULL
           AND NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT') THEN
            RAISE EXCEPTION
                'TENANT_SKILL_EVALUATION_WHILE_DRAFT: an evaluation record is '
                'attached to a DRAFT version, before it is submitted for review.';
        END IF;
    ELSIF NEW."evaluationRecordJson" IS NULL
          OR (v_app_user AND NEW."evaluationRecordJson" IS DISTINCT FROM OLD."evaluationRecordJson") THEN
        RAISE EXCEPTION
            'IMMUTABLE_TENANT_SKILL_EVALUATION: a version''s evaluation record is '
            'written once and never replaced or cleared.';
    END IF;

    IF (OLD."evaluationAttachedAt" IS NOT NULL AND NEW."evaluationAttachedAt" IS DISTINCT FROM OLD."evaluationAttachedAt")
       OR (OLD."evaluationAttachedByUserId" IS NOT NULL AND NEW."evaluationAttachedByUserId" IS DISTINCT FROM OLD."evaluationAttachedByUserId")
       OR (OLD."submittedAt" IS NOT NULL AND NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt")
       OR (OLD."submittedByUserId" IS NOT NULL AND NEW."submittedByUserId" IS DISTINCT FROM OLD."submittedByUserId")
       OR (OLD."approvedAt" IS NOT NULL AND NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt")
       OR (OLD."approvedByUserId" IS NOT NULL AND NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId")
       OR (OLD."approvedContentHash" IS NOT NULL AND NEW."approvedContentHash" IS DISTINCT FROM OLD."approvedContentHash")
       OR (OLD."retiredAt" IS NOT NULL AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt")
       OR (OLD."retiredByUserId" IS NOT NULL AND NEW."retiredByUserId" IS DISTINCT FROM OLD."retiredByUserId")
       OR (OLD."retiredReason" IS NOT NULL AND NEW."retiredReason" IS DISTINCT FROM OLD."retiredReason")
    THEN
        RAISE EXCEPTION
            'TENANT_SKILL_STAMP_WRITE_ONCE: a review stamp is recorded once and '
            'never revised.';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'DRAFT' AND NEW."status" IN ('IN_REVIEW', 'RETIRED'))
        OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('APPROVED', 'RETIRED'))
        OR (OLD."status" = 'APPROVED' AND NEW."status" = 'RETIRED')
    ) THEN
        RAISE EXCEPTION
            'TENANT_SKILL_STATUS_ONE_WAY: a version moves from % to % only one '
            'way; RETIRED is terminal and an edit is a new version.',
            OLD."status", NEW."status";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_skill_version_lifecycle_trg ON "TenantSkillVersion";
CREATE TRIGGER tenant_skill_version_lifecycle_trg
    BEFORE INSERT OR UPDATE ON "TenantSkillVersion"
    FOR EACH ROW EXECUTE FUNCTION tenant_skill_version_lifecycle();

-- ─── Privileges and row-level security ──────────────────────────────
--
-- `app_user` may create a skill and its versions and move a version through
-- review, and may never delete either: a version is retired, never deleted, so
-- the record of who reviewed which text survives. The skill's identity takes no
-- UPDATE at all. Default privileges grant DELETE and UPDATE to `app_user`
-- (20260323180000), so they are revoked explicitly. A tenant purge runs
-- privileged, and a referential CASCADE runs as the table owner.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT ON "TenantSkill" TO app_user;
        REVOKE UPDATE, DELETE ON "TenantSkill" FROM app_user;
        GRANT SELECT, INSERT, UPDATE ON "TenantSkillVersion" TO app_user;
        REVOKE DELETE ON "TenantSkillVersion" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "TenantSkill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantSkill" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TenantSkill";
CREATE POLICY tenant_isolation ON "TenantSkill"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TenantSkill";
CREATE POLICY tenant_isolation_insert ON "TenantSkill"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "TenantSkill";
CREATE POLICY superuser_bypass ON "TenantSkill"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "TenantSkillVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantSkillVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TenantSkillVersion";
CREATE POLICY tenant_isolation ON "TenantSkillVersion"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TenantSkillVersion";
CREATE POLICY tenant_isolation_insert ON "TenantSkillVersion"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "TenantSkillVersion";
CREATE POLICY superuser_bypass ON "TenantSkillVersion"
    USING (current_setting('role') != 'app_user');
