-- ═══════════════════════════════════════════════════════════════════
-- Step 3b (#3675): the line-of-defence attribute, the auditor
-- independence check, and the audit workpaper record.
--
--   TenantMembership.lineOfDefence   FIRST | SECOND | THIRD | NULL. NULL is
--                                    "not declared" and never satisfies a
--                                    check. Only an OWNER sets it, on a
--                                    membership not their own
--                                    (setMembershipLineOfDefence).
--   RegisteredAgent.isAuditor        the agent re-performs audit procedures.
--                                    Its owner must be SECOND line and own no
--                                    audited agent (rule 8: the auditor is
--                                    not the auditee).
--   AuditWorkpaper                   one procedure, one period, written by an
--                                    auditor agent; one-way apart from a
--                                    review stamp set once.
--   AuditWorkpaperFinding            the findings a workpaper links;
--                                    insert-only, and never a path that
--                                    closes one.
--
-- Both new tables are Regulatory artefacts the tenant purge retains, so
-- neither has a foreign key to anything the purge deletes: the only keys are to
-- "Tenant" (kept as a tombstone) and, for a link, to its workpaper. The agent
-- and the finding are plain ids, bound at insert by triggers.
--
-- ── ROLLING-DEPLOY SAFETY ───────────────────────────────────────────
--
--   • A NEW enum TYPE on a NEW nullable column, not a value added to an
--     existing type: an old container's Prisma client never selects the
--     column, so it never meets a value it cannot decode.
--   • `isAuditor` is NOT NULL DEFAULT false, a fast default (no rewrite).
--     Old containers insert agents without it, which is false, which the
--     independence trigger ignores.
--   • Two new tables the previous image never reads.
--   • The independence trigger fires only on a row whose `isAuditor` is
--     true, which no old container can write.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1) The line of defence ─────────────────────────────────────────

CREATE TYPE "LineOfDefence" AS ENUM ('FIRST', 'SECOND', 'THIRD');

ALTER TABLE "TenantMembership" ADD COLUMN "lineOfDefence" "LineOfDefence";

-- ─── 2) The auditor mark ────────────────────────────────────────────

ALTER TABLE "RegisteredAgent" ADD COLUMN "isAuditor" BOOLEAN NOT NULL DEFAULT false;

-- ─── 3) The independence check, below the usecase ───────────────────
--
-- `assertAuditorIndependentInTx` (src/app-layer/usecases/auditor-independence.ts)
-- refuses first, with a named reason. This trigger refuses the same rows for
-- any writer that skips it — a second caller of the status writer, a script,
-- a migration — at the two moments the rule is a REFUSAL:
--
--   • a row BECOMES an auditor (INSERT with isAuditor, or false → true);
--   • an auditor goes ACTIVE (status moves to ACTIVE).
--
-- Every other moment — an ownership transfer of an auditor, a new agent
-- registered to its owner, the owner's line moving off SECOND — is a LATER
-- change, which raises a finding (the usecase's reconcile) and is NOT
-- refused here. A trigger that refused a transfer would stop an
-- accountability handover; the issue asks for a finding.
--
-- The rule, read here exactly as the usecase reads it:
--   1. the owner holds an ACTIVE membership of this tenant;
--   2. its line of defence is declared (NOT NULL) and is SECOND;
--   3. the owner owns no AUDITED agent — any other agent of this tenant that
--      is not itself an auditor, not RETIRED and not soft-deleted. DRAFT and
--      SUSPENDED agents count: each can be put back into service.
--
-- It takes the tenant's independence lock first, the same key the usecases
-- take (`auditor-independence:<tenantId>`), so a concurrent registration of an
-- audited agent and an activation of an auditor serialise rather than each
-- passing on a snapshot that cannot see the other.
--
-- No `USING ERRCODE`: P0001 keeps the text, and the reason code leads it.

CREATE OR REPLACE FUNCTION registered_agent_auditor_independence()
RETURNS TRIGGER AS $$
DECLARE
    v_line   TEXT;
    v_status TEXT;
    v_owned  INTEGER;
BEGIN
    IF NOT NEW."isAuditor" OR NEW."status" = 'RETIRED' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD."isAuditor"
       AND NOT (NEW."status" = 'ACTIVE' AND OLD."status" IS DISTINCT FROM 'ACTIVE') THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('auditor-independence:' || NEW."tenantId"));

    SELECT m."lineOfDefence"::TEXT, m."status"::TEXT
      INTO v_line, v_status
      FROM "TenantMembership" m
     WHERE m."tenantId" = NEW."tenantId" AND m."userId" = NEW."ownerUserId";

    IF NOT FOUND OR v_status <> 'ACTIVE' THEN
        RAISE EXCEPTION
            'AUDITOR_NOT_INDEPENDENT: OWNER_NOT_ACTIVE_MEMBER: the owner of auditor agent % '
            'holds no ACTIVE membership of tenant %.',
            NEW."id", NEW."tenantId";
    END IF;

    IF v_line IS NULL THEN
        RAISE EXCEPTION
            'AUDITOR_NOT_INDEPENDENT: OWNER_LINE_UNDECLARED: the owner of auditor agent % has '
            'no declared line of defence; an undeclared line never satisfies the check.',
            NEW."id";
    END IF;

    IF v_line <> 'SECOND' THEN
        RAISE EXCEPTION
            'AUDITOR_NOT_INDEPENDENT: OWNER_NOT_SECOND_LINE: the owner of auditor agent % is '
            '% line; an auditor agent is owned by the second line.',
            NEW."id", v_line;
    END IF;

    SELECT count(*)::INTEGER INTO v_owned
      FROM "RegisteredAgent" a
     WHERE a."tenantId" = NEW."tenantId"
       AND a."ownerUserId" = NEW."ownerUserId"
       AND a."id" <> NEW."id"
       AND NOT a."isAuditor"
       AND a."status" <> 'RETIRED'
       AND a."deletedAt" IS NULL;

    IF v_owned > 0 THEN
        RAISE EXCEPTION
            'AUDITOR_NOT_INDEPENDENT: OWNER_OWNS_AUDITED_AGENT: the owner of auditor agent % '
            'owns % audited agent(s); the auditor is not the auditee.',
            NEW."id", v_owned;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS registered_agent_auditor_independence_trg ON "RegisteredAgent";
