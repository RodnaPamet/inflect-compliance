-- RegisteredAgent.vendorId: single-column FK -> composite, tenant-carrying FK.
--
-- ─── Why ────────────────────────────────────────────────────────────
--
-- Postgres runs foreign-key checks AS THE TABLE OWNER, which bypasses row-level
-- security. RLS does not constrain what a FK will accept. So a single-column
-- `vendorId -> Vendor(id)` makes a cross-tenant reference REPRESENTABLE at the
-- database, however carefully the application filters.
--
-- `RegisteredAgent` already knew this on its other tenant-scoped FK — the
-- sibling `aiSystem` is composite for exactly this reason, and 1/10 resolves
-- `agentId` on API-key creation with an explicit tenant-scoped findFirst rather
-- than trusting a plain FK. `vendor` was the odd one out: defended only by
-- `assertVendorInTenant` in usecases/agent-registry.ts. That check is real and
-- covers today's write paths, so this closes a HARDENING gap, not a known
-- exploitable bug — one layer where the sibling column has two, against an
-- isolation model CLAUDE.md states is deliberately two load-bearing layers.
--
-- ─── onDelete: SET NULL -> RESTRICT, and why it is forced ───────────
--
-- Not a preference. A composite FK's SET NULL nulls EVERY referencing column,
-- and `tenantId` is NOT NULL — so SET NULL is unusable here the moment the FK
-- carries the tenant. RESTRICT is what the sibling `aiSystem` uses.
--
-- The behavioural change is nil in practice: `Vendor` is in SOFT_DELETE_MODELS,
-- so `delete`/`deleteMany` are rewritten by the soft-delete extension into an
-- `update` setting `deletedAt` (src/lib/soft-delete.ts) — the application never
-- issues a hard DELETE against this table. RESTRICT therefore binds only raw
-- SQL and direct database access, where refusing is the correct answer.
--
-- It also REPLACES a worse refusal. Under SET NULL a hard delete of a vendor
-- referenced by a THIRD_PARTY agent already failed — but via the
-- `provenance <> 'THIRD_PARTY' OR vendorId IS NOT NULL` CHECK, i.e. as a
-- confusing constraint violation naming the wrong column. RESTRICT fails at the
-- FK, naming the actual relationship. For a non-THIRD_PARTY agent holding a
-- vendorId, SET NULL used to succeed and silently unlink; that now refuses too,
-- which is the intended reading of "this vendor is still referenced".
--
-- ─── Safety ─────────────────────────────────────────────────────────
--
-- Verified against production before writing this: 1 RegisteredAgent, 0 with a
-- vendorId, 0 cross-tenant pairs, 0 dangling vendorIds. The pre-check matters
-- because the ALTER is where an existing violation would surface, and the guard
-- below turns that from an opaque FK error into a named one.
--
-- Rollback: this migration is additive-plus-swap and reversible by restoring the
-- single-column constraint, but this repo forward-fixes rather than reverting
-- (docs/change-management-policy.md).

-- Refuse loudly rather than failing on the ALTER with a generic FK message.
DO $$
DECLARE offending INTEGER;
BEGIN
    SELECT count(*) INTO offending
    FROM "RegisteredAgent" a
    JOIN "Vendor" v ON v.id = a."vendorId"
    WHERE a."tenantId" <> v."tenantId";

    IF offending > 0 THEN
        RAISE EXCEPTION
            'Cannot add composite FK: % RegisteredAgent row(s) reference a Vendor in another tenant. '
            'Resolve these before migrating — they are exactly the rows this constraint exists to prevent.',
            offending;
    END IF;
END $$;

-- The target of the composite FK. Required: Vendor had no (id, tenantId) unique,
-- so there was previously nothing for a tenant-carrying FK to reference.
CREATE UNIQUE INDEX "Vendor_id_tenantId_key" ON "Vendor"("id", "tenantId");

ALTER TABLE "RegisteredAgent"
    DROP CONSTRAINT "RegisteredAgent_vendorId_fkey";

-- MATCH SIMPLE (the default) means the constraint is not enforced when ANY
-- referencing column is NULL — so a nullable `vendorId` still behaves as
-- optional, while a populated one must match id AND tenantId together.
ALTER TABLE "RegisteredAgent"
    ADD CONSTRAINT "RegisteredAgent_vendorId_tenantId_fkey"
    FOREIGN KEY ("vendorId", "tenantId") REFERENCES "Vendor"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
