-- M5 (#3872) — the tenant's acknowledgement that data read over a connection
-- marked `reachesBusinessSystem` may be routed to `inflect-external`.
--
-- ADDITIVE AND NULLABLE, so it is safe under a rolling deploy: a still-running
-- old container neither reads nor writes these columns, and nothing it does read
-- changes shape. No enum is altered and no index is dropped — the hazard the
-- `@@map("WorkItem*")` pins and the retired `PROPOSE` rung record is an
-- `ALTER TYPE`, and there is none here.
--
-- NOT BACKFILLED, deliberately. Every existing tenant starts unacknowledged,
-- which REFUSES such a run, and that is the state the gate exists to produce: a
-- transfer nobody has accepted is one that does not happen. Backfilling a
-- timestamp would be this migration asserting, on behalf of every tenant, a
-- consent none of them gave.
--
-- No FOREIGN KEY on the user id. `SET NULL` would make an employee's deletion
-- withdraw the tenant's consent, and a company's decision does not lapse because
-- the person who recorded it left; `RESTRICT` would block a GDPR erasure. The
-- hash-chained audit row preserves who it was. This follows the table's own
-- precedent — `recertificationOwnerUserId` carries no FK either.
ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN "externalAiBusinessDataAckAt" TIMESTAMP(3),
    ADD COLUMN "externalAiBusinessDataAckByUserId" TEXT;

-- Both or neither. An acknowledgement nobody can attribute is not an
-- acknowledgement, and the gate reads both; this makes the half-set state
-- unrepresentable rather than merely unwritten by the one usecase that writes
-- it, so a raw UPDATE cannot produce an anonymous consent either.
ALTER TABLE "TenantSecuritySettings"
    ADD CONSTRAINT "TenantSecuritySettings_external_ai_ack_attributed"
    CHECK (
        ("externalAiBusinessDataAckAt" IS NULL AND "externalAiBusinessDataAckByUserId" IS NULL)
        OR ("externalAiBusinessDataAckAt" IS NOT NULL AND "externalAiBusinessDataAckByUserId" IS NOT NULL)
    );