CREATE TRIGGER registered_agent_auditor_independence_trg
    BEFORE INSERT OR UPDATE OF "isAuditor", "status" ON "RegisteredAgent"
    FOR EACH ROW EXECUTE FUNCTION registered_agent_auditor_independence();

-- ─── 4) The workpaper ───────────────────────────────────────────────

CREATE TABLE "AuditWorkpaper" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "catalogueVersion" INTEGER NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "populationDefinition" TEXT NOT NULL,
    "populationCount" INTEGER NOT NULL,
    "populationDigest" TEXT NOT NULL,
    "sampleEpoch" TEXT,
    "seedFingerprint" TEXT,
    "sampleSize" INTEGER,
    "sampledUnitIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parametersJson" JSONB,
    "attributesTested" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "itemOutcomesJson" JSONB NOT NULL,
    "exceptionsJson" JSONB NOT NULL,
    "exceptionCount" INTEGER NOT NULL,
    "conclusion" "TestResult" NOT NULL,
    "conclusionBasis" TEXT NOT NULL,
    "evidenceRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "proposalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "auditorAgentId" TEXT NOT NULL,
    "controlTestRunId" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditWorkpaper_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditWorkpaper_tenantId_procedureId_periodLabel_idx" ON "AuditWorkpaper"("tenantId", "procedureId", "periodLabel");
CREATE INDEX "AuditWorkpaper_tenantId_auditorAgentId_idx" ON "AuditWorkpaper"("tenantId", "auditorAgentId");
CREATE INDEX "AuditWorkpaper_tenantId_createdAt_idx" ON "AuditWorkpaper"("tenantId", "createdAt");
CREATE UNIQUE INDEX "AuditWorkpaper_id_tenantId_key" ON "AuditWorkpaper"("id", "tenantId");

ALTER TABLE "AuditWorkpaper" ADD CONSTRAINT "AuditWorkpaper_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `auditorAgentId` carries NO foreign key, as "AgentKillSwitch"."agentId" and
-- "AgentActionReceipt"."agentId" do not. The tenant purge (tenant-purge.ts)
-- retains every Regulatory artefact and deletes the register: a NO ACTION key
-- would fail every purge of a tenant with a workpaper, and a CASCADE one would
-- destroy the workpaper with the agent. The insert guard below refuses an id
-- that is not an auditor agent of the same tenant, so the reference is
-- tenant-bound and true at the moment it is written.

