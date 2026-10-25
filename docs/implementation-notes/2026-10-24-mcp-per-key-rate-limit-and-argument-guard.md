# 2026-10-24 — `/api/mcp`: a per-key budget, and the AI Guard on read arguments

**Commit:** `<sha>` fix(mcp): key the MCP rate limit by API key and guard read-tool arguments

Two gaps found while reviewing how Claude agents would reach Inflect
(`docs/claude-agent-sdk-design.md`, `docs/claude-managed-agents-design.md`).
Neither was new. Both became urgent once the answer to "how does a customer's
hosted agent call us" was "from its provider's addresses".

## Design

```
POST /api/mcp
  withApiErrorHandling ── MCP_IP_CEILING_LIMIT   600/min, key mcp-ip:ip:<ip>:anon     (containment)
  authenticateMcpRequest
  parse JSON-RPC payload
  batch > 60 messages? ── 400
  enforceApiKeyRateLimit ── MCP_PER_KEY_LIMIT   60/min, key mcp-api-key:key:<apiKeyId>, units = messages
  for each message:
    tools/call (read)    → assertMcpArgumentsAllowed → runReadTool
    tools/call (propose) → runProposeTool             (the queue guards and quarantines)
```

**The rate limit.** The endpoint rode the default mutation tier:
`api-mutation:ip:<ip>:anon`, one bucket per caller IP, shared with every other
default mutation route. Anthropic's Managed Agents and the Messages API's MCP
connector call from Anthropic's egress, so every customer agent hosted there
would have shared one 60/min budget, and one busy agent would have throttled
the rest. The budget now belongs to the verified key. A per-IP ceiling, ten
keys' worth, remains in front of authentication for the case the per-key
budget cannot see: a made-up key that never authenticates.

**The guard.** `runGuardedTool` scans a model's proposed arguments before the
funnel for every agent Inflect runs. The direct route scanned nothing.
`assertMcpArgumentsAllowed` now runs the same egress slice before `runReadTool`:
`block` and `flag` both refuse, and the guard audits rule ids.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/rate-limit.ts` | `checkRateLimit` takes `units`, all or nothing; the two MCP presets |
| `src/lib/security/rate-limit-middleware.ts` | `enforceApiKeyRateLimit` / `buildApiKeyRateLimitKey`; re-exports the presets |
| `src/lib/mcp/argument-guard.ts` | `assertMcpArgumentsAllowed`: the egress slice and both assertions |
| `src/app/api/mcp/route.ts` | wires both: the ceiling on the wrapper, the per-key budget after auth, the guard before reads |
| `tests/unit/mcp-route-limits-and-guard.test.ts` | the real route, wrapper, limiter and guard |
| `tests/unit/rate-limit-middleware.test.ts` | `units`, the per-key helper, the two presets pinned |
| `docs/rate-limiting.md`, `docs/security/aisvs-self-assessment.md`, `CLAUDE.md` | the new behaviour where the old was stated |

## Decisions

- **Keyed on the verified `apiKeyId`, after authentication, never on a token
  digest before it.** The edge meter for `iflk_` callers on `/api/t/**` keys
  fairness on a digest because the edge has no database; that bucket is
  attacker-controlled, which is why it needs the IP bucket beside it. Here the
  route has authenticated, so fairness can key on something the caller cannot
  vary. An exchanged token resolves to its issuing key, so exchange cannot
  multiply the budget.
- **No IP in the per-key key.** A key calling from many addresses gets one
  budget. That is stricter than before, where each address had its own bucket.
- **Charged per JSON-RPC message.** One POST can carry a batch, so charging
  per request let a single call carry any number of tool calls. That was true
  before this change too, and it is closed here because the per-key budget
  would otherwise be decorative.
- **All or nothing.** Charging a batch one unit at a time would spend the
  remaining budget on the messages that fit and then refuse the rest, so a
  client retrying a refused batch would find less budget than it was refused
  with. `checkRateLimit` gained a `units` argument rather than the route
  looping, and with the default of 1 it is the same check every other caller
  relies on (the test pins that).
- **A batch over 60 is a 400, not a 429.** It can never fit, so "retry after N
  seconds" would be a lie.
- **600/min for the ceiling.** It has to sit above the per-key budget, or
  callers sharing an address collide again. Ten keys' worth leaves headroom for
  several hosted customers on one egress address while still bounding one
  address to ten key lookups a second. It is the number to revisit if hosted
  adoption grows. The storage is per process, as for every Node-side tier.
- **Reads only for the guard.** `createAgentProposal` already runs the injection
  and egress scans on proposed content, and a non-clean item becomes a terminal
  QUARANTINED row a reviewer sees. Refusing at the route would replace that
  visible record with a bare error.
- **`flag` refuses.** As in `runGuardedTool`. A direct call has no run to park
  and nobody waiting to review it. A tenant in `AUDIT` mode gets the audit row
  and no refusal, which is what that mode means everywhere else.
- **No result scan.** `runGuardedTool` scans a result because it is about to
  enter Inflect's model. A direct caller's result enters the caller's model.
- **The token exchange route is unchanged.** `/api/mcp/token` keeps its tight
  `API_KEY_CREATE_LIMIT`, keyed by IP. It is the amplification surface, and the
  hosted clients this change is for present the key directly rather than
  exchanging it.
