# 2026-10-26 — Background work an API key starts runs as the key

**Commit:** `fix(api-keys): background work a key starts runs within the key and stops when it is revoked`

## Design

#4382 made the evidence ZIP import run as the key that started it. Four other
paths queued work from a key-authenticated request and dropped the key on the
way (#4386). Each now carries the key's id and, when the work runs, resolves it
through `resolveKeyInitiatorContext` (`src/app-layer/context-system.ts`): the
tail a request runs (`resolveApiKeyForJob` → `finaliseApiKeyAuth`), intersected
with the member's own authority. A payload with no key id takes the path it
always took.

```
SharePoint "Sync now"   route → payload.apiKeyId → buildJobContext → key ∧ actor
                        then mayRunDeltaSync on that context
queued workflow run     WorkflowRun.triggeredViaKeyId (already stored)
                        → rebuildRunContext → key ∧ member, run's own agentId
                        → resolveMcpInvocation intersects with the principal again
author-less rule        bus stamps event.actorApiKeyId from ctx → dispatch payload
                        → rehydrate → ActionEvent → resolvePrincipalCtx → key ∧ actor
key rotation            route → payload.apiKeyId → assertInitiatingKeyStillAuthorises
                        → key ∧ initiator, then admin.manage
```

**What changes for a running agent.** Before, a key-started run held the
member's role and permissions with `apiKeyScopes` beside them. The funnel's
scope reads (`enforceApiKeyScope` at step 8 of `authorizeToolCall`,
`enforceMcpCapability`, `loadableProposeTools`, `holdsScope`) did bind, and
they are unchanged. What did not bind was everything that reads the context's
permissions: permission keys and coarse policies with `basis: 'ctx'`,
`applyRedaction` / `applyRowRedaction`, and every usecase a tool calls. The
funnel's `buildMcpInvocation` intersects with the principal, and the member
intersected with the member is the member. Now the run's tool calls run on
exactly what an `/api/mcp` call with the same key runs on: principal ∧ key.
Tools on `basis: 'principal'` (the propose tools) are unchanged. The run also
carries `apiKeyMaxAutonomy` now, so the key's own ceiling caps the run as it
caps every request; before, a queued run had no key term in
`resolveAutonomyCeiling`.

## Files

| File | Role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/integrations/sharepoint/sync/route.ts` | enqueues the key's id when the request carried one |
| `src/app-layer/jobs/sharepoint-delta-sync.ts` | builds the sync's context from the key when the payload names one |
| `src/app-layer/usecases/workflow-runs.ts` | `rebuildRunContext` resolves the key; `executeQueuedWorkflowRun` names a key refusal |
| `src/app-layer/automation/event-contracts.ts` | `actorApiKeyId` on the event, omitted from what a producer may pass |
| `src/app-layer/automation/automation-bus.ts` | stamps `actorApiKeyId` from ctx, never from the input |
| `src/app-layer/automation/bus-bootstrap.ts`, `jobs/automation-event-dispatch.ts` | carry it across the queue to `executeAction` |
| `src/app-layer/usecases/automation-executions.ts` | a manual replay stamps it too |
| `src/app-layer/automation/action-executor.ts` | `resolvePrincipalCtx`: an author-less rule's actor narrowed to the key |
| `src/app/api/t/[tenantSlug]/admin/key-rotation/route.ts` | enqueues the key's id |
| `src/app-layer/jobs/key-rotation.ts` | `assertInitiatingKeyStillAuthorises` before the started row |
| `src/app-layer/jobs/types.ts`, `executor-registry.ts` | the payload members, and passing the rotation's through |

## Decisions

- **The run keeps its own `agentId`, not the key's.** `resolveKeyInitiatorContext`
  returns the key's agent binding. A run's binding can differ from it (an
  interactive run binds the designated agent over the caller's key), and the
  register's grants, card and ceiling key on the run's. So that one field is
  replaced, and the rest of the context is the resolver's.
- **A key refusal is named on the run; a member refusal keeps its message.**
  A member who no longer resolves maps back to the `PRINCIPAL_REVOKED` outcome
  and its `run_principal_no_longer_authorised` text, which is what a member who
  left always produced. That covers `initiator_not_a_member` for a plain key
  and `principal_unresolved` for an agent-bound one, where the request tail
  also writes the `AUTHZ_DENIED` row a request with that key would. Every
  other reason settles the run FAILED with `run_api_key_no_longer_authorised`
  and the reason, and the worker reports `API_KEY_REFUSED:<reason>`. Before, a
  revoked or expired key produced the membership message, which named the
  wrong thing.
- **The event carries the key id, and only the bus sets it.** The event had no
  trace of the key, so `actorApiKeyId` was the smallest correct carrier. It is
  in the `EmitAutomationEvent` omit list beside `tenantId`, and the bus deletes
  any value an untyped caller passes before stamping ctx's. It is set only when
  ctx has a key, so a session's event, payload and `ActionEvent` are the same
  objects they were. The chain and sub-flow dispatchers pass no actor at all,
  so an author-less rule there is refused for having no actor, as before.
- **Only the author-less fallback reads the key.** A rule with an author runs
  as its author. The key that fired the event is provenance there, for the
  reason `resolveActorCtx` gives about the firing member. The membership is
  read by `resolveActorCtx` first, so its refusal messages and the tenant slug
  the assignee notification needs are unchanged.
- **The rotation asks `admin.manage` of key ∧ initiator, not only liveness.**
  The issue asked for a revoked or expired key to stop the job. The rule the
  other three paths follow is "the key ∧ the member, and the route's key asked
  again", and a rotation is no different. A key the route admitted passes
  while its user still holds `admin.manage` (`admin:write` and `*` both map to
  it). An initiator demoted while the rotation was queued now stops it. For a
  plain key this is stricter than a request, which reads the key's scopes
  alone. #4382 made the same choice for the evidence import, and for the same
  reason.
- **Session-started work, and payloads queued before this, are untouched.**
  Every new member is optional and spread in only when present, and every
  path branches on it before anything else is read. Not one built-in role
  gains or loses anything through this change: the narrowing applies only to
  work a key started.
