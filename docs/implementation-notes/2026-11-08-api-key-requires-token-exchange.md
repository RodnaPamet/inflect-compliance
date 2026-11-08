# 2026-11-08 — An API key that may reach MCP tools only through an exchanged token

**Commit:** _(this change)_ — #5004 part A, the first step of hardening the
estate scanner to H3 (#3665).

## Design

`H2.audience_tokens` asks whether an agent reaches its tools on audience-scoped
tokens. Until now the honest answer for every agent was "it may, and nothing
makes it". `POST /api/mcp/token` has exchanged an `iflk_` key for an `ifxt_`
token naming the tools it may call since 2026-09-05, but the long-lived key
itself was still accepted at `/api/mcp`. No register fact can show the criterion
met while the key alone also works.

So a key now carries `TenantApiKey.requiresTokenExchange`:

```
iflk_ at /api/mcp      verifyMcpCredential → per-key budget → completeMcpAuthentication
                                                              └─ audience null AND flag → 403 + AUTHZ_DENIED
ifxt_ at /api/mcp      … same path, audience = the token's tools → admitted
iflk_ at /api/mcp/token  exchangeMcpToken → token minted (the flag is what makes this the way in)
iflk_ at REST routes     unchanged (the flag narrows the MCP endpoint only)
iflk_ starting a run     startWorkflowRun → 403 + AUTHZ_DENIED, before the row exists
```

- **Set at creation, never changed.** The key form offers it only while an MCP
  scope is chosen, and `createApiKey` refuses it on a key that cannot reach the
  endpoint (400). There is no update verb: moving a key is re-issuing it, which
  is also what an operator does to hand the scanner a new key.
- **Refused after the per-key budget is charged**, in
  `completeMcpAuthentication`, before the registration gate and the invocation.
  A holder repeating the refusal spends its own budget and cannot write denial
  rows for free; and building the invocation sends a live `tools/list` to every
  external connection the agent is granted, which a refused request must not do.
- **One hash-chained `AUTHZ_DENIED` row per refusal**, gate
  `token_exchange_required`, reason `TOKEN_EXCHANGE_REQUIRED`, best-effort as
  the gate's other denials are. The 403 names the remedy.
- **A flagged key starts no agent run.** The workflow engine enters the same
  tool funnel through `resolveMcpInvocation` with no audience, because a run
  cannot be started with an exchanged token. Without this refusal the engine
  would be the way around the requirement. It is asked in `startWorkflowRun`
  under `enforceMcpCapability(ctx, 'orchestrate')`; that is the only creator of
  a `WorkflowRun` row, so no run exists for the worker to resume.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/auth.prisma`, migration `20261108230000_api_key_requires_token_exchange` | The column, `NOT NULL DEFAULT false` |
| `src/lib/auth/api-key-auth.ts` | Carries the flag onto the key's context |
| `src/app-layer/types.ts` | `RequestContext.apiKeyRequiresTokenExchange` |
| `src/lib/mcp/auth.ts` | The refusal at `/api/mcp` and `assertRunStartNotByExchangeOnlyKey` |
| `src/app-layer/usecases/workflow-runs.ts` | Asks it at run start |
| `src/app-layer/usecases/api-keys.ts`, the api-keys route and page | Creation, the checkbox, the list tag |

## Decisions

- **The flag is a column, not a scope.** A scope widens what a key may do, and
  the wildcards would have to be taught to exclude it. This narrows, and it
  narrows one endpoint only, so it is its own field read at one place.
- **The REST ingest stays on the raw key.** The scanner posts its report to
  `/api/t/:slug/admin/agents/harness-scans` with the same key; that route has no
  audience to scope. The requirement is about the MCP endpoint, which is what
  the criterion asks.
- **The register read is not changed here.** The deployed scanner parses
  `get_harness_register` strictly, and a built-in tool's manifest is pinned, so
  the flag reaches the scanner through a new read in part B rather than a new
  member of the old one.
- **Rollback:** the column defaults to false and nothing writes true without an
  operator ticking the box, so reverting the code leaves every key behaving as
  before. The column can stay; dropping it is a later forward migration.
