-- #2657 — a failed audit write must never be silent.
--
-- An AUTHZ_DENIED audit write was wrapped in a catch that logged a warning
-- and let the request proceed. The denial still happened, the user was still
-- refused, and the evidence that we refused them was gone. This table is the
-- durable half of the fix: a caller that cannot reach the hash chain writes
-- here instead, and a drain replays it onto the chain out-of-band.
--
-- WHY A SECOND TABLE RATHER THAN A RETRY IN MEMORY. The write has to be
-- durable BEFORE the response, because that is the property an in-memory
-- retry cannot provide — a process that dies between the failed append and
-- the retry loses the event with no trace. Chosen over a separate append-only
-- audit store, which would create a second source of audit truth to reconcile
-- against the hash chain.
--
-- WHY THIS INSERT SUCCEEDS WHEN THE APPEND DID NOT. `appendAuditEntry` takes
-- a per-tenant pg_advisory_xact_lock INSIDE its transaction, so concurrent
-- appends for one tenant serialise and the last of them can fail to START
-- within Prisma's maxWait (#2653). This insert takes no advisory lock and
-- contends with nothing, so it is not the same failure mode retried — it is a
-- different one. If BOTH fail the caller fails closed, which is the database
-- being down rather than the trail being busy.
--
-- ROLLING-DEPLOY SAFETY. Purely additive: a new enum type, a new table, new
-- indexes, and one new foreign key onto an existing table. Nothing is renamed
-- and nothing is dropped, so a container that has never heard of any of this
-- keeps reading and writing exactly as before.

-- CreateEnum
--
-- Member order matches prisma/schema/enums.prisma exactly (PENDING, APPLIED,
-- FAILED), which is what tests/guardrails/enum-member-order-matches-migrations.test.ts
-- compares. APPLIED rather than SENT: the terminal success state is that the
-- entry reached the hash chain.
CREATE TYPE "AuditOutboxStatus" AS ENUM ('PENDING', 'APPLIED', 'FAILED');

-- CreateTable
CREATE TABLE "AuditOutbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "action" TEXT NOT NULL,
    "status" "AuditOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "appliedAuditId" TEXT,

    CONSTRAINT "AuditOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- The drain's claim predicate is (status, nextAttemptAt), so that index is the
-- one that has to exist for a backlog not to become a sequential scan.
CREATE INDEX "AuditOutbox_status_nextAttemptAt_idx" ON "AuditOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AuditOutbox_tenantId_idx" ON "AuditOutbox"("tenantId");

-- CreateIndex
CREATE INDEX "AuditOutbox_tenantId_status_idx" ON "AuditOutbox"("tenantId", "status");

-- CreateIndex
--
-- Answers "how many AUTHZ_DENIED are stuck for this tenant" without parsing
-- payloadJson, which is why `action` is denormalised out of it.
CREATE INDEX "AuditOutbox_tenantId_action_status_idx" ON "AuditOutbox"("tenantId", "action", "status");

-- AddForeignKey
ALTER TABLE "AuditOutbox" ADD CONSTRAINT "AuditOutbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- NOTE: there is deliberately NO unique dedupeKey, which is the one place this
-- table departs from "NotificationOutbox". Two identical denials a second
-- apart are two real security events. Email dedupes because sending twice is
-- worse than sending once; the audit trail is the opposite, because failing to
-- record one is worse than recording both. A unique key here would silently
-- drop the second — the exact defect this migration exists to remove,
-- reintroduced as a constraint.

-- ═══════════════════════════════════════════════════════════════════
-- Row-Level Security — the canonical trio
-- ═══════════════════════════════════════════════════════════════════
--
-- This table holds tenant-scoped audit payloads, so it needs the same
-- isolation every other tenant table has. Without it `app_user` could
-- read another tenant's QUEUED denials — entries that have not reached
-- the hash chain yet and are therefore not protected by anything else.
--
-- Shape copied from prisma/migrations/20260422180000_enable_rls_coverage,
-- and it is the same posture "NotificationOutbox" carries.
--
-- WHY THE PLATFORM-WIDE DRAIN STILL WORKS. `audit-outbox-flush` reads
-- across every tenant, with no `app.tenant_id` set. That is fine, and
-- for a reason worth stating rather than discovering: the drain runs on
-- the plain prisma client, whose connection never becomes `app_user`
-- (see src/lib/db-context.ts — only runInTenantContext does
-- `SET LOCAL ROLE app_user`), so `superuser_bypass` is true and the rows
-- are visible. `processOutbox` drains "NotificationOutbox" the same way
-- against the same policy set, so this is an established path and not a
-- new assumption.
--
-- If the drain were ever moved under `runInTenantContext`, it would
-- silently drain NOTHING — RLS would hide every row and the pass would
-- report zero applied with no error. That is exactly the silence #2657
-- exists to remove, so it is called out here at the policy that would
-- cause it.

ALTER TABLE "AuditOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditOutbox" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AuditOutbox";
CREATE POLICY tenant_isolation ON "AuditOutbox"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "AuditOutbox";
CREATE POLICY tenant_isolation_insert ON "AuditOutbox"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "AuditOutbox";
CREATE POLICY superuser_bypass ON "AuditOutbox"
    USING (current_setting('role') != 'app_user');
