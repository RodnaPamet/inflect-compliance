# A2A threat model

A2A (Agent2Agent) is the protocol the owner chose for Inflect's agents to
exchange work with agents in other organisations. The owner settled it on
2026-10-17 (decision 4 in [`docs/agentic-iam-roadmap.md`](agentic-iam-roadmap.md)):
peers use A2A from the start, through the existing authority funnel, and each
peer's agent card is pinned by hash and re-approved when it changes.

This document models that traffic in both directions, hop by hop. On `main`
there is a peer register with card pinning (step 2e, #3673; the mapping onto the
funnel is [`docs/a2a-mapping.md`](a2a-mapping.md)), and there is no inbound A2A
endpoint and no outbound A2A client. For every hop it names the trust boundary, the STRIDE
threats and the control. Each control is in one of two states:

- **On `main`**, cited by file and symbol. It holds today and A2A traffic must
  pass through it.
- **Required**, with the step that builds it: **2e** (peer records and card
  pinning, #3673) or **4b** (the A2A pilot, #3679). This document is what those
  steps read first. The controls this model assigned to **2d** (the integration
  passport, #3672) are on `main` and are cited as such.

The residual risks, each with the step that closes it, are at the end.

## Decisions and sign-off

On 2026-10-17 the owner accepted three of this model's controls as requirements
on step 4b. They are the owner's decisions, not proposals of this model, and
each row that carries one says **by owner decision (2026-10-17)**:

- **R13**: inbound A2A is refused for a tenant that has not set both
  `agentMonthlyTokenBudget` and `agentMaxConcurrentRuns` (I2 D).
- **R17**: a run started by an inbound A2A task never dispatches an external
  write above `PROPOSE_ONLY` (I4 E).
- **R18**: a peer's agent card is re-checked before every message against a
  copy at most 15 minutes old (pinning rule 6; I2 S, O1 T).

On 2026-10-18, at step 2e, the owner decided R3 as this model recommended: the
peer register and pin routes take `admin.agent_registry`, and
`admin.agent_external_tools` stays the key for an agent's call leaving the
tenant.

The owner's merge of the pull request that adds this document is the owner's
sign-off on it. The security owner's review is a separate act that the merge
does not supply; it is recorded on #3662 when given.

## A2A, as far as this model needs it

A peer publishes an **agent card**: a JSON document naming the agent, describing
it in free text, giving its service endpoint, its capabilities, the
authentication it requires, the protocol version and a list of **skills**, each
with a name, a description and examples. A client sends the peer a **message**
over JSON-RPC on HTTPS; the work it starts is a **task** with a lifecycle. A
message is made of parts: text, a file (inline bytes or a URI) or structured
data. Results come back as artefacts. A peer may stream updates, may ask for more
input before it finishes, and may call a client-supplied URL with push
notifications.

Three properties matter for the threats below. The card's descriptions and skill
text are instruction text a model reads, exactly as an MCP tool description is.
Every part of a message is content written by another organisation. And the
protocol has three ways to make one party dial an address the other supplied:
the card's endpoint, file URIs and push-notification URLs.

## One authority model

**A2A adds no second authority model.** A peer is never granted a tool, a
permission key, an API scope or an autonomy rung. The peer record that step 2e
builds must hold admission facts only: who the peer is, who answers for it, its
risk tier (an unscored tier refuses traffic), where it lives, which key signs its
messages, which card a person accepted, and whether it is active. Authority is
decided where it is decided today.

A peer is to be a registered principal for identity and attribution, and not
for authority. Its record gives it its own owner, tier, card and signing key;
every message it sends is admitted against that record, and every run it starts
is recorded against it (I2, R12). The credential it presents resolves to the
receiving registered agent, with the peer's accountable owner as the principal
behind it, the way an agent's API key resolves today, so whatever the peer
causes is done under authority Inflect already models.

**Inbound**, the model lets a peer cause at most one run of one registered
Inflect agent. Everything that run may do is decided by the chain every run
goes through:

- the credential resolves through `verifyApiKey` (`src/lib/auth/api-key-auth.ts`),
  the registration gate (`src/lib/agentic/agent-registration-gate.ts`) and
  `resolveAgentAuthority` (`src/lib/agentic/agent-authority.ts`), whose
  authority is the principal's intersected with the credential's, never more
  than either;
- every tool call passes `authorizeToolCall` (`src/lib/mcp/authorize.ts`): kill
  switch, audience, credential liveness, circuit breaker, manifest pin, the
  agent's allowlist, the autonomy ceiling, the policy card, capability, scope,
  permission and policy, in that order;
- every write to Inflect's data is a proposal a person approves
  (`createAgentProposal` and `approveAgentProposal` in
  `src/app-layer/usecases/agent-proposals.ts`);
- every write to another system is an external tool call on the external write
  path described under **Outbound**, and follows the connection's rung. Below
  `AUTOMATIC` it is refused (`DISABLED`), journalled as a dry run that sends
  nothing (`DRY_RUN`), or made a proposal a person approves (`PROPOSE_ONLY`).
  At `AUTOMATIC`, which is the top rung and reachable (`EXTERNAL_MAX_MODE` in
  `src/lib/integrations/external-write-ladder.ts`), no person approves it: the
  dispatch pass sends it (`openAutomaticExternalWrite` in
  `src/app-layer/usecases/external-write-automatic.ts`, and
  `src/app-layer/usecases/external-write-dispatch.ts`). What bounds it there is
  the approved parameter set that must be in force, the constraints on its open
  values, the target population re-resolved at dispatch where the set has an
  open target, and the per-connection window
  (`AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW`, 50 an hour). A run an inbound
  task started is not told apart today. Step 4b is required, by owner decision
  (2026-10-17), to tell it apart and to hold its external writes at
  `PROPOSE_ONLY`; see I4 and residual R17.

**Outbound**, a message to a peer is modelled as an external tool call, decided
by the same funnel plus the external write path that governs every write to a
system that is not Inflect's: the agent's grant (`RegisteredAgentTool`), a pin a
person accepted (`McpToolManifestPin`), the connection's rung on the external
write ladder (`src/lib/integrations/external-write-ladder.ts`), the approved
parameter set where one is in force (`ExternalToolParameterSet`), a nominated
prior-state read (`ExternalToolPriorStateRead`) and the journal
(`ExternalWriteJournal`), all in `prisma/schema/agentic.prisma`.

## Trust boundaries

| Id | Boundary | What crosses it |
|---|---|---|
| TB1 | The internet and Inflect's HTTP surface | A peer's requests to Inflect |
| TB2 | A presented credential and the tenant principal it resolves to | Identity and authority |
| TB3 | Third-party content and a model's context | Text a model reads as data or as instruction |
| TB4 | A model's request and an executed tool | The funnel's decision |
| TB5 | Inflect and a host it dials | Outbound requests, their arguments and their replies |
| TB6 | One tenant's rows and another's | Everything tenant-scoped |
| TB7 | A person configuring an agent and the agent acting | Grants, pins, rungs, pairings, peer records |

What is protected: tenant data and the personal data in it; the credentials a
connection holds; the receiving agent's authority; the integrity of the audit
trail, the run ledger and the external write journal; and the pinned definitions
that decide what a model is told.

## Agent-card pinning

A card is the A2A counterpart of an MCP tool definition and is pinned on the same
reasoning (`src/lib/mcp/tool-manifest.ts`). Step 2e built the rules below
(`src/lib/agentic/peer-agent-card.ts`, `src/app-layer/usecases/peer-agents.ts`),
and step 4b enforces them on traffic.

1. **No pin, no traffic, in either direction.** An unpinned peer is refused.
   Trust on first use, which built-in tools get from `recordBaselinePins`
   (`src/lib/agentic/tool-manifest-store.ts`), does not apply. A card is written
   by another organisation, which is the reason the runtime offers an external
   MCP tool only when its verdict is `APPROVED` (`resolveGrantedExternalTools` in
   `src/app-layer/usecases/external-mcp-tools.ts`).
2. **The pin covers the whole card as served.** Free text (the card's
   description, and each skill's name, description and examples) is hashed as
   exact bytes: no trimming, no whitespace collapsing, no Unicode normalisation,
   because zero-width and bidirectional characters are how instruction text
   hides. Structure is hashed as canonical JSON after a JSON round trip, which
   `hashToolManifest` uses so that the hashed bytes are the wire bytes. The
   composite hash is domain-separated and version-prefixed, so a change to the
   derivation reads as drift rather than as agreement.
3. **Component hashes say what moved.** Beside the composite the gate compares,
   the pin keeps one hash for the text a model reads, one for the endpoint and
   authentication requirements, and one for everything else, including the
   protocol version. An operator asked to re-approve learns whether the
   instructions changed or the plumbing did, as `descriptionHash` and
   `schemaHash` do for tools.
4. **A signature does not replace the pin.** A card correctly signed by the
   peer's key that differs from the pin is a changed card.
5. **Approval is a named person accepting a hash they reviewed.** The approver
   re-reads the live card and names the hash; the approval is refused when the
   live card differs, as `approveExternalToolManifest` refuses on
   `expectedManifestHash`. The pin records the approver, the time, a revision
   and the hash it replaced, as `McpToolManifestPin` does, and the approval is
   audited as `MCP_TOOL_MANIFEST_APPROVED` is
   (`src/app-layer/usecases/mcp-tool-manifest.ts`).
6. **A changed card refuses all traffic for that peer, both directions, until a
   person re-approves it.** The live card is compared with the pin at
   registration, whenever a run assembles the tool that sends to the peer, and
   before every message in either direction: at inbound admission (I2) and before
   each outbound send (O3). The per-message comparison uses a copy of the card
   fetched no more than 15 minutes earlier; when no such copy exists one is
   fetched, and a fetch that fails refuses the message. A change is therefore
   refused in both directions within 15 minutes of being made. The comparison
   before every message against a copy at most 15 minutes old is required on
   step 4b by owner decision (2026-10-17); the window it leaves is residual
   R18. Re-approval is the only way back; refusing never needs approval.
7. **A refusal reveals nothing.** The message returned to an agent or a peer
   names the peer and says re-approval is required. Hashes and the nature of the
   change go to the audit row and the metric only, as `assertToolManifestPinned`
   does in `src/lib/mcp/authorize.ts`; a refusal that described the change would
   be a confirmation oracle for whoever is changing it.
8. **Card text is never logged.** No card description or skill text goes to a
   log line, an audit row or a notification, the rule
   `src/app-layer/usecases/external-mcp-tools.ts` states for external tool
   descriptions.

## Inbound: a peer starts work in Inflect

### I0 — Registering the peer

Boundaries: TB7, and TB5 for fetching the card.

| STRIDE | Threat | Control |
|---|---|---|
| S | A host that imitates a known partner is registered as that partner. | On `main` (2e): `PeerAgent` names an accountable owner, who must be an ACTIVE member, and the supplier, the way `RegisteredAgent` requires a `vendorId` when `provenance` is `THIRD_PARTY` (a CHECK constraint, documented on `RegisteredAgent.vendorId` in `prisma/schema/agentic.prisma`), and carries a risk tier, because the owner's decision registers a peer like an agent, with an owner, a tier and a card. An unscored tier refuses admission (`evaluatePeerAdmission` in `src/lib/agentic/peer-agent-card.ts`), as a null `RegisteredAgent.riskTier` means deny. |
| T | The card changes between the operator reading it and approving it. | On `main` (2e): approval on the reviewed hash, re-read and refused on a mismatch (`approvePeerAgentCard`; pinning rule 5). |
| R | Nobody can say who accepted a card. | On `main` (2e): approver, time, revision and the replaced hash on the pin, and a `PEER_AGENT_CARD_APPROVED` audit entry carrying hashes only (pinning rule 5). |
| I | Fetching the card dials an address the peer chose, which can point inside the network. | On `main`: `safeFetch` (`src/app-layer/automation/webhook-safety.ts`) accepts https only, re-resolves DNS and pins the connection to validated public addresses, and refuses redirects. On `main` (2e): the card fetch (`src/lib/agentic/peer-agent-card-fetch.ts`) goes through it with a byte cap that aborts, and is a registered sink in `tests/guards/ssrf-egress-coverage.test.ts`; `checkWebhookUrl` refuses a private or plaintext card URL at registration. |
| D | An oversized or slow card. | On `main` (2e): a 64 KiB cap that aborts the transfer and a 10-second deadline over request and body, as `wirePost` reads bodies (`src/lib/mcp/wire-transport.ts`). |
| E | The authority that registers and pins a peer is the authority an agent then exercises. | On `main`: configuring and acting are separate keys. `admin.agent_external_tools` governs an agent's call leaving the tenant (`src/lib/permissions.ts`); approving a tenant-wide definition sits with `admin.agent_registry` (`src/app/api/t/[tenantSlug]/admin/agents/external-tools/route.ts`). On `main` (2e): the register and pin routes carry a literal `requirePermission('admin.agent_registry')`, the key the owner chose (R3, 2026-10-18), so the key for the call never configures whom it talks to. |

### I1 — Arrival at the edge

Boundary: TB1.

| STRIDE | Threat | Control |
|---|---|---|
| S | An unregistered agent sends a task. | On `main`: no inbound A2A endpoint exists, so nothing is accepted. Required, 4b: the endpoint refuses any request whose credential does not resolve to an active peer with a current card pin. |
| T | A message is altered in transit or replayed. | Required, 4b: https, and a signature over each message by the peer's registered key, checked with Ed25519 over canonical JSON as `verifyReceiptSignature` does (`src/lib/mcp/receipt-verification.ts`); a message id seen before is refused. |
| I | Inflect's own card discloses what a tenant runs. | Required, 4b: Inflect publishes a card only for an agent a tenant enables for A2A, and the card carries no tenant data and no tool names. |
| I | A new credential type widens the edge's carve-out. | On `main`: the edge lets `/api/t/**` with an `iflk_` bearer fall through to the handler, and `matchTenantApiKeyRequest` (`src/lib/auth/guard.ts`) is deliberately narrow because the fall-through also skips the admin-role and MFA gates. Required, 4b: the A2A endpoint has its own recogniser, and the handler, not the edge, decides whether the credential is real. |
| D | A flood of tasks. | On `main`: `withApiErrorHandling` applies `API_MUTATION_LIMIT` to every POST (`src/lib/security/rate-limit.ts`, `src/lib/security/rate-limit-middleware.ts`), keyed by IP. Required, 4b: a quota per peer, because an IP key cannot tell two peers behind one gateway apart. |
| D | An oversized body. | Required, 4b: a byte cap applied before the body is parsed. |

### I2 — Authentication and admission

Boundaries: TB2, TB6.

| STRIDE | Threat | Control |
|---|---|---|
| S | A peer presents a leaked or another peer's credential. | Required, 4b: the inbound credential is issued per peer, stored as a hash as `TenantApiKey.keyHash` is (`prisma/schema/auth.prisma`), revocable, re-checked on every message, and paired with the per-message signature, so a leaked bearer alone is not enough. |
| S | The peer's card changed since it was pinned. | On `main` (2e): `checkPeerAdmission` reads the live card and refuses a peer whose card differs from its pin (pinning rule 6). Required, 4b: calling it before every message, against a copy at most 15 minutes old, by owner decision (2026-10-17; R18). |
| E | The peer gains authority of its own. | Required, 4b: the inbound credential is bound to the receiving registered agent, as `TenantApiKey.agentId` binds a key today (`prisma/schema/auth.prisma`), and resolves through the chain under "One authority model". Its principal is the peer's accountable owner, so a departed owner's peer is refused by `resolveAgentAuthority`'s existing membership checks. |
| E | The peer chooses which work runs. | On `main`: workflow definitions are code (`src/lib/agentic/workflow-registry.ts`). Required, 4b: an allowlist of workflow keys per peer; a task naming any other workflow is refused. |
| E | A stopped agent receives work. | On `main`: `resolveKillState` (`src/lib/agentic/kill-switch.ts`) is read uncached before the model is called on the agent runtime (`src/lib/agentic/flue/execute.ts`) and as step 0 of every tool call; the registration gate refuses an agent that is not ACTIVE when `TenantSecuritySettings.requireRegisteredAgent` is on, which is the default. Required, 4b: the per-peer kill, checked at admission. |
| I | A peer registered by one tenant reaches another. | On `main`: `getTenantCtx` refuses a key whose tenant is not the URL's tenant (`src/app-layer/context.ts`), and every tenant table carries row-level security (`docs/rls-tenant-isolation.md`). On `main` (2e): `PeerAgent` under row-level security with `FORCE`, tested across two tenants under `app_user` (`tests/integration/peer-agents.test.ts`). |
| D | Peers exhaust a tenant's capacity. | On `main`: `assertWithinMonthlyBudget` (`src/lib/agentic/monthly-budget-policy.ts`) and `assertWithinConcurrencyCap` (`src/lib/agentic/run-concurrency-policy.ts`) refuse before the run row exists. Both columns, `agentMonthlyTokenBudget` and `agentMaxConcurrentRuns`, are nullable and NULL means no cap (`TenantSecuritySettings`, `prisma/schema/auth.prisma`), so a tenant on the defaults has neither. Required, 4b: the per-peer message quota (R13). Required, 4b, by owner decision (2026-10-17): inbound A2A is refused for a tenant that has not set both caps (R13). |
| R | Nobody can say which peer started a run. | On `main`: `WorkflowRun.triggeredViaKeyId` and `WorkflowRun.agentId` (`prisma/schema/agentic.prisma`). Required, 4b: the peer and the verified inbound message are recorded against the run. |

### I3 — The task becomes run input

Boundary: TB3.

| STRIDE | Threat | Control |
|---|---|---|
| T | Instructions in the task steer the receiving agent. | On `main`: the run's input is scanned before the run row exists, and both a flag and a block refuse (`guardUntrustedInput` and `assertNoReviewRequired` in `startWorkflowRun`, `src/app-layer/usecases/workflow-runs.ts`). On the agent runtime the model's message is built from the workflow definition's description and remaining steps (`runMessage` in `src/lib/agentic/flue/execute.ts`), not from the run input; the static engine calls no model. Content of unknown origin resolves to `THIRD_PARTY_INGESTED`, and only `SYSTEM` content may carry instruction (`resolveContentProvenance`, `mayCarryInstruction`, `src/lib/agentic/content-provenance.ts`). Required, 4b: the task's text reaches a model only inside a provenance envelope labelled third-party (`buildProvenanceEnvelope` is the shape), never as the instruction. |
| T | A required input is missing or blank. | On `main`: `assertRequiredInputPresent` (`src/app-layer/usecases/workflow-runs.ts`). |
| I | A file part's URI makes Inflect dial an address the peer chose. | Required, 4b: a URI part is refused, or fetched only through `safeFetch` with a byte cap and labelled third-party. |
| D | A very large task. | Required, 4b: a size cap on the input before it is scanned. |

### I4 — Execution inside Inflect

Boundaries: TB4, TB6.

| STRIDE | Threat | Control |
|---|---|---|
| E | The run reaches a tool the receiving agent was not granted. | On `main`: `authorizeToolCall` on every call, deny by default (`src/lib/mcp/authorize.ts`). The peer adds no term to it. |
| E | The run changes Inflect's data. | On `main`: propose, not commit. A write is an `AgentProposal` (`prisma/schema/agentic.prisma`) a person approves, made by `createAgentProposal` with the approver count pinned at the propose seam (`src/app-layer/usecases/agent-proposals.ts`); a proposal's `guardProvenance` defaults to `THIRD_PARTY_INGESTED`. |
| E | A peer-started run performs an external write to another system. | On `main`: an external write follows its connection's rung (`src/lib/integrations/external-write-ladder.ts`). At `AUTOMATIC` no person approves it; the arm requires an approved parameter set in force, each open value within its approved constraint, the target inside its population re-resolved at dispatch where the set has an open target, a nominated prior-state read, and room in the per-connection window (`openAutomaticExternalWrite` in `src/app-layer/usecases/external-write-automatic.ts`). Nothing on `main` tells a run a peer started from any other run. Required, 4b, by owner decision (2026-10-17): a run started by an inbound A2A task cannot dispatch an external write above `PROPOSE_ONLY`; on a connection at `AUTOMATIC`, its write is made an `EXTERNAL_WRITE` proposal a person approves rather than queued for unattended dispatch. See R17. |
| E | Delegation widens reach. | On `main`: depth one, and fan-out capped per turn (`gateDelegation` in `src/lib/agentic/flue/delegation-gate.ts`; `TenantSecuritySettings.agentMaxSubagentsPerTurn`, default 3). A specialist's tools and skills are an intersection of the parent's (`narrowTools`, `narrowSkills` in `src/lib/agentic/flue/subagents/index.ts`), and its answer is scanned (`guardDelegateAnswer` in `src/lib/agentic/flue/tools-adapter.ts`). |
| E | A peer uses Inflect's agent to reach a second peer. | Required, 4b: a run started by an inbound A2A task may not send an outbound A2A task, and every outbound journal row names the inbound task behind it. |
| T | Tool results carry instructions planted in tenant data. | On `main`: every result is scanned for injection and for secrets, and a flag parks the run for a person (`runGuardedTool` and `ReviewLatch` in `src/lib/agentic/flue/tools-adapter.ts`). |
| D | A runaway run. | On `main`: the policy card's `maxActionsPerRun` and `maxActionsPerDay` (`AgentPolicyCardVersion`, `prisma/schema/agentic.prisma`), the run caps (`src/lib/agentic/run-caps.ts`) and the behavioural circuit breaker (`src/lib/agentic/circuit-breaker.ts`). |
| I | The run reads another tenant's rows. | On `main`: row-level security bound per transaction (`runInTenantContext` in `src/lib/db-context.ts`; `docs/rls-tenant-isolation.md`), and every repository query filters by `tenantId`. |

### I5 — The answer goes back to the peer

Boundaries: TB1 (the response), TB3.

| STRIDE | Threat | Control |
|---|---|---|
| I | The answer carries more tenant data than the task needed, or a secret. | On `main`: what the run can read is bounded by its grants and its card's data rung, and `guardEgress` (`src/app-layer/ai/guard/index.ts`) scans for secrets and exfiltration markers. Required, 4b: the answer passes `guardEgress` before it leaves, and a block withholds it. |
| T | The answer reports a proposed change as made. | Required, 4b: the answer reports proposals as pending, never as committed, mirroring the wording every external write rung returns to the model in `src/lib/mcp/tools/external-tools.ts`. |
| I | A refusal tells the peer how Inflect is configured. | On `main`: funnel refusals name the tool and never the permission key or a hash (`src/lib/mcp/authorize.ts`). Required, 4b: the endpoint returns generic refusals and keeps the reason in the audit row. |
| R | The peer denies receiving the answer, or Inflect denies sending it. | Required, 4b: the answer is signed and the signature kept (see "Receipts on both sides"). |

## Outbound: an Inflect agent sends work to a peer

### O0 — Configuring the route to a peer

Boundary: TB7.

| STRIDE | Threat | Control |
|---|---|---|
| E | A peer becomes reachable without review. | On `main`, for every external tool: it is offered only when granted to the agent (`RegisteredAgentTool`, under `admin.agent_tool_exposure`), pinned by a named person (`approveExternalToolManifest`, under `admin.agent_registry`), on an enabled connection above `DISABLED` (`resolveGrantedExternalTools`). It can be granted only to an agent whose declared data axis reaches `EXTERNAL_EGRESS` (`assertGrantWithinDeclaredDataScope` in `src/app-layer/usecases/agent-tool-exposure.ts`) and called only under a policy card that permits that rung, the one `dataScopeForToolCall` assigns every external tool (`src/lib/mcp/tool-data-scope.ts`). Required, 4b: the send to a peer is an external tool on that path, offered only while the peer's card pin is current. |
| E | The write rung is raised quickly. | On `main`: one rung per widening, seven days at each rung above `DISABLED`, and evidence before leaving `DRY_RUN` or `PROPOSE_ONLY` (`refusalForMove`, `MODE_MIN_DAYS`, `MODE_MIN_EVIDENCE` in `src/lib/integrations/external-write-ladder.ts`). Moves are OWNER-only (`admin.tenant_lifecycle` on `src/app/api/t/[tenantSlug]/admin/external-write-policy/[connectionId]/route.ts`). |
| T | The endpoint is repointed while the stored credential is kept. | On `main`: `redirectsStoredCredential` (`src/app-layer/integrations/config-schema.ts`) refuses that update for an `mcp-server` connection's `url`. On `main` (2e): a peer's card URL and signing key cannot be updated at all (`UpdatePeerAgentSchema` in `src/app-layer/usecases/peer-agents.ts` has neither field), so a move is a new registration that starts unpinned, and the card's own endpoint sits inside the pin's endpoint hash. On `main` (2d): an endpoint change is a HIGH `ENDPOINT_CHANGED` finding raised by the weekly `integration-passport-sweep` (`planPassportFindings` in `src/lib/agentic/integration-passport-drift.ts`; `docs/integration-passport.md`, P1). |
| R | A configuration change goes unnoticed. | On `main`: each change is audited: `AGENT_TOOL_GRANTED` (`src/app-layer/usecases/agent-tool-exposure.ts`), `MCP_TOOL_MANIFEST_APPROVED` (`src/app-layer/usecases/mcp-tool-manifest.ts`), `EXTERNAL_WRITE_MODE_CHANGED` (`src/app-layer/usecases/external-write-policy.ts`), `EXTERNAL_PRIOR_STATE_READ_SET` and `EXTERNAL_PRIOR_STATE_READ_CLEARED` (`src/app-layer/usecases/external-prior-state-read.ts`), and `INTEGRATION_CONNECTION_OWNER_SET` (`src/app-layer/usecases/integration-passport.ts`). On `main`: the weekly `integration-passport-sweep` compares each `mcp-server` connection's passport with the last one emitted and raises a `Finding` for each change, assigned to the connection's accountable owner or, while it has none, owned by the tenant's OWNER role (`docs/integration-passport.md`). |

### O1 — Assembling the run's tools

Boundary: TB7 into the run.

| STRIDE | Threat | Control |
|---|---|---|
| T | The peer rewrites its card or skill text to steer Inflect's model (tool poisoning, OWASP ASI04). | On `main`, for MCP tools: verbatim description hashing, and refusal until a person re-approves (`src/lib/mcp/tool-manifest.ts`). On `main` (2e): pinning rules 1 to 6 for cards (`src/lib/agentic/peer-agent-card.ts`, `src/app-layer/usecases/peer-agents.ts`). Required, 4b: the send tool is not offered while the live card differs from the pin, and each send compares the card again (pinning rule 6), against a copy at most 15 minutes old, which is required on 4b by owner decision (2026-10-17; R18). |
| E | The set of reachable tools grows during a run. | On `main`: the offered set is a snapshot taken at assembly (`McpInvocation.offeredTools` in `src/lib/mcp/authorize.ts`; `src/lib/mcp/loadable-tools.ts`). |
| D | The peer is down and takes the run with it. | On `main`: an unreachable server loses its tools, not the run (`src/lib/mcp/tools/external-tools.ts`). |

### O2 — The call at the funnel

Boundary: TB4.

| STRIDE | Threat | Control |
|---|---|---|
| E | The agent sends without authority. | On `main`: `authorizeToolCall`, with external tools declared at autonomy rung 2 and requiring `admin.agent_external_tools` (`EXTERNAL_TOOL_PERMISSION` in `src/lib/mcp/tools/external-tools.ts`). |
| S | A stolen agent credential is used to send. | On `main`: liveness re-read on every call (`checkCredentialLiveness` in `src/lib/agentic/agent-credential-state.ts`), audience-bound exchanged tokens (`src/lib/mcp/token-exchange.ts`), and the kill switch at step 0. |
| R | A refused attempt leaves no trace. | On `main`: every refusal writes one hash-chained `AUTHZ_DENIED` row (`denyToolCall` in `src/lib/mcp/authorize.ts`). |

### O3 — Arguments and the write ladder

Boundaries: TB4 to TB5.

| STRIDE | Threat | Control |
|---|---|---|
| I | Tenant data leaves in the task text. | On `main`: `guardEgress` on the arguments before the funnel runs (`runGuardedTool`); `findInternalSecret` refuses a ciphertext envelope or an Inflect API key before a socket opens (`src/app-layer/integrations/mcp/egress-scan.ts`); approved parameter sets replace model-chosen arguments and bound any open field (`src/lib/integrations/parameter-constraints.ts`). |
| E | A send skips the ladder by being declared read-only. | On `main`: `declaresWrite` treats a tool that declares nothing as a write, but a tool declared read-only skips the write path (`src/lib/mcp/tool-write-classification.ts`). Required, 4b: every A2A send is a write whatever the peer declares, because it asks another organisation's agent to act. |
| T, R | A send happens with no record of what was sent or why. | On `main`: `DRY_RUN` journals the intent and sends nothing (`recordIntent` in `src/app-layer/usecases/external-write-journal.ts`); `PROPOSE_ONLY` makes an `EXTERNAL_WRITE` proposal a person approves; `AUTOMATIC` opens a journal row (`openAutomaticExternalWrite`) that only the dispatch pass sends (`src/app-layer/usecases/external-write-dispatch.ts`). The pass re-checks that the connection is enabled, that the row's rung is still permitted, that the pairing exists, and the drift or the bounds, before it sends. A write is refused when no prior-state read is nominated, and `ExternalWriteJournal.priorStateJson` cannot be null (`prisma/schema/agentic.prisma`). Required, 4b: the prior-state read for an A2A send (residual R9). |
| T | Each reply to a peer that asks for more input is sent unattended. | Required, 4b: every message Inflect sends within one task is its own call under the ladder. |

### O4 — The wire

Boundary: TB5.

| STRIDE | Threat | Control |
|---|---|---|
| S | DNS rebinding, a private address or a redirect sends the request elsewhere. | On `main`: `wirePost` refuses any scheme but `https:` (`WireSchemeRefusedError` in `src/lib/mcp/wire-transport.ts`) and, outside its test seam, reaches the network only through `safeFetch`. |
| D | A slow or very large reply holds a worker. | On `main`: the deadline covers the body as well as the head, and the body is read with a cap that aborts (`WireTimeoutError`, `WireCapExceededError`); the tools client uses `MCP_CALL_TIMEOUT_MS` (30 seconds) and `MCP_MAX_RESPONSE_BYTES` (1,000,000) in `src/app-layer/integrations/mcp/client.ts`. |
| I | A credential that works elsewhere is sent to the peer. | On `main`: a connection's credential is its own. Tokens minted for a connection are held in memory only (`src/app-layer/integrations/mcp/token.ts`), a stored bearer stays encrypted in that connection's `IntegrationConnection.secretEncrypted`, and an Inflect API key in the arguments is refused (`findInternalSecret` in `src/app-layer/integrations/mcp/egress-scan.ts`). Required, 4b: a credential per peer for outbound calls. |
| E | One client speaks both protocols. | On `main`: the legacy-access client keeps a closed method set (`CLIENT_METHODS` in `src/lib/mcp/client/index.ts`). Required, 4b: a third client over `wirePost` with its own closed A2A method set, so the A2A client cannot send `tools/*` and the MCP clients cannot send A2A methods. |

### O5 — The peer's reply

Boundary: TB3.

| STRIDE | Threat | Control |
|---|---|---|
| T | The reply carries instructions for Inflect's model. | On `main`: the result is scanned for injection and for secrets before the model sees it, a flag parks the run, and a tool this build does not define resolves to `THIRD_PARTY_INGESTED` (`src/lib/agentic/content-provenance.ts`). |
| S | The reply comes from an agent other than the pinned peer. | Required, 4b: replies are verified against the peer's registered signing key, and an unsigned or wrongly signed reply is refused. |
| D | The reply never comes. | On `main`: the deadline (`wirePost` in `src/lib/mcp/wire-transport.ts`), and the `INDETERMINATE` journal outcome for a send that did not report back (`ExternalWriteOutcome` in `prisma/schema/enums.prisma`). |

### O6 — Follow-up traffic: streams, callbacks and requests for input

Boundaries: TB1, TB5.

| STRIDE | Threat | Control |
|---|---|---|
| S, E | A push notification is a way into Inflect that bypasses the inbound hops. | Required, 4b: results are fetched through the one wire. Any callback 4b accepts arrives on the inbound endpoint and passes every inbound hop. |
| I | A peer-supplied push-notification URL makes Inflect dial an address the peer chose. | Required, 4b: Inflect never dials a URL a peer supplied, other than through `safeFetch` to the peer's registered endpoint host. |
| D | A stream is held open. | On `main`: the wire's deadline covers the whole body read (`wirePost` in `src/lib/mcp/wire-transport.ts`). |

## Receipts on both sides

| Side | Recorded on `main` | Required, 4b |
|---|---|---|
| Inbound | `WorkflowRun` (`triggeredViaKeyId`, `agentId`, `policyCardVersion`) and the `WorkflowStep` ledger with a guard verdict per step (`prisma/schema/agentic.prisma`), an `AiDecisionLog` row per model call (`prisma/schema/automation.prisma`), and the hash-chained audit trail (`src/app-layer/events/audit.ts`) | The peer's signed message, verified against its registered key and kept; Inflect's signed answer |
| Outbound | `ExternalWriteJournal` (arguments, prior state, rung, outcome, agent, run; `argumentsJson`, `priorStateJson` and `detail` encrypted at rest), the `WorkflowStep` row of kind `TOOL_CALL` with the arguments as dispatched, and the `AgentProposal` at `PROPOSE_ONLY` (all in `prisma/schema/agentic.prisma`); at `AUTOMATIC`, the `AiDecisionLog` row stamped `AUTONOMOUS` that `openAutomaticExternalWrite` writes in place of a proposal | Inflect's signed message; the peer's signed result, verified and kept |
| A mediator's receipt | `AgentActionReceipt` (`prisma/schema/automation.prisma`): Ed25519 verified in-app before the row is trusted (`src/lib/mcp/receipt-verification.ts`), with `toolProvenance = 'unattested'` for a tool this build does not define | The same verification over canonical JSON for A2A receipts |

Step 4b builds the signing. The custody of Inflect's signing key follows the key
decision in step 0e (#3664).

## Stopping a peer

On `main`, three kills exist: one agent, one tenant, the whole platform. Each is
read uncached at every tool call, and before the model is called on the agent
runtime (`src/lib/agentic/kill-switch.ts`, `src/lib/agentic/flue/execute.ts`).
The scheduled drill (`src/app-layer/jobs/agent-kill-switch-drill.ts`) exercises
all three, the agent scope end to end and the tenant and platform scopes against
their predicates, and records each run as an `AgentKillSwitchDrill` row. A
connection set to `isEnabled = false` or to the `DISABLED` rung is refused when a
run assembles its tools and by the dispatch pass before any pending write is
sent. Neither is re-read on each read call inside a run already assembled; the
agent kill is.

Required, 4b: a kill per peer, re-read at every inbound message and every
outbound send, that refuses the next message in either direction, is lifted only
by a person with a reason, and is exercised by the drill like the existing
scopes.

## Limits of controls this model relies on

These are properties of controls on `main` that A2A does not change. Each is
bounded by other controls. Where a bound holds only below a rung of the external
write ladder, the row says so and names what bounds the top rung.

| Limit | Bounded by |
|---|---|
| The injection scanner matches patterns. `startWorkflowRun` records that its test proves the wiring, not the scanner's accuracy. | Third-party content is data and never the instruction; a flag parks the run; every write to Inflect's data is a proposal a person approves. Below `AUTOMATIC` an external write sends nothing without a person: `DRY_RUN` sends nothing and `PROPOSE_ONLY` makes it a proposal a person approves. At `AUTOMATIC` it is bounded by the approved parameter set that must be in force, the constraints on its open values, the target population re-resolved at dispatch and the per-connection window, and step 4b is required, by owner decision (2026-10-17), to clamp a run an inbound task started to `PROPOSE_ONLY` (R17). |
| The egress scan is not a data-loss classifier. `findInternalSecret` refuses ciphertext envelopes and Inflect API keys only, and `guardEgress` adds pattern rules, so personal data in free text can leave in an argument. | The agent and its card must declare `EXTERNAL_EGRESS`; an approved parameter set, where one is in force, fixes or bounds the arguments, and at `AUTOMATIC` one must be in force (`openAutomaticExternalWrite`). Below `AUTOMATIC`, `PROPOSE_ONLY` puts a person in front of every send; at `AUTOMATIC` nobody reviews the send, and the parameter set is the bound. |
| The mutation rate limit is keyed by IP, with every caller anonymous to it. | The per-tenant budget and concurrency caps, once set: by owner decision (2026-10-17), 4b refuses inbound A2A for a tenant that has not set both; and the per-peer quota (R13). |

## Residual risks

This table is the worklist for steps 2e and 4b. Every Required control in the
hop tables, the pinning rules, the receipts table and "Stopping a peer" appears
in at least one row below. R15 (a connection change raising no finding with an
owner) and R16 (a connection with no accountable owner) were closed by step 2d,
which shipped the weekly integration passport and the connection owner; their
numbers are not reused. The controls in R13 (the tenant caps), R17 and R18
are required on 4b by owner decision (2026-10-17). R1 and R3 are closed, and
R2 is closed in part, by step 2e (#3673).

| # | Risk | Why it remains on `main` | Closed by |
|---|---|---|---|
| R1 | A peer has no record of its own: no owner, supplier, tier, endpoint, signing key, card pin or status. | **Closed by 2e (#3673).** `PeerAgent` holds each, under row-level security, tested across two tenants. | 2e: the peer record, with an accountable owner, a supplier and a risk tier (an unscored tier refuses admission), under row-level security, with a two-tenant test (I0 S, I2 I). |
| R2 | A peer's card is neither pinned nor compared. | **Closed in part by 2e (#3673):** the card is fetched, hashed, approved on the reviewed hash and compared by `checkPeerAdmission`. Nothing compares it before a message yet, because no message is exchanged. | 2e: the card fetched through `safeFetch` with an aborting byte cap and a deadline, registered as a sink in `tests/guards/ssrf-egress-coverage.test.ts`; hashing, approval on the reviewed hash, and refusal on change (pinning rules 1 to 8; I0 T, R, I, D). 4b: the comparison before every message in both directions (pinning rule 6; I2 S, O1 T), which refuses within 15 minutes of a change and is required by owner decision (2026-10-17; R18). |
| R3 | The key for the register and pin routes. Using the calling key to approve would let the authority that acts also configure. | **Closed by 2e (#3673).** The owner decided it on 2026-10-18 as this model recommended: `admin.agent_registry` for registering and pinning, and `admin.agent_external_tools` stays the key for the call. | 2e: each route carries a literal `requirePermission('admin.agent_registry')` (I0 E). |
| R4 | The inbound endpoint and its edge handling. | No endpoint exists. | 4b: an endpoint that refuses any request whose credential does not resolve to an active peer with a current card pin, with its own recogniser that leaves `matchTenantApiKeyRequest` unchanged, per-message signatures over https, replay refusal, and a byte cap before the body is parsed (I1 S, T, I, D). |
| R5 | The inbound credential and its binding to the receiving agent. | No inbound peer credential exists. | 4b: a credential per peer, hashed at rest, revocable, re-checked on every message, bound to the receiving registered agent and resolved through `resolveAgentAuthority` (I2 S, E). |
| R6 | A peer choosing which workflow runs. | No inbound path exists. | 4b: a workflow allowlist per peer (I2 E). |
| R7 | Inbound task text reaching a model as anything other than labelled data. | No inbound path exists; run input is not part of `runMessage` today. | 4b: the third-party provenance envelope (I3 T). |
| R8 | An outbound A2A client. | The wire speaks MCP JSON-RPC only, through two clients. | 4b: the send offered as an external tool on the existing path only while the peer's card pin is current (O0 E), over a third client on `wirePost` with a closed A2A method set (O4 E). |
| R9 | Every A2A send treated as a write, and what its prior state is. | The prior-state rule assumes a write replaces an object; an A2A task creates work at the peer instead. | 4b: every send is a write whatever the peer declares (O3 E); 4b names what is read before a send (for example the pinned card hash and the task's context) so the journal row is never blind (O3 T, R). |
| R10 | Addresses a peer supplies, and traffic it starts: file URIs, push-notification URLs and callbacks. | No A2A parsing exists. | 4b: a URI or URL a peer supplies is refused, or fetched only through `safeFetch` to the registered host, with a byte cap and labelled third-party (I3 I, O6 I). Results are fetched through the one wire, and any callback 4b accepts arrives on the inbound endpoint and passes every inbound hop (O6 S, E). |
| R11 | A kill per peer. | Kills exist per agent, tenant and platform; connection state is read at assembly and dispatch only. | 4b: a per-peer kill checked at admission and re-read on every message in both directions, lifted only by a person with a reason, and drilled (I2 E, "Stopping a peer"). |
| R12 | Signed receipts across organisations, and attribution of a run to a peer. | Only mediator receipts are verified today, and a run records the key and agent that started it, not a peer. | 4b: sign and verify every task, answer and result, and keep both sides' signatures (I5 R, O5 S, "Receipts on both sides"); record the peer and the verified inbound message against the run (I2 R). |
| R13 | A quota per peer, and tenant caps that default to none. | The rate limit is keyed by IP, and `agentMonthlyTokenBudget` and `agentMaxConcurrentRuns` are NULL, meaning no cap, until a tenant sets them. | 4b: a message quota per peer at the inbound endpoint (I1 D, I2 D). 4b, by owner decision (2026-10-17): inbound A2A refused for a tenant that has not set both caps (I2 D). |
| R14 | Chaining: a peer uses Inflect's agent to reach a second peer. | No A2A traffic exists. | 4b: no outbound A2A send from a run an inbound task started, and attribution on every journal row (I4 E). |
| R17 | A run an inbound task started causes an unattended write to another system. | At `AUTOMATIC` an external write is sent by the dispatch pass with no person, and nothing tells a run a peer started from any other run. The parameter set, the value constraints, the target population and the per-connection window still bound it. | 4b, by owner decision (2026-10-17): a run started by an inbound A2A task cannot dispatch an external write above `PROPOSE_ONLY`; on an `AUTOMATIC` connection its write becomes an `EXTERNAL_WRITE` proposal a person approves (I4 E). |
| R18 | Between a peer changing its card and the next comparison, its messages are still admitted and sent. | No card is compared today. Comparing a freshly fetched card on every message would fetch the card on every message, so pinning rule 6 compares a copy at most 15 minutes old. | 4b, by owner decision (2026-10-17): the card is re-checked before every message against a copy at most 15 minutes old, which bounds the window to 15 minutes, and a message is refused when no copy that fresh can be fetched. A change made inside the window is still admitted and sent until the next comparison; the 15-minute bound is the owner's decision. |
| R19 | Inflect's own published card discloses what a tenant runs. | Inflect publishes no card. | 4b: a card only for an agent a tenant enables for A2A, carrying no tenant data and no tool names (I1 I). |
| R20 | A very large inbound task. | No inbound path exists. | 4b: a size cap on the run input before it is scanned (I3 D). |
| R21 | The answer to a peer: what it carries, what it claims, and what a refusal reveals. | No answer is sent today. | 4b: the answer passes `guardEgress` before it leaves and a block withholds it (I5 I); it reports proposals as pending, never as committed (I5 T); refusals are generic and the reason stays in the audit row (I5 I). |
| R22 | A peer's endpoint repointed while its stored credential is kept. | **Closed by 2e (#3673) for the peer record:** a peer's card URL and signing key cannot be updated, so a move is a new, unpinned registration, and the card's own endpoint is inside the pinned endpoint hash. The credential 4b issues per peer does not exist yet. | 2e: the same refusal for a peer's endpoint (O0 T). 2d: an endpoint change is a HIGH passport finding (P1). |
| R23 | Replies to a peer that asks for more input sent as one approved call. | No A2A task has a lifecycle in Inflect. | 4b: every message Inflect sends within one task is its own call under the ladder (O3 T). |
| R24 | One credential presented to several peers. | No outbound A2A client exists. | 4b: a credential per peer for outbound calls (O4 I). |
