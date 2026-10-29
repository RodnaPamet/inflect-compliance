# 2026-10-29 — Connect an agent you run (Claude agents 3a)

**Commit:** `feat(agents): connect an agent you run from its page — a bound key and the configuration to paste (Claude agents 3a)`

## Design

A customer who runs their own agent, written on the Agent SDK or built in
Anthropic's Console, connects it from the agent's page with no command line.

```
Agent page ── "Connect an agent you run" ──> ConnectAgentSheet
   │  reads the agent's grants (GET …/admin/agents/:id/tools)
   │  computes the key's scopes (connectKeyScopes)
   ▼
POST /admin/api-keys  (the api-keys route: admin.manage, API_KEY_CREATE_LIMIT)
   │  createApiKey: assertCanAdmin, agent ACTIVE, ceiling ≤ agent level
   ▼
the key, shown once ──> Agent SDK tab (TypeScript, Python)
                    └─> Managed Agent tab (MCP server, vault credential, toolset)
```

Everything the customer copies is built in the browser by the pure
`src/lib/agentic/connect-wizard.ts`. The snippets read the key from
`INFLECT_API_KEY`, so it appears only in the key box. The sheet holds it in
state and the page unmounts the sheet on close.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/connect-wizard.ts` | Pure, client-safe: key scopes from grants, `allowedTools`, the TypeScript and Python options, the Console configuration |
| `src/lib/mcp/tool-catalogue.ts` | `MCP_TOOL_KEY_SCOPE`, a client-safe copy of each tool's resource scope, and `EXTERNAL_TOOL_KEY_SCOPE` |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/ConnectAgentSheet.tsx` | The sheet: explanation or mint form, the key once, the two tabs |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient.tsx`, `page.tsx` | The header action, and `canMintKeys` (`admin.manage` AND `canAdmin`) |
| `messages/en.json`, `messages/bg.json` | `admin.agentDetail.connect.*` |
| `docs/user/how-to/set-up/connect-an-agent-you-run.md` | The help-site how-to |

## Decisions

- **The key carries each granted tool's resource scope, not `mcp:read` alone.**
  The step's prompt said `mcp:read` plus `mcp:propose`. `/api/mcp` also checks
  every tool's `resourceScope` (funnel step 8), so that key would have been
  refused every tool. The owner chose this on 2026-10-29: grant exactly the
  resource scopes the grants need, and close #4481 first, so a stopped agent's
  key also stops at REST, where those scopes reach.
- **External tools need `admin:external_tools`, which the funnel did not
  accept until #4485.** A test that ran every wizard scope through
  `validateScopes` refused the old `external_tools:read`. It was a scope no key
  could carry, so only a `*` key reached any external tool. #4485 fixed it in
  its own pull request.
- **The scope map is a copy, held equal by a test.** A client component cannot
  import the tool registries, which carry server code. The copy sits beside the
  names the catalogue already copies for the same reason, and
  `tests/unit/mcp-tool-key-scopes.test.ts` fails on any drift.
- **The action shows for every reader of the page**, and the sheet explains why
  a person cannot connect: no api-keys permission, the grants unreadable, an
  agent not active, or no grants. A missing button would read as a product
  without the feature.
- **`permissionMode: "dontAsk"`** is the explicit mode in the snippets. A tool
  outside `allowedTools` is refused rather than prompted for, which is right for
  an agent that runs unattended. `tools: []` turns off the built-in tools. The
  how-to tells the customer to add back only the ones the agent needs.
- **The Console toolset defaults every tool off** and turns on each grant. A
  read runs on its own (`always_allow`). A propose asks first (`always_ask`),
  so a person stands in front of the call in the Console as well as in front of
  the proposal in Inflect.
- **The how-to is in `docs/user/how-to/set-up/`, not `docs/user/how-to/`** as
  the prompt named. The help-site manifest lists the how-to folders, not their
  parent, so a file directly under `how-to/` would not be published.
