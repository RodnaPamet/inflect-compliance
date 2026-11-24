-- Hosted Managed Agents, behind a constant that is false (Step 6b of
-- docs/claude-managed-agents-design.md, shape MA-C1, #4172).
--
-- Nothing here sends anything anywhere, and nothing here can be reached while
-- the source constant HOSTED_MANAGED_AGENTS_ACTIVE is false
-- (src/lib/agentic/managed-agents/hosted-activation.ts). It prepares four
-- things the hosted path reads:
--
--   1. TenantSecuritySettings."hostedManagedAgentsOptIn": an OWNER's opt-in,
--      default false. One writer (usecases/hosted-managed-agents-opt-in.ts).
--   2. WorkflowRun."hostedManagedAgents": this run took a slot in Inflect's
--      own workspace, default false, with the index the capacity count reads.
--   3. hosted_managed_agents_claim_slot(): the one writer of (2). It counts
--      every hosted run still executing, across every tenant, under one
--      advisory lock, and refuses a run over the per-tenant or the
--      deployment-wide cap. SECURITY DEFINER so the count sees every tenant's
--      rows; it reads and returns counts only, never a row of another tenant.
--   4. ManagedAgentsCleanup: a TENANT_PURGE record of Inflect's OWN workspace
--      (connectionId 'inflect-hosted') may stay OPEN and be retried, and is
--      never PURGED_KEY_DESTROYED_UNFINISHED. Owner decision 7 keeps no
--      CUSTOMER key past a purge; the hosted workspace's key is Inflect's own
--      deployment configuration and is not destroyed by any purge, so the
--      one-attempt rule that follows from destroying the key does not apply.
--
-- ADDITIVE ONLY: two columns with defaults (no rewrite on Postgres 11+), one
-- index, one function, and two CHECKs that ADMIT more than before (every
-- existing row satisfies them: no row names 'inflect-hosted'). Old containers
-- never select the new columns and never call the function, so a rolling
-- deploy is safe in both directions.

-- 1. The opt-in.
ALTER TABLE "TenantSecuritySettings" ADD COLUMN "hostedManagedAgentsOptIn" BOOLEAN NOT NULL DEFAULT false;

-- 2. The slot.
ALTER TABLE "WorkflowRun" ADD COLUMN "hostedManagedAgents" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "WorkflowRun_hostedManagedAgents_status_idx" ON "WorkflowRun"("hostedManagedAgents", "status");

-- 3. The claim.
--
-- Returns one word:
--   CLAIMED         this run now holds a hosted slot (or already did);
--   TENANT_CAP      this tenant already has p_tenant_cap hosted runs executing;
--   DEPLOYMENT_CAP  the deployment already has p_deployment_cap executing;
--   NOT_HELD        the caller does not hold this run's lease, or is not in
--                   this run's tenant: nothing was counted or written.
--
-- "Executing" is the run lease's own definition (#5900): RUNNING, with a
-- holder whose lease has not lapsed on the DATABASE's clock. A run that
-- settles, pauses or releases its lease stops counting by itself, and one
-- whose worker died stops counting when its lease lapses (60 s), so a slot is
-- never leaked and never needs releasing.
--
-- The tenant context must name the run's tenant: the function runs as its
-- owner, so without that check an app_user session could mark another
-- tenant's run. The advisory lock serialises every claim, so two runs can
-- never both see the last free slot.
CREATE OR REPLACE FUNCTION hosted_managed_agents_claim_slot(
    p_tenant_id TEXT,
    p_run_id TEXT,
    p_lease TEXT,
    p_tenant_cap INTEGER,
    p_deployment_cap INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_running     INTEGER;
    v_deployment_running INTEGER;
    v_held               BOOLEAN;
BEGIN
    IF p_tenant_id IS NULL OR p_run_id IS NULL OR p_lease IS NULL
       OR current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant_id THEN
        RETURN 'NOT_HELD';
    END IF;
    IF p_tenant_cap IS NULL OR p_tenant_cap < 1 OR p_deployment_cap IS NULL OR p_deployment_cap < p_tenant_cap THEN
        RAISE EXCEPTION 'HOSTED_CAPACITY_CAPS_INVALID: tenant cap % and deployment cap %', p_tenant_cap, p_deployment_cap;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('hosted-managed-agents-capacity'));

    SELECT EXISTS (
        SELECT 1 FROM "WorkflowRun"
         WHERE "id" = p_run_id AND "tenantId" = p_tenant_id
           AND "status" = 'RUNNING'
           AND "leaseHolder" = p_lease AND "leaseExpiresAt" > now()
    ) INTO v_held;
    IF NOT v_held THEN
        RETURN 'NOT_HELD';
    END IF;

    SELECT count(*) FILTER (WHERE "tenantId" = p_tenant_id), count(*)
      INTO v_tenant_running, v_deployment_running
      FROM "WorkflowRun"
     WHERE "hostedManagedAgents" = true
       AND "status" = 'RUNNING'
       AND "leaseHolder" IS NOT NULL
       AND "leaseExpiresAt" > now()
       AND "id" <> p_run_id;

    IF v_tenant_running >= p_tenant_cap THEN
        RETURN 'TENANT_CAP';
    END IF;
    IF v_deployment_running >= p_deployment_cap THEN
        RETURN 'DEPLOYMENT_CAP';
    END IF;

    UPDATE "WorkflowRun" SET "hostedManagedAgents" = true
     WHERE "id" = p_run_id AND "tenantId" = p_tenant_id AND "leaseHolder" = p_lease;
    RETURN 'CLAIMED';
END;
$$;

REVOKE ALL ON FUNCTION hosted_managed_agents_claim_slot(TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hosted_managed_agents_claim_slot(TEXT, TEXT, TEXT, INTEGER, INTEGER) TO app_user;

-- 4. A purge of Inflect's own workspace is retried; a customer's is not.
ALTER TABLE "ManagedAgentsCleanup" DROP CONSTRAINT "ManagedAgentsCleanup_purge_never_open";
ALTER TABLE "ManagedAgentsCleanup" ADD CONSTRAINT "ManagedAgentsCleanup_purge_never_open" CHECK (
    "trigger" <> 'TENANT_PURGE'
    OR "status" IN ('DONE', 'PURGED_KEY_DESTROYED_UNFINISHED')
    OR ("connectionId" = 'inflect-hosted' AND "status" IN ('OPEN', 'ABANDONED'))
);
-- Inflect's own key is never destroyed by a purge, so its records never say so.
ALTER TABLE "ManagedAgentsCleanup" ADD CONSTRAINT "ManagedAgentsCleanup_hosted_key_never_destroyed" CHECK (
    "connectionId" <> 'inflect-hosted' OR "status" <> 'PURGED_KEY_DESTROYED_UNFINISHED'
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
         WHERE proname = 'hosted_managed_agents_claim_slot'
           AND pronamespace = 'public'::regnamespace
           AND prosecdef
    ) THEN
        RAISE EXCEPTION 'Step 6b: hosted_managed_agents_claim_slot must be SECURITY DEFINER';
    END IF;
END $$;
