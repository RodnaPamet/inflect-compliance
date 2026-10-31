-- Owner decision, 2026-10-30 (#4568): the sandbox id is persisted for the
-- EXECUTION'S LIFETIME ONLY. A kill reaches the sandboxes of currently-running
-- work and nothing else.
--
-- WHY A LEASE AND NOT A COLUMN. The kill switch's problem was that it had no
-- subjects: `grep -rn "sandboxId" prisma/schema.prisma` returned nothing, so
-- "delete the sandboxes of any agent that runs in one" enumerated an empty set
-- and the drill's sandbox arm reported `not_exercised_unreachable`.
--
-- A column on an execution row would have needed one shape for every kind of
-- execution, and the only caller today is a posture collection rather than an
-- agent run. A LEASE TABLE instead: the row exists exactly while the sandbox
-- does, opened when the gateway confirms a create and deleted when a delete
-- SETTLES. Nothing accumulates, so the kill switch cannot enumerate ghosts —
-- which was the argument against persisting ids durably per agent.
--
-- WHAT IS DELIBERATELY ABSENT.
--   - No agent foreign key. The owner of a sandbox today is a collection, not a
--     registered agent, and inventing an attribution would make an AGENT-scoped
--     kill appear to cover sandboxes it cannot.
--   - No `closedAt`. A closed lease is a DELETED row, not a row with a
--     timestamp: a table that kept them would grow without bound and would let
--     a stale read hand the kill switch a sandbox that is already gone.
--   - No secret. `providerName` is the gateway-side credential's NAME, which is
--     the property `attachProvider` holds at the transport boundary.
--
-- UNIQUE ON sandboxId, because the gateway's id is unique. A second create for
-- one id is a bug and should fail loudly rather than produce two leases.

CREATE TABLE "OpenShellSandboxLease" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "ownerJob" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenShellSandboxLease_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OpenShellSandboxLease_sandboxId_key"
    ON "OpenShellSandboxLease"("sandboxId");

-- The kill switch's read: every live sandbox of one tenant, oldest first so a
-- leak is visible at the top.
CREATE INDEX "OpenShellSandboxLease_tenantId_openedAt_idx"
    ON "OpenShellSandboxLease"("tenantId", "openedAt");

ALTER TABLE "OpenShellSandboxLease"
    ADD CONSTRAINT "OpenShellSandboxLease_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
