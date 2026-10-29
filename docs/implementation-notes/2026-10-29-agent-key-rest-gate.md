# 2026-10-29 — An agent-bound key stops at the REST door when its agent is stopped

**Commit:** `<sha> fix(auth): stop an agent-bound API key at /api/t/** while its agent is killed or not active (#4481)`

Fixes #4481. Found while scoping Claude agents 3a (#4155), and fixed first by
owner decision (2026-10-29, option 1 on the issue).

## Design

```
/api/t/** request, Bearer iflk_…
  getTenantCtx / getLegacyCtx
    tryApiKeyAuth
      verifyApiKey            the key, narrowed to its principal (unchanged)
      assertAgentKeyMayActAtRest   NEW, for a key with an agentId
        resolveKillState(tenant, agent)  ─▶ kill in force  ─▶ 403 + AUTHZ_DENIED agent_killed
        registeredAgent.status           ─▶ not ACTIVE     ─▶ 403 + AUTHZ_DENIED agent_not_active
```

The MCP door is unchanged: the funnel reads the same controls per call.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/agent-key-rest-gate.ts` | the gate and its denial row |
| `src/app-layer/context.ts` | `tryApiKeyAuth` calls it |
| `tests/integration/agent-key-rest-gate.test.ts` | a real route, a real key, agent and tenant kills, suspension |
| `tests/unit/agentic/agent-key-rest-gate.test.ts` | an unreadable kill state, an audit store that is down, statuses |
| `tests/integration/agent-registry-enforcement.test.ts` | the engine-path cells now reach the engine past the REST door, and the door has its own cell |

## Decisions

- **At `tryApiKeyAuth`, not in `verifyApiKey`.** `verifyApiKey` serves `/api/mcp`
  too, where the funnel already refuses a killed or suspended agent per call,
  with its own reasons and its own denial row. Refusing there as well would
  move every MCP kill refusal to credential verification and change what that
  door records. `tryApiKeyAuth` is the only REST door: both context builders
  call it.
- **The funnel's kill reader.** `resolveKillState` is the one query for all
  three scopes, so the two doors cannot disagree about which switch counts.
- **ACTIVE is an allowlist.** Draft, suspended, retired, a row the register no
  longer holds, and any status added later all refuse.
- **Fail closed.** A kill state that cannot be read fails the request, rather
  than letting the key through as if no switch were engaged.
- **Grants are still not applied at REST.** That would be a different decision
  (option 2 on #4481). REST reach stays the key's scopes intersected with its
  principal. 3a mints only the scopes an agent's grants need.
- **The engine-path cells in the enforcement test** used `POST /agent-runs`
  with a suspended agent's key to reach the engine. That route now refuses the
  key, so those cells call the usecase with the key's verified context. That is
  how a job or an inbound A2A message reaches the engine with an agent bound,
  and where the funnel's own suspension check still has to hold.
