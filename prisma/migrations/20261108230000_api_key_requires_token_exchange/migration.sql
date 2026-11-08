-- #5004: an API key may be limited to reaching `/api/mcp` through an
-- audience-scoped token exchanged for it, never presented directly. It is the
-- fact the harness criterion `H2.audience_tokens` reads.
--
-- A constant default is a metadata-only change in PostgreSQL 11+: no table
-- rewrite, and every existing key reads `false`, which is what it was.
ALTER TABLE "TenantApiKey" ADD COLUMN "requiresTokenExchange" BOOLEAN NOT NULL DEFAULT false;
