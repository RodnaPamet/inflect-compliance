# 2026-10-18 — Service-principal disable through the external write ladder (agentic IAM 2c)

**Commit:** `feat(agentic): disable a contained agent's Entra service principal through the external write ladder (2c)` (#3671)

## Design

2b stops an orphaned agent inside Inflect: an `OWNER_DEPARTED` kill and a
suspension. Its identity in the customer's directory was untouched, so a service
principal with a client secret could still get tokens for whatever else it held.
2c carries the containment one step outward, and does it only through the
external write ladder. Nothing new calls Microsoft Graph except one provider
client behind one outbound endpoint.

```
05:15 agent-owner-orphan-pass (AUTOMATIC)
        kill (OWNER_DEPARTED) → suspend → transfer task
        → requestServicePrincipalDisable(agent)            usecases/agent-service-principal-disable.ts
             1 contained? one entra:sp:<GUID> link?        usecases/agent-service-principal-links.ts
             2 the ONE pairing mcp__<conn>__disable_service_principal → its connection
             3 the connection's rung   DISABLED → stop, nothing read
             4 AUTOMATIC: the ONE template bounded to contained_orphan_agent_entra_service_principals,
                         and the principal in that population NOW
             5 paired read (callTool → read_service_principal_state); unreadable → REFUSED
             6 already disabled → nothing
             7 DRY_RUN       recordIntent            RECORDED_ONLY row + prior state
               PROPOSE_ONLY  createAgentProposal     EXTERNAL_WRITE proposal + prior state
               AUTOMATIC     openAutomaticExternalWrite  PENDING row + prior state + Art 12 row
external-write-dispatch (the one sender)
        rung · row rung · pairing · drift (PROPOSE_ONLY) / bounds + population (AUTOMATIC)
        · SEND_PRECONDITIONS: the principal's agent still contained (every rung)
        → callTool(disable_service_principal)  ──HTTPS──▶  POST /api/mcp/entra-service-principal
                                                              token → connection → tenant
                                                              endpointBindingRefusal
                                                              entra-service-principal-dispatch.ts
                                                              providers/entra-id/service-principal.ts
                                                              PATCH /servicePrincipals/{id} {accountEnabled:false}
        → ACCEPTED (never APPLIED on a 2xx); an isError answer → INDETERMINATE
external-write-reconcile
        paired read; enabled-before and disabled-now, same id → APPLIED
```

The orphan pass records the outcome on each decision as `servicePrincipal`, by
the `DiscoveredAgent` row id and never the principal's object id
(`IntegrationExecution.resultJson` is not encrypted). Outcomes that mean "a disable
was due and did not happen for a reason an operator fixes" make the pass PARTIAL;
`NOT_LINKED`, `NO_PAIRED_ENDPOINT` and `RUNG_DISABLED` do not, because they are the
default for every tenant that has not set this up. At DRY_RUN the pass reports
`WOULD_REQUEST_DISABLE` from the population read alone: no network, no journal row.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/service-principal-disable.ts` | Tool names, target field, population key, `entra:sp:` id parsing, the read-answer parser, the outcome vocabulary and which outcomes need attention |
| `src/app-layer/integrations/providers/entra-id/service-principal.ts` | The only Graph code for this write: GET and PATCH one principal; `disableRefusal` (already disabled, the connection's own principal, Microsoft first-party) |
| `src/app-layer/usecases/entra-service-principal-dispatch.ts` | The endpoint's usecase: resolve the one Entra connection, refuse on configuration, read before write; `endpointBindingRefusal` |
| `src/app/api/mcp/entra-service-principal/route.ts` | The outbound endpoint: two tools, token-gated like the grant endpoint, refusals audited |
| `src/app-layer/usecases/agent-service-principal-links.ts` | Contained agents (OWNER_DEPARTED kill in force) and their `entra:sp:` links, shared by the request and the population |
| `src/app-layer/usecases/agent-service-principal-disable.ts` | The request path, rung by rung; never throws; emits the outcome metric |
| `src/app-layer/usecases/external-tool-target-populations.ts` | The fifth population, `contained_orphan_agent_entra_service_principals` |
| `src/app-layer/usecases/external-write-dispatch.ts` | The disable in `ASYNC_DELIVERY_TOOLS`; `SEND_PRECONDITIONS` (still contained, at every rung); an `isError` write answer settles INDETERMINATE |
| `src/app-layer/usecases/external-write-reconcile.ts` | The disable's verifier; `DELIVERY_EVIDENCE`, a promotion sentence per tool |
| `src/app-layer/usecases/agent-owner-orphan-pass.ts` | Requests the disable after the kill; DRY_RUN reporting; attention counts toward PARTIAL |
| `src/app-layer/usecases/agent-proposals.ts` | A proposal made from a JOB context is audited `actorType: 'JOB'` |
| `src/lib/observability/integration-metrics.ts` | `agentic.owner_orphan_pass.service_principal_disable` |
| `tests/guards/service-principal-disable-graph-seam.test.ts` | The import-graph proof that nothing calls Graph for this write outside the dispatch |

## Decisions

- **The link is the harness reconciliation, and no schema change was made.**
  `RegisteredAgent` has no directory column. The existing link is a
  `DiscoveredAgent` whose `discoveredId` is `entra:sp:<objectId>` and whose
  `registeredAgentId` is the agent. The ingest sets that column only when the
  register row exists in this tenant, and `discoveredId` is unique per tenant, so
  one principal reconciles to at most one agent. An agent with two `entra:sp:`
  links is refused as `AMBIGUOUS_LINK` and is excluded from the population. The
  link is the scanner's claim, checked only for existence, so the rungs above
  DRY_RUN carry the trust: a human reads the principal's state in the proposal at
  PROPOSE_ONLY, and at AUTOMATIC two humans approved a template bounded to the
  contained-agent population. Whether a scanner's claim may steer an unattended
  directory write is listed below as an owner question.

- **A sibling endpoint, not two more tools on the grant endpoint.** The rung is
  per connection. On the grant endpoint a tenant at AUTOMATIC for time-bounded
  grants would be at AUTOMATIC for disabling principals too, with the grant's
  evidence standing in for the disable's. As a sibling, the disable has its own
  connection, its own rung from DISABLED, its own dwell and evidence.
  `endpointBindingRefusal` makes that true at the endpoint: a token whose
  connection names another endpoint (the grant's) is refused with an
  `AUTHZ_DENIED` row. The grant endpoint does not have that check; adding it there
  is a follow-up.

- **The pairing finds the connection.** The request path looks for the one
  `ExternalToolPriorStateRead` whose write tool is `disable_service_principal`.
  No pairing means no write (rule 5 of the roadmap), and two pairings mean two
  directories, which is refused rather than chosen.

- **DISABLED reads nothing; DRY_RUN records an intent.** That matches the
  agent-facing path, where DRY_RUN journals what would change. It is also what
  makes the ladder climbable: the connection's `DRY_RUN → PROPOSE_ONLY` widen
  needs recorded intents, and this pass is the only thing that produces them for
  this connection.

- **AUTOMATIC stands on the existing arm, so it needs a template.**
  `openAutomaticExternalWrite` refuses a write with no parameter set in force. The
  request path uses the one set whose only open field is `servicePrincipalId`, a
  target bounded to `contained_orphan_agent_entra_service_principals`, and which
  does not fix the principal itself. None is `NO_APPROVED_TEMPLATE`; several is
  `AMBIGUOUS_TEMPLATE`. The population admits a principal only while its agent's
  `OWNER_DEPARTED` kill stands, so a completed ownership transfer lifts the kill
  and the dispatch's send-time re-resolution refuses a disable opened before it.

- **The agent must still be contained when the disable leaves, at every rung.**
  At AUTOMATIC the template's bound re-check already asks the population. At
  PROPOSE_ONLY nothing did: the drift check compares the principal's record, which
  a completed ownership transfer does not move, so a disable approved before the
  transfer would have left after it. `SEND_PRECONDITIONS` in the dispatch is a
  per-tool check keyed on the advertised name, like `ASYNC_DELIVERY_TOOLS`, and
  the disable's entry asks `checkTargetInPopulation` before sending. A customer
  tool of the same name is refused more, never less.

- **No manifest pin is consulted on this path.** A pin keeps a rewritten tool
  description out of a model's context. No model reads these descriptions here:
  the request path and the dispatch name the tools and arguments in code.

- **The disable settles ACCEPTED, though Graph answers 204.** `APPLIED` claims the
  principal is disabled. The answer the dispatch sees is our endpoint's MCP result,
  not Graph's, and Entra's directory is eventually consistent, so the claim needs
  the paired read. The verifier promotes only when the prior state read enabled,
  the current state reads disabled, and both describe the same principal. An
  absent `accountEnabled` is unreadable, never false.

- **An `isError` write answer is INDETERMINATE, a change to the shared dispatch.**
  MCP reports a tool's failure in-band, and `callTool` returns it. The dispatch
  read only "did it throw", so an in-band refusal settled ACCEPTED or APPLIED. The
  disable refuses in-band by design, and so does the grant (a subject who already
  holds longer access). INDETERMINATE rather than FAILED, because this pass cannot
  tell our endpoint from a customer's server and FAILED claims nothing changed.

- **The endpoint refuses the connection's own principal and Microsoft first-party
  principals.** `writer.ts` explains why the user writer's self-account rail is
  cosmetic for an app-only credential. For a principal disable it is not: the
  connection authenticates as a service principal, and disabling it would cut off
  every Inflect call into the directory, the re-enable included. A first-party
  principal (owner tenant `f8cdef31-…` or `72f988bf-…`) is never a registered agent.

- **No direction flag.** The JML `writesEnabled` flag's copy is "let leaver
  offboarding DISABLE accounts in this directory", about a person's account. Read
  as consent to disable an agent's principal it would grant an authority the
  checkbox never described. The outbound connection's rung is the consent.

- **No agent is attributed.** The contained agent is the subject of the write, not
  its decider. The journal's `agentId` is null, the proposal's `agentId` is null
  with `policyCardVersion = NO_POLICY_CARD`, and the proposal's audit row says
  `JOB`.

- **The promotion sentence is per tool.** `DELIVERY_EVIDENCE` holds what each
  promotion saw. One sentence for every tool had been "a record that did not exist
  when the write was accepted", which is false of the withdrawal and of the
  disable. The withdrawal's sentence was corrected in the same map.

## Owner questions

1. **The Graph application permission.** Updating a service principal takes
   `Application.ReadWrite.OwnedBy` (only principals the Inflect app owns) or
   `Application.ReadWrite.All`; the read takes `Application.Read.All`.
   `Application.ReadWrite.All` is tenant-wide and lets the holder add credentials
   to any application. Recommendation: `Application.ReadWrite.OwnedBy`, with the
   Inflect application added as an owner of each agent's application, accepting
   that a principal Inflect does not own is refused `Authorization_RequestDenied`
   and lands INDETERMINATE for a human. The code does not depend on the choice.
2. **A scanner's claim as the target of an unattended write.** At AUTOMATIC the
   principal disabled is the one the harness scanner reconciled to the agent. The
   scanner's key is registered under `admin.agent_registry` and the report is
   signed, but the link is not confirmed by a person. Recommendation: accept it
   for the pilot, where the scanner is Inflect's own, and record a confirmed link
   before a client estate reaches AUTOMATIC.
3. **Decision 17 assumed the pass acts only on agents.** With 2c the pass can open
   unattended directory writes. They are capped by the existing
   `AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW` (50 per connection per hour), and
   there is no breaker like the identity leaver's. Recommendation: keep decision 17
   and rely on the cap and the population, because each write disables one agent
   principal and is undone by setting one field back.
