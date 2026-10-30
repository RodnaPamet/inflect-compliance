-- #4535 (owner decision 2026-10-30): findings gain their own permission keys,
-- and an API key now needs `findings:read` / `findings:write` to reach the
-- findings routes. Every key that exists keeps EXACTLY the findings access it
-- had: until now the routes checked only the coarse tier that a key's scopes
-- imply (`keyAuthorityFromScopes` in src/lib/auth/api-key-auth.ts):
--
--   * every key resolves to at least READER, so every key could READ
--     findings  -> `findings:read`;
--   * a key with a scope ending `:write` or `:*` resolves to EDITOR or
--     above, so it could CREATE and EDIT them  -> `findings:write`;
--   * a `*` key resolves to ADMIN's permission set, which now holds every
--     findings key, so it is left alone.
--
-- Revoked keys are skipped: they authenticate nothing. A key whose scopes are
-- not a JSON array is skipped too: `validateScopes` never wrote one, and the
-- reader treats it as granting nothing.
--
-- Idempotent: each statement adds a scope only where it is absent.
-- The only trigger on the table fires on `UPDATE OF "agentId"`, which these
-- statements do not touch.

UPDATE "TenantApiKey"
   SET "scopes" = "scopes" || '["findings:read"]'::jsonb
 WHERE "revokedAt" IS NULL
   AND jsonb_typeof("scopes") = 'array'
   AND NOT ("scopes" ? '*')
   AND NOT ("scopes" ? 'findings:read');

UPDATE "TenantApiKey"
   SET "scopes" = "scopes" || '["findings:write"]'::jsonb
 WHERE "revokedAt" IS NULL
   AND jsonb_typeof("scopes") = 'array'
   AND NOT ("scopes" ? '*')
   AND NOT ("scopes" ? 'findings:write')
   AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text("scopes") AS s(scope)
        WHERE s.scope LIKE '%:write' OR s.scope LIKE '%:*'
   );
