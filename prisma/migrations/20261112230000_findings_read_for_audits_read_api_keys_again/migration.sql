-- #5409 step 2: the step-1 backfill again, in the deploy that moves the
-- findings MCP tools to the findings domain.
--
-- This deploy moves `list_findings` and `propose_finding` off the AUDITS domain:
-- both tools' resource scope becomes `findings:read` (was `audits:read`), and
-- `list_findings` asks the key's own `findings.view` (was `audits.view`). The
-- connect wizard mints keys from `MCP_TOOL_KEY_SCOPE`, which moves with them.
--
-- Step 1 (20261112180000_findings_read_for_audits_read_api_keys) appended
-- `findings:read` to every live key holding `audits:read` or `audits:*` when it
-- ran. But until THIS deploy the wizard went on minting keys for these two
-- tools with `audits:read` and not `findings:read`, so a key minted between the
-- two deploys would be refused the tools it was minted for the moment the new
-- code serves it. Running the same statement here, before the new containers
-- start, closes that window. Once this deploy is live the wizard mints
-- `findings:read`, so no third run is needed.
--
-- The statement is byte-for-byte step 1's, so its rules are step 1's: append
-- `findings:read` (never `findings:write`) to an unrevoked key whose scopes are
-- a JSON array holding `audits:read` or `audits:*`; skip a `*` key, a key that
-- already holds `findings:read` or `findings:*`, a revoked key and a non-array
-- blob. It is idempotent: every key step 1 changed already holds
-- `findings:read` and is skipped, and a second run updates no row.
--
-- One consequence to know: a key somebody minted with `audits:read` for the
-- audits REST routes after step 1, with no intent to read findings, gains
-- `findings:read` here, exactly as such keys did under step 1 and #4535. That is
-- what `audits:read` gave for findings before #4535 split the domain, so no key
-- reads more than it could before that split.
--
-- The only trigger on the table fires on `UPDATE OF "agentId"`, which this
-- statement does not touch. `updatedAt` is left alone, as step 1 and #4535 left
-- it: it is Prisma-managed and nothing reads it for a key.

UPDATE "TenantApiKey"
   SET "scopes" = "scopes" || '["findings:read"]'::jsonb
 WHERE "revokedAt" IS NULL
   AND jsonb_typeof("scopes") = 'array'
   AND NOT ("scopes" ? '*')
   AND ("scopes" ? 'audits:read' OR "scopes" ? 'audits:*')
   AND NOT ("scopes" ? 'findings:read')
   AND NOT ("scopes" ? 'findings:*');