-- Every fact on a workpaper is a code, an identifier or a count
-- (docs/agentic-audit-procedures.md). The CHECKs pin the shapes the usecase
-- validates, for any writer that does not go through it.
ALTER TABLE "AuditWorkpaper" ADD CONSTRAINT "AuditWorkpaper_shapes" CHECK (
        "procedureId" ~ '^[a-z]+\.[a-z_]+$'
    AND "catalogueVersion" >= 1
    AND "periodLabel" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'
    AND "populationCount" >= 0
    AND "populationDigest" ~ '^[0-9a-f]{64}$'
    AND char_length("populationDefinition") BETWEEN 1 AND 2000
    AND "conclusionBasis" ~ '^[A-Z][A-Z0-9_]{0,63}$'
    AND "sampledUnitIds" IS NOT NULL
    AND "attributesTested" IS NOT NULL
    AND "evidenceRefs" IS NOT NULL
    AND "proposalIds" IS NOT NULL
    AND jsonb_typeof("itemOutcomesJson") = 'array'
    AND jsonb_typeof("exceptionsJson") = 'array'
    AND jsonb_array_length("exceptionsJson") = "exceptionCount"
);

-- The sample is all-or-nothing: none drawn (a precondition stopped the run),
-- or every part of it recorded, sized by its own id list, inside the
-- population. The epoch is `<procedureId>@<periodLabel>`, or that followed by
-- `/<sub-population>` for a procedure that draws two (`starts_with`, not
-- LIKE: a procedure id carries `_`, which LIKE reads as a wildcard).
ALTER TABLE "AuditWorkpaper" ADD CONSTRAINT "AuditWorkpaper_sample_all_or_nothing" CHECK (
    (
            "sampleEpoch" IS NULL AND "seedFingerprint" IS NULL AND "sampleSize" IS NULL
        AND cardinality("sampledUnitIds") = 0
    )
    OR (
            (
                   "sampleEpoch" = "procedureId" || '@' || "periodLabel"
                OR starts_with("sampleEpoch", "procedureId" || '@' || "periodLabel" || '/')
            )
        AND "seedFingerprint" ~ '^[0-9a-f]{64}$'
        AND "sampleSize" >= 1
        AND "sampleSize" <= "populationCount"
        AND cardinality("sampledUnitIds") = "sampleSize"
    )
);

-- An empty population can never pass, and a PASS is tested, not assumed:
-- `populationCount > 0 && tested === sampleSize && exceptions === 0`, never
-- `exceptions === 0` alone. A FAIL names at least one exception.
ALTER TABLE "AuditWorkpaper" ADD CONSTRAINT "AuditWorkpaper_conclusion_is_earned" CHECK (
    (
        "conclusion" <> 'PASS'
        OR ("populationCount" > 0 AND "sampleSize" IS NOT NULL AND "exceptionCount" = 0)
    )
    AND ("conclusion" <> 'FAIL' OR "exceptionCount" > 0)
);

-- The review stamp travels as a pair.
ALTER TABLE "AuditWorkpaper" ADD CONSTRAINT "AuditWorkpaper_review_stamp_pairing" CHECK (
    ("reviewedAt" IS NULL) = ("reviewedByUserId" IS NULL)
);

-- ─── 5) The insert guard: an auditor wrote it, unreviewed, and the first
--        sample for its procedure and period is binding ────────────────
--
-- A workpaper is the AUDITOR's output, so its author must be a registered
-- agent marked `isAuditor` in this tenant. It is born unreviewed: the stamp is
-- a later, separate act.
--
-- THE FIRST SAMPLE IS BINDING (docs/agentic-audit-procedures.md, Population).
-- The first workpaper that draws a sample for (tenant, procedure, period) fixes
-- the epoch, the seed fingerprint and the sampled ids; a later run reuses them
-- and only re-evaluates the attributes. A different sample is refused, so a
-- re-run cannot go looking for a more favourable one. The lock serialises two
-- concurrent first runs for the same key: the second waits, then (READ
-- COMMITTED, a fresh snapshot per statement) sees the first and is held to it.

CREATE OR REPLACE FUNCTION audit_workpaper_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
    v_is_auditor BOOLEAN;
    v_epoch      TEXT;
    v_seed       TEXT;
    v_ids        TEXT[];
    v_first_id   TEXT;
