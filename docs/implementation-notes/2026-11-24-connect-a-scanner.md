# 2026-11-24 — Connect a scanner: one panel, one key

## Design

Setting up scanent against Inflect took five steps on three pages: register the
scanner's agent, register its public key, create up to three API keys with one
scope each, grant `get_harness_register`, and write the `inflect` block and key
variables into scanent's files. A wrong scope failed quietly: that report was
simply not posted.

**Connect a scanner** is a sheet on the Harness matrix tab's Scanner keys card.
It picks the scanner's registered agent, registers its public key, takes ticks
for the reports it posts (agent, integrations, agent surface) and for reading the
register, and creates ONE key carrying every ticked report's ingest scope. It
then prints the `scanent.env` lines (one variable per report, each to hold the
same key) and the block to merge into `config.json`.

It calls three existing routes, in order, and adds none: the scanner-key
register, the tool grant (only when the register is read and the tool is not
granted), and the api-keys route. A failure stops the steps after it with the
server's sentence; a step that already holds is skipped.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/scanner-connect.ts` | Pure, client-safe: scopes, exchange flag, variables, env lines, config block, why an agent cannot be connected |
| `src/app/t/[tenantSlug]/(app)/agents/reports/harness/ConnectScannerSheet.tsx` | The panel |
| `src/app/t/[tenantSlug]/(app)/agents/reports/harness/ScannerKeysCard.tsx` | The button |
| `src/app-layer/usecases/agent-harness-matrix.ts`, `src/lib/agentic/harness-read-model.ts` | Candidates carry status, classification and scoring; the view carries the viewer's two flags |
| `messages/en.json`, `messages/bg.json` | `agents.harness.connect.*` |
| `docs/user/how-to/set-up/connect-a-scanner.md` | The help page |

## Decisions

- **One key per scanner, carrying several ingest scopes** (owner decision). Each
  ingest already asked only for its own permission and `createApiKey` refuses no
  combination, so nothing server-side changed. The trade-off is least
  privilege: a leaked scanner key now posts every report it names, not one.
  The owner chose fewer keys to handle; the key is still bound to one agent,
  works only while that agent is ACTIVE, and a report is accepted only when a
  registered signing key of that same agent signed it.
- **One variable per report, the same key in each.** scanent 0.17.0 refuses one
  variable NAME for two reports and never compares values, so naming its default
  variables works with every released scanner and needs no scanent release.
- **The register read is `mcp:read` plus `requiresTokenExchange`.** scanent
  always exchanges its key for a token naming `get_harness_register`, so the
  key need never be presentable at `/api/mcp` directly. Reading the register
  brings `admin:harness_ingest`, the tool's resource scope.
- **An agent that is not ACTIVE is explained, never activated.** The candidate
  carries `aiSystemClassified` and `riskScored`, read on the server, and the
  panel names the first thing activation will ask for in `assertActivatable`'s
  order, with a link to the agent.
- **Flags come from the server.** `canMintKeys` is `admin.manage` and the
  role-tier admin check `createApiKey` asserts; `canGrantTools` is
  `admin.agent_tool_exposure`. An AI_ADMIN sees who can do it instead of a form.
