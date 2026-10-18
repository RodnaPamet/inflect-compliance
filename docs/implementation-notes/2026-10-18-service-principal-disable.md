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
             4a AUTOMATIC: a person's LIVE confirmation of exactly this link,
                          else LINK_UNCONFIRMED             usecases/agent-service-principal-confirmation.ts
             4b AUTOMATIC: the ONE template bounded to contained_orphan_agent_entra_service_principals,
                          and the principal in that population NOW
             5 paired read (callTool → read_service_principal_state); unreadable → REFUSED
             6 already disabled → nothing
             7 DRY_RUN       recordIntent            RECORDED_ONLY row + prior state
               PROPOSE_ONLY  createAgentProposal     EXTERNAL_WRITE proposal + prior state
                                                     + "THE LINK IS UNCONFIRMED" when it is
               AUTOMATIC     openAutomaticExternalWrite  PENDING row + prior state + Art 12 row
external-write-dispatch (the one sender)
        rung · row rung · pairing · drift (PROPOSE_ONLY) / bounds + population (AUTOMATIC)
        · SEND_PRECONDITIONS: the principal's agent still contained (every rung);
                              an AUTOMATIC row's link still confirmed
        → callTool(disable_service_principal)  ──HTTPS──▶  POST /api/mcp/entra-service-principal
                                                              token → connection → tenant
                                                              endpointBindingRefusal
                                                              entra-service-principal-dispatch.ts
                                                              providers/entra-id/service-principal.ts
                                                              PATCH /servicePrincipals/{id} {accountEnabled:false}
        → ACCEPTED (never APPLIED on a 2xx); an isError answer or a throw → INDETERMINATE
external-write-reconcile
        paired read; enabled-before and disabled-now, same id → APPLIED
```

The orphan pass records the outcome on each decision as `servicePrincipal`, by
the `DiscoveredAgent` row id and never the principal's object id
(`IntegrationExecution.resultJson` is not encrypted). Outcomes that mean "a disable
was due and did not happen for a reason an operator fixes" make the pass PARTIAL,
`LINK_UNCONFIRMED` among them; `NOT_LINKED`, `NO_PAIRED_ENDPOINT` and
`RUNG_DISABLED` do not, because they are the default for every tenant that has not
set this up. At DRY_RUN the pass reports `WOULD_REQUEST_DISABLE` from the
population read alone: no network, no journal row.

**The confirmation** (owner decision, 2026-10-18). The link the disable acts on is
the harness scanner's reconciliation, which the ingest checks only for existence.
That is enough where a person reads the proposal and not where nobody does. So a
person holding `admin.agent_registry` confirms, per link, that a discovered
principal is the agent's own:

```
POST /api/t/:slug/admin/agents/:agentId/service-principal-link   { discoveredAgentId }
  requirePermission('admin.agent_registry')  →  confirmServicePrincipalLink
     agent exists · DA is entra:sp:<GUID> · the harness links THIS DA to THIS agent
     · the agent has exactly one entra:sp: link  →  AgentServicePrincipalConfirmation row
GET  …/service-principal-link   the agent's links, each with its live confirmation, and history

harness ingest (same transaction as the DiscoveredAgent upsert)
     DA moved to another agent or to none   → confirmations of that DA       PRINCIPAL_RELINKED
     agent now linked to a different DA      → that agent's other confirmations AGENT_RELINKED
