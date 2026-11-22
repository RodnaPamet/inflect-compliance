-- #5409 step 1: every live key that reaches the findings MCP tools today keeps
-- reaching them once step 2 moves those tools to the findings domain.
--
-- `list_findings` and `propose_finding` still check the AUDITS domain on
-- `/api/mcp`: a resource scope of `audits:read` (which `audits:read`,
-- `audits:*` and `*` satisfy, `enforceApiKeyScope` in
-- src/lib/auth/api-key-auth.ts), and for `list_findings` the key's own
-- `audits.view` (which the same three grant, `scopesToPermissions`). Step 2
-- moves both to `findings:read` / `findings.view`. #4535's one-time migration
-- (20261030120000_findings_scopes_for_existing_api_keys) gave `findings:read`
-- to every key that existed on 2026-10-30, but an agent key the connect wizard
-- has minted since for these tools (`MCP_TOOL_KEY_SCOPE`) holds `audits:read`
-- and not `findings:read`. Without this, step 2 refuses those keys the tools
-- they were minted for.
--
-- So: append `findings:read` to every key holding `audits:read` or
-- `audits:*`, the same rule #4535 applied to findings reads — what the audits
-- read gave for findings, and nothing more. No `findings:write`: neither tool's
-- key check needs it, and #4535 already settled writes for the keys of its day.
--
-- Skipped, as #4535 skipped them: revoked keys (they authenticate nothing), a
-- `*` key (it already holds `findings.view`), and a key whose scopes are not a
-- JSON array (`validateScopes` never wrote one; the reader grants it nothing).
-- Also skipped: a key that already reaches findings reads (`findings:read` or
-- `findings:*`), so the statement adds a scope only where it changes access and
-- a second run updates no row.
--
-- The only trigger on the table fires on `UPDATE OF "agentId"`, which this
-- statement does not touch. `updatedAt` is left alone, as #4535 left it: it is
-- Prisma-managed and nothing reads it for a key.

UPDATE "TenantApiKey"
   SET "scopes" = "scopes" || '["findings:read"]'::jsonb
 WHERE "revokedAt" IS NULL
   AND jsonb_typeof("scopes") = 'array'
   AND NOT ("scopes" ? '*')
   AND ("scopes" ? 'audits:read' OR "scopes" ? 'audits:*')
   AND NOT ("scopes" ? 'findings:read')
   AND NOT ("scopes" ? 'findings:*');