BEGIN
    SELECT a."isAuditor" INTO v_is_auditor
      FROM "RegisteredAgent" a
     WHERE a."id" = NEW."auditorAgentId" AND a."tenantId" = NEW."tenantId";

    IF NOT FOUND OR NOT v_is_auditor THEN
        RAISE EXCEPTION
            'AUDIT_WORKPAPER_AUTHOR_NOT_AUDITOR: agent % is not an auditor agent of tenant %.',
            NEW."auditorAgentId", NEW."tenantId";
    END IF;

    IF NEW."reviewedAt" IS NOT NULL OR NEW."reviewedByUserId" IS NOT NULL THEN
        RAISE EXCEPTION
            'AUDIT_WORKPAPER_BORN_REVIEWED: a workpaper is stored unreviewed; the review stamp '
            'is a separate act.';
    END IF;

    IF NEW."sampleEpoch" IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(
        'audit-workpaper-sample:' || NEW."tenantId" || ':' || NEW."procedureId" || ':' || NEW."periodLabel"
    ));

    SELECT w."id", w."sampleEpoch", w."seedFingerprint", w."sampledUnitIds"
      INTO v_first_id, v_epoch, v_seed, v_ids
      FROM "AuditWorkpaper" w
     WHERE w."tenantId" = NEW."tenantId"
       AND w."procedureId" = NEW."procedureId"
       AND w."periodLabel" = NEW."periodLabel"
       AND w."sampleEpoch" IS NOT NULL
     ORDER BY w."createdAt" ASC, w."id" ASC
     LIMIT 1;

    IF FOUND AND (NEW."sampleEpoch", NEW."seedFingerprint", NEW."sampledUnitIds")
                 IS DISTINCT FROM (v_epoch, v_seed, v_ids) THEN
        RAISE EXCEPTION
            'AUDIT_WORKPAPER_SAMPLE_NOT_BINDING: workpaper % already fixed the sample for % %; '
            'a later run reuses it.',
            v_first_id, NEW."procedureId", NEW."periodLabel";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_workpaper_insert_guard_trg ON "AuditWorkpaper";
CREATE TRIGGER audit_workpaper_insert_guard_trg
    BEFORE INSERT ON "AuditWorkpaper"
    FOR EACH ROW EXECUTE FUNCTION audit_workpaper_insert_guard();

-- ─── 6) The one-way record ──────────────────────────────────────────
--
-- Every column but the stamp is frozen at insert, and the stamp moves once,
-- from unset to set. Refused for every role, the table owner included: the
-- grant below is the everyday control and this covers the privileged paths
-- (a script, a migration, a superuser session) the grant never would. The
-- shape mirrors `agent_proposal_approval_immutable`.

CREATE OR REPLACE FUNCTION audit_workpaper_one_way()
RETURNS TRIGGER AS $$
BEGIN
    IF ROW(NEW."id", NEW."tenantId", NEW."procedureId", NEW."catalogueVersion",
           NEW."periodLabel", NEW."populationDefinition", NEW."populationCount",
           NEW."populationDigest", NEW."sampleEpoch", NEW."seedFingerprint",
           NEW."sampleSize", NEW."sampledUnitIds", NEW."parametersJson",
           NEW."attributesTested", NEW."itemOutcomesJson", NEW."exceptionsJson",
           NEW."exceptionCount", NEW."conclusion", NEW."conclusionBasis",
           NEW."evidenceRefs", NEW."proposalIds", NEW."auditorAgentId",
           NEW."controlTestRunId", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."procedureId", OLD."catalogueVersion",
           OLD."periodLabel", OLD."populationDefinition", OLD."populationCount",
           OLD."populationDigest", OLD."sampleEpoch", OLD."seedFingerprint",
           OLD."sampleSize", OLD."sampledUnitIds", OLD."parametersJson",
           OLD."attributesTested", OLD."itemOutcomesJson", OLD."exceptionsJson",
           OLD."exceptionCount", OLD."conclusion", OLD."conclusionBasis",
           OLD."evidenceRefs", OLD."proposalIds", OLD."auditorAgentId",
           OLD."controlTestRunId", OLD."createdAt")
    THEN
        RAISE EXCEPTION
            'IMMUTABLE_AUDIT_WORKPAPER: a workpaper is a one-way record; only its review '
            'stamp may be set, once.';
    END IF;

    IF OLD."reviewedAt" IS NOT NULL
       AND (NEW."reviewedAt", NEW."reviewedByUserId")
           IS DISTINCT FROM (OLD."reviewedAt", OLD."reviewedByUserId") THEN
        RAISE EXCEPTION
            'IMMUTABLE_AUDIT_WORKPAPER_REVIEW: workpaper % was stamped reviewed at %; the '
            'stamp is set once and never changed or removed.',
            OLD."id", OLD."reviewedAt";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_workpaper_one_way_trg ON "AuditWorkpaper";
