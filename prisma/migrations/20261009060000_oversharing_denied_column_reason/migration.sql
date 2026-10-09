-- Oversharing, split by severity.
--
-- A server returning a column the `?fields=` projection excluded is now a
-- REFUSAL only when that column is on the never-request denylist; otherwise the
-- transport strips it, the connection is flagged OVERSHARING, and the pull
-- completes. See docs/legacy-access-recertification-design.md section 2 and
-- issue #3319 for why the previous unconditional refusal was wrong: it settled a
-- product question inside the transport, and settled it so that a customer's
-- misconfigured server stopped their recertification entirely.
--
-- Additive and forward-only. A bare `ADD VALUE` appends to the end of the type,
-- which is why the schema declares it last — `enum-member-order-matches-migrations`
-- compares the two. `IF NOT EXISTS` so a re-run is a no-op.

-- AlterEnum
ALTER TYPE "LegacyAccessRefusalReason" ADD VALUE IF NOT EXISTS 'OVERSHARED_DENIED_COLUMN';