```

A confirmation counts only while it is not invalidated AND its triple
(discovered agent, `discoveredId`, registered agent) matches the link as it
stands. The request path asks for the triple it found; the dispatch, holding only
an object id at send, resolves the link the same way and asks again.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/service-principal-disable.ts` | Tool names, target field, population key, `entra:sp:` id parsing, the read-answer parser, the outcome vocabulary (incl. `LINK_UNCONFIRMED`) and which outcomes need attention |
| `src/app-layer/integrations/providers/entra-id/service-principal.ts` | The only Graph code for this write: GET and PATCH one principal; `disableRefusal` (already disabled, the connection's own principal, Microsoft first-party); the permission decision |
| `src/app-layer/usecases/entra-service-principal-dispatch.ts` | The endpoint's usecase: resolve the one Entra connection, refuse on configuration, read before write; `endpointBindingRefusal` |
| `src/app/api/mcp/entra-service-principal/route.ts` | The outbound endpoint: two tools, token-gated like the grant endpoint, refusals audited |
| `src/app-layer/usecases/agent-service-principal-links.ts` | Contained agents (OWNER_DEPARTED kill in force) and their `entra:sp:` links, shared by the request and the population |
| `src/app-layer/usecases/agent-service-principal-disable.ts` | The request path, rung by rung; never throws; emits the outcome metric; states the link's confirmation in the rationale |
| `src/app-layer/usecases/agent-service-principal-confirmation.ts` | The only writer of confirmations: confirm, read state, `liveConfirmationFor`, `servicePrincipalLinkConfirmed`, `invalidateRelinkedConfirmations` |
| `src/app/api/t/[tenantSlug]/admin/agents/[agentId]/service-principal-link/route.ts` | GET / POST, each a literal `requirePermission('admin.agent_registry')` |
| `prisma/schema/agentic.prisma` · `prisma/migrations/20261018165000_agent_service_principal_link_confirmation/` | `AgentServicePrincipalConfirmation`; CHECKs, partial unique, one-way trigger, no DELETE for `app_user`, RLS |
| `src/app-layer/usecases/agent-harness-scans.ts` | The ingest invalidates confirmations whose link it moved |
| `src/app-layer/usecases/external-tool-target-populations.ts` | The fifth population, `contained_orphan_agent_entra_service_principals` |
| `src/app-layer/usecases/external-write-dispatch.ts` | The disable in `ASYNC_DELIVERY_TOOLS`; `SEND_PRECONDITIONS` (still contained at every rung; still confirmed at AUTOMATIC); an `isError` write answer settles INDETERMINATE |
| `src/app-layer/usecases/external-write-reconcile.ts` | The disable's verifier; `DELIVERY_EVIDENCE`, a promotion sentence per tool |
| `src/app-layer/usecases/agent-owner-orphan-pass.ts` | Requests the disable after the kill; DRY_RUN reporting; attention counts toward PARTIAL |
| `src/app-layer/usecases/agent-proposals.ts` | A proposal made from a JOB context is audited `actorType: 'JOB'` |
| `src/lib/security/route-permissions.ts` | The confirmation route's rule, above the `/admin/agents` catch-all |
| `src/lib/observability/integration-metrics.ts` | `agentic.owner_orphan_pass.service_principal_disable` |
| `tests/guards/service-principal-disable-graph-seam.test.ts` | The import-graph proof that nothing calls Graph for this write outside the dispatch |

## Decisions

- **The link is the harness reconciliation; the confirmation is about that link.**
  `RegisteredAgent` has no directory column. The existing link is a
  `DiscoveredAgent` whose `discoveredId` is `entra:sp:<objectId>` and whose
  `registeredAgentId` is the agent. The ingest sets that column only when the
  register row exists in this tenant, and `discoveredId` is unique per tenant, so
  one principal reconciles to at most one agent. An agent with two `entra:sp:`
  links is refused as `AMBIGUOUS_LINK` and is excluded from the population. A
  confirmation cannot create a link: the confirm refuses unless the harness
  currently links that principal to that agent and the agent to it alone, because
  a second source of links would be a second thing the disable has to read.

- **Graph permission: `Application.ReadWrite.OwnedBy` + `Application.Read.All`**
  (owner decision, 2026-10-18). The read needs `Application.Read.All`; the disable
  takes `OwnedBy`, never `Application.ReadWrite.All`, which is tenant-wide and lets
  the holder add credentials to any application. With `OwnedBy` the Inflect
  application must be an owner of each agent's application. A principal it does
  not own is read, passes every refusal, and then the PATCH answers 403
  `Authorization_RequestDenied`: the client throws, the route returns a protocol
  error, and the dispatch settles the row INDETERMINATE for a human to finish in
  the customer's directory. That is not caught into a refusal, because the
  dispatch cannot tell it from a request that reached the directory. The code does
  not depend on which permission is consented; the consent is the authority.

- **A person confirms the link before any AUTOMATIC disable** (owner decision,
  2026-10-18). DRY_RUN and PROPOSE_ONLY still act on the scanner's link, and the
  PROPOSE_ONLY rationale says in capitals that the link is unconfirmed, or names
  who confirmed it and when, so the approving human sees which. At AUTOMATIC an
  unconfirmed link refuses `LINK_UNCONFIRMED` before the template or the paired
  read; the orphan pass's decision records it and the pass reports PARTIAL. The
  dispatch asks again at send for an AUTOMATIC row, so a link invalidated between
  the request and the send is refused there too. A PROPOSE_ONLY row is not asked:
  a person approved that specific principal with the confirmation state in front
  of them.

- **A new model, not columns on `DiscoveredAgent`.** The harness ingest is that
  table's single write seam (`agent-harness-single-write-seam`), and a person's
  confirmation written into a row the scanner rewrites every scan would make the
  ingest responsible for preserving a human decision. A separate table also keeps
  the history: who confirmed, when, and why it stopped counting.

- **One-way at the database.** A `BEFORE UPDATE` trigger refuses any change to
  the triple, the confirmer, `confirmedAt` or `createdAt`, and any change to an
  invalidation once set; `app_user` holds no DELETE. The one permitted move is
  `invalidatedAt` NULL → a value with a reason, and a CHECK holds the reason set.
  A partial unique index allows one live confirmation per link, so re-confirming
  after an invalidation is a new row, not a rewrite of the old one.

- **Invalidated, never re-pointed, and never revived.** The ingest stamps
  `PRINCIPAL_RELINKED` when it moves a principal to another agent or to none, and
  `AGENT_RELINKED` when it links the agent to a different principal, in the
  transaction that moved the link. A scan that moves the link back does not
  revive the row: a link that flapped is one a person should look at again.
  Readers also match the triple against the link as it stands, so a row the
  ingest did not reach still cannot vouch for a different link.

- **The confirm's floor is `assertAgentGovernanceWrite(ctx, 'agent_registry')`.**
  The route's literal `requirePermission('admin.agent_registry')` is the authority
  and writes the `AUTHZ_DENIED` row. The usecase floor follows #3713, so AI_ADMIN,
  which holds the key on READER's coarse tier, can confirm. No API-key scope
  reaches `admin.agent_registry`, `*` included, so a confirmation is always a
  person at a session.

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
  the disable's entry asks `checkTargetInPopulation` before sending, and at an
  AUTOMATIC row `servicePrincipalLinkConfirmed`. A customer tool of the same name
  is refused more, never less.

- **No blast-radius breaker; decision 17 stands** (owner re-confirmed, 2026-10-18).
  With 2c the orphan pass can open unattended directory writes. They are bounded
  by the existing `AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW` (50 per connection
  per hour), which caps a mass departure, by the contained-agent population, and
  now by the per-link confirmation. Each write disables one agent principal and is
  undone by setting one field back.

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