CREATE TRIGGER audit_workpaper_one_way_trg
    BEFORE UPDATE ON "AuditWorkpaper"
    FOR EACH ROW EXECUTE FUNCTION audit_workpaper_one_way();

-- ─── 7) The finding links ───────────────────────────────────────────

CREATE TABLE "AuditWorkpaperFinding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workpaperId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditWorkpaperFinding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditWorkpaperFinding_tenantId_workpaperId_idx" ON "AuditWorkpaperFinding"("tenantId", "workpaperId");
CREATE INDEX "AuditWorkpaperFinding_tenantId_findingId_idx" ON "AuditWorkpaperFinding"("tenantId", "findingId");
CREATE UNIQUE INDEX "AuditWorkpaperFinding_workpaperId_findingId_key" ON "AuditWorkpaperFinding"("workpaperId", "findingId");

ALTER TABLE "AuditWorkpaperFinding" ADD CONSTRAINT "AuditWorkpaperFinding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditWorkpaperFinding" ADD CONSTRAINT "AuditWorkpaperFinding_workpaperId_tenantId_fkey" FOREIGN KEY ("workpaperId", "tenantId") REFERENCES "AuditWorkpaper"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- `findingId` carries NO foreign key, for the reason `auditorAgentId` does not.
-- This table is retained by the tenant purge and "Finding" is deleted by it
-- (and by the 90-day purge of a soft-deleted finding): a CASCADE key would take
-- the record that a workpaper raised the finding with the finding, and a NO
-- ACTION one would fail the purge. The insert guard below binds it instead.
CREATE OR REPLACE FUNCTION audit_workpaper_finding_insert_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "Finding" f
         WHERE f."id" = NEW."findingId" AND f."tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION
            'AUDIT_WORKPAPER_FINDING_NOT_IN_TENANT: finding % is not a finding of tenant %.',
            NEW."findingId", NEW."tenantId";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_workpaper_finding_insert_guard_trg ON "AuditWorkpaperFinding";
CREATE TRIGGER audit_workpaper_finding_insert_guard_trg
    BEFORE INSERT ON "AuditWorkpaperFinding"
    FOR EACH ROW EXECUTE FUNCTION audit_workpaper_finding_insert_guard();

CREATE OR REPLACE FUNCTION audit_workpaper_finding_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'IMMUTABLE_AUDIT_WORKPAPER_FINDING: a workpaper''s finding link is insert-only.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_workpaper_finding_immutable_trg ON "AuditWorkpaperFinding";
CREATE TRIGGER audit_workpaper_finding_immutable_trg
    BEFORE UPDATE ON "AuditWorkpaperFinding"
    FOR EACH ROW EXECUTE FUNCTION audit_workpaper_finding_immutable();

-- ─── 8) Privileges + RLS ────────────────────────────────────────────
--
-- `app_user` may read, insert and (for the stamp) update a workpaper, and may
-- only read and insert a link. It deletes neither: a workpaper leaves with its
-- tenant, and a link with its workpaper or its finding. A tenant purge runs
-- privileged and a referential CASCADE runs as the table owner, so neither is
-- affected. Default privileges grant DELETE to `app_user` (20260323180000), so
-- it is revoked explicitly, as 20261018080000 does for PeerAgent.

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "AuditWorkpaper" TO app_user;
        REVOKE DELETE ON "AuditWorkpaper" FROM app_user;
        GRANT SELECT, INSERT ON "AuditWorkpaperFinding" TO app_user;
        REVOKE UPDATE, DELETE ON "AuditWorkpaperFinding" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "AuditWorkpaper" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditWorkpaper" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditWorkpaper";
CREATE POLICY tenant_isolation ON "AuditWorkpaper"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditWorkpaper";
CREATE POLICY tenant_isolation_insert ON "AuditWorkpaper"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AuditWorkpaper";
CREATE POLICY superuser_bypass ON "AuditWorkpaper"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "AuditWorkpaperFinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditWorkpaperFinding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditWorkpaperFinding";
CREATE POLICY tenant_isolation ON "AuditWorkpaperFinding"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditWorkpaperFinding";
CREATE POLICY tenant_isolation_insert ON "AuditWorkpaperFinding"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AuditWorkpaperFinding";
CREATE POLICY superuser_bypass ON "AuditWorkpaperFinding"
    USING (current_setting('role') != 'app_user');
