# 2026-11-12 — The findings MCP tools check the findings scope (#5409, step 2)

**Commit:** `fix(mcp): findings tools check the findings scope (#5409)`

## Design

#4535 gave findings their own permission domain (`findings.view/create/edit`)
and API-key scopes (`findings:read`/`findings:write`). The two MCP tools over
findings stayed on the audits domain: `list_findings` checked the resource
scope `audits:read` and, with `basis: 'effective'`, the key's own `audits.view`;
`propose_finding` checked `audits:read` (its principal key moved to
`findings.create` in #5393). So a key holding `audits:read` and no findings
scope could list findings, and a principal whose custom role refused
`findings.view` but kept `audits.view` could read findings through MCP that
`GET /findings` refuses them.

The move is two deploys, because the connect wizard mints agent keys from
`MCP_TOOL_KEY_SCOPE`, and the keys it minted for these tools carry
`audits:read` only:

1. **Step 1 (#5425, live).** `20261112180000_findings_read_for_audits_read_api_keys`
   appended `findings:read` to every live array-scoped non-`*` key holding
   `audits:read` or `audits:*`.
2. **Step 2 (this change).**
   - `list_findings`: resource scope `findings:read`; `authorize.keys`
     `['findings.view']`, still `basis: 'effective'` and `policy: 'read'`
     (the route takes `findings.view`; `listFindings` still asserts the coarse
     read). `mirrors` names the route's real gate.
   - `propose_finding`: resource scope `findings:read`. `authorize` unchanged
     (`findings.create`, `basis: 'principal'`).
   - `MCP_TOOL_KEY_SCOPE`: both tools `findings:read`, so the wizard mints the
     scope the tools check.
   - `20261112230000_findings_read_for_audits_read_api_keys_again`: step 1's
     statement, byte for byte, run again. Between the two deploys the wizard
     kept minting `audits:read` keys for these tools; this run, applied before
     the new containers serve, gives them `findings:read`. After this deploy
     the wizard mints `findings:read`, so no third run is needed.

## Files

| File | Role |
| --- | --- |
| `src/lib/mcp/tools/work-tools.ts` | `list_findings` scope and key move to findings |
| `src/lib/mcp/tools/propose-tools.ts` | `propose_finding` resource scope moves to `findings:read` |
| `src/lib/mcp/tool-catalogue.ts` | the wizard's copy of both scopes |
| `src/lib/mcp/tools/types.ts` | `policy` docstring no longer says findings have no keys |
| `prisma/migrations/20261112230000_findings_read_for_audits_read_api_keys_again/` | the backfill again |
| `tests/integration/mcp-read-suite.test.ts` | a `findings:read` key lists findings; an `audits:read` key is refused and not offered the tool |
| `tests/integration/findings-read-for-audits-read-keys-migration.test.ts` | the re-run is step 1's statement, migrates a key minted after step 1, moves nothing else |
| `tests/integration/{mcp-denial-audits,agent-risk-tier-gates,agent-widening-reassessment}.test.ts`, `tests/unit/agentic/connect-wizard.test.ts` | fixtures and expectations seed `findings:read` |

## Decisions

- **`propose_finding` keeps a READ scope.** Every propose tool's resource scope
  is the domain read (`McpAuthorizationBasis` docs; `processes:read` in
  `api-key-auth.ts`): a propose key must never carry `<domain>:write`, which
  would let it create findings over REST. `findings:read` is also the only
  scope step 1 granted, so it is the only non-breaking choice.
- **`basis: 'effective'` is kept for `list_findings`.** It is a read tool: the
  principal and the key must both hold `findings.view`. Every key the wizard
  minted for it now holds `findings:read`, which grants that.
- **The re-run migration is a copy, not a reference.** Prisma runs each
  directory once, so step 1 cannot run again. The test asserts the two
  statements are identical, so step 1's test covers the rules of both.
- **Tool pins are unaffected.** `hashToolManifest` covers name, description,
  input schema and annotations. This change touches only `resourceScope` and
  `authorize`, so no pinned server is quarantined.
- **One behaviour change for principals is intended.** A custom role that
  refuses `findings.view` but holds `audits.view` used to read findings through
  `list_findings`. It is now refused, as it is by `GET /findings`.
