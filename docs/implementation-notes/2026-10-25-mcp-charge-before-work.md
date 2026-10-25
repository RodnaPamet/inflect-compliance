# 2026-10-25 — /api/mcp charges the key before the work, and guards after the gate

**Commit:** `<sha> fix(mcp): charge the key before building the invocation, and guard arguments after the gate`

Fixes #4205, found by Step 0H's adversarial re-read of #4111 (Step 0d). The
owner decided on 2026-10-25 to fix it in its own pull request, not to hold it
for 0H.

## Design

```
POST /api/mcp
  withApiErrorHandling       the per-IP ceiling (mcp-ip), unchanged
  verifyMcpCredential        key or exchanged token, MCP scope        cheap
  parse the body             invalid JSON / [] / >60 → charge 1, 400
  charge the key             per message, all or nothing → 429
  completeMcpAuthentication  registration gate, then buildMcpInvocation   expensive:
                             one live tools/list per granted external connection
  dispatch
    read tool → runReadTool(inv, name, args, { beforeRun: assertMcpArgumentsAllowed })
                resolve → authorizeToolCall → beforeRun → validate → run
```

## Files

| File | Role |
| --- | --- |
| `src/lib/mcp/auth.ts` | `verifyMcpCredential` + `completeMcpAuthentication`; `authenticateMcpRequest` is their composition |
| `src/app/api/mcp/route.ts` | Verify, charge (malformed requests included), then build and dispatch |
| `src/lib/mcp/tools/registry.ts` | `runReadTool`'s `beforeRun` hook, after the gate |
| `src/lib/mcp/argument-guard.ts` | Refuses with the verdict's code and no rule ids |
| `src/lib/security/rate-limit-middleware.ts` | `X-RateLimit-Remaining` reports what is left |

## Decisions

- **The split is at the expensive call, not at authentication's end.** Step
  one is the credential and its scope: a key lookup and, for an exchanged
  token, a signature check. Step two is the registration gate and
  `buildMcpInvocation`, which reaches the external servers. The charge needs
  only step one's key id.
- **The registration gate stays in step two.** It refuses a key whose agent
  the register does not vouch for, with an `AUTHZ_DENIED` row. A refused key
  is already charged, which is right: it made a request.
- **A malformed request costs one unit, whatever its shape.** Invalid JSON, an
  empty batch and an oversized batch each did no work after the reorder, so
  charging their full size would only punish the caller. Charging nothing let
  them run unbounded per key.
- **An empty batch is a single Invalid Request error,** as JSON-RPC 2.0
  requires, with status 400 like the other malformed requests.
- **The guard moved inside the funnel's order, not out of the route.**
  `beforeRun` runs after `authorizeToolCall`. A made-up tool name is then
  `MethodNotFound` before anything is scanned, and an unauthorized call writes
  its `AUTHZ_DENIED`. The scan still runs on the raw arguments, before
  validation, as it did before.
- **No rule ids to the caller.** The direct route has no latch, so ids in the
  error let a caller tune a payload by retrying. `propose-tools.ts` already
  withholds them. The codes (`ai_guard_blocked:`, `ai_guard_review_required:`)
  are unchanged, so every reader of those prefixes still matches.
- **`X-RateLimit-Remaining` reads the limiter's own count.** It is 0 for every
  one-unit refusal, as before. Only a refused batch can leave units.
- **The scanner's blind spots are not fixed here** (keys are not scanned, and
  nothing past depth 12 is). They predate #4111 and affect every guard
  surface: #4206.
