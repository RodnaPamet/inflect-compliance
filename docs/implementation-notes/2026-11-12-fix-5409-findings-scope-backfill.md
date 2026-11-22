# 2026-11-12 — `findings:read` for keys that hold `audits:read` (#5409, step 1)

**Commit:** see PR for #5409 (step 1)

## Design

`list_findings` and `propose_finding` still check the audits domain on `/api/mcp`. Both carry a resource scope of `audits:read`, and `list_findings` also asks for the key's own `audits.view` (`basis: 'effective'`). Step 2 of #5409 moves both to `findings:read` / `findings.view`. That move is unsafe on its own. #4535's one-time migration gave `findings:read` to every key that existed on 2026-10-30. Agent keys the connect wizard has minted since, through `MCP_TOOL_KEY_SCOPE`, hold `audits:read` and not `findings:read`, so step 2 would refuse them the tools they were minted for.

This step is one data migration, `20261112180000_findings_read_for_audits_read_api_keys`. It is a single set-based `UPDATE` that appends `findings:read` to every key that:

- is unrevoked;
- has scopes that are a JSON array;
- does not hold `*`;
- holds `audits:read` or `audits:*`;
- does not already hold `findings:read` or `findings:*`.

The integration test runs the migration file itself against a real database. Through the real auth code (`enforceApiKeyScope` and `scopesToPermissions`), it asserts that every live key passing today's findings-tool checks passes step 2's checks afterwards. It also asserts that the key gains `findings.view` and nothing else, that the untouched rows are byte-identical, and that a second run updates no row.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261112180000_findings_read_for_audits_read_api_keys/migration.sql` | The backfill. |
| `tests/integration/findings-read-for-audits-read-keys-migration.test.ts` | Runs the migration file and checks the step-2 property. |

## Decisions

- **`audits:*` is included, not only `audits:read`.** The issue says "keys that hold `audits:read`". The property step 2 needs is "every key that reaches the tools today". Today's resource check (`enforceApiKeyScope(…, 'audits', 'read')`) and effective check (`audits.view`) are both satisfied by `audits:*` as well. A key minted since #4535 with `audits:*` would be refused by step 2 exactly as an `audits:read` key would. A `*` key passes both domains already, and `audits:write` alone reaches neither check, so neither of those is touched.
- **`findings:read` only, never `findings:write`.** Neither tool's key check needs write. `propose_finding` checks the principal for `findings.create`, not the key, since #5393. #4535 already settled write access for the keys of its day. A key minted since then was given write deliberately, or was not given it.
- **Same skips as #4535.** Revoked keys authenticate nothing. A non-array blob grants nothing and `validateScopes` never wrote one. A key that already reaches findings reads is also skipped, so the statement changes only rows whose access it changes, and it is idempotent.
- **Nothing makes `scopes` write-once.** The table's only trigger, `tenant_api_key_agent_not_retired`, is `BEFORE INSERT OR UPDATE OF "agentId"` and does not fire on a scopes-only update. No column stores a hash or fingerprint of the scopes. `updatedAt` is left alone, as #4535 left it: Prisma sets it on ORM writes and nothing reads it for a key.
- **Which keys changed is not recorded.** A precise record would need either a table outside the Prisma schema, which the schema-drift and RLS-coverage guardrails would flag, or a marker inside `scopes`, which `validateScopes` would reject. Neither is worth it for a read-only scope that reproduces access the key already had through the audits domain. A rollback of the application needs no data rollback: `findings:read` has been a valid scope since #4535, and older code reads it. If an exact revert is ever wanted, the pre-deploy backup has the before state. Without the backup, the best available heuristic is "a key created after 2026-10-30 that holds `audits:read`/`audits:*` and ends in `findings:read`". It is close but not exact, because an operator can mint that same shape by hand.
- **One effect beyond MCP.** Since #4535 the REST findings routes (`GET /api/t/:slug/findings`, `GET /findings/{id}`) ask for `findings.view`. A key that gains `findings:read` here can read those routes too. That is the same read it already had through `list_findings`, and it is the rule #4535 applied ("an audits-domain read reached findings"). Write routes are unaffected.
