# A2A threat model

A2A (Agent2Agent) is the protocol the owner chose for Inflect's agents to
exchange work with agents in other organisations. The owner settled it on
2026-10-17 (decision 4 in [`docs/agentic-iam-roadmap.md`](agentic-iam-roadmap.md)):
peers use A2A from the start, through the existing authority funnel, and each
peer's agent card is pinned by hash and re-approved when it changes.

This document models that traffic in both directions, hop by hop. On `main`
there is a peer register with card pinning (step 2e, #3673), and since step 4b
(#3679) an inbound A2A endpoint and an outbound A2A client, built against an
in-process fake peer; no real vendor's agent has exchanged a task yet, and that
pilot is the step's open exit criterion. The mapping onto the funnel is
[`docs/a2a-mapping.md`](a2a-mapping.md). For every hop it names the trust
boundary, the STRIDE threats and the control. Each control is in one of two
states:

- **On `main`**, cited by file and symbol. It holds today and A2A traffic must
  pass through it. A control step 4b built is marked **On `main` (4b)**.
- **Required**, with the step that builds it. No control is in this state: the
  last one, Inflect's own published agent card (R19), is on `main` since #3742.
  The controls this model assigned to **2d** (the integration passport, #3672)
  and **2e** are on `main` and are cited as such.

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

On 2026-10-19, at step 4b, the owner decided four more:

- **A peer is the customer's own vendor, not Inflect's sub-processor.** The
  tenant registers a peer, pins its card and chooses what its agents send it, so
  the processing relationship is the tenant's with its counterparty. Inflect
  carries the traffic on the tenant's instruction, as it carries an MCP call to
  a server the tenant connected (`docs/sub-processors.md`).
- **Each tenant signs with its own key.** The Ed25519 key is per tenant, held in
  `TenantA2aSigningKey` with its seed encrypted under the tenant's DEK, and
  generated or rotated only by an OWNER; there is no deployment-wide key.
- **Retiring an agent revokes the inbound credentials bound to it**, in the
  retirement cascade's transaction.
- **The per-peer quota is the peer's own** (`PeerAgent.inboundMessagesPerHour`,
  default 60, held to 1..1000), set with the register key. The receipt clock
  window stays a constant, five minutes either way.

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
  task started is told apart (`WorkflowRun.inboundPeerId`, carried as
  `RequestContext.a2aInbound`), and its external writes are held at
  `PROPOSE_ONLY` by owner decision (2026-10-17); see I4 and residual R17.

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

   **The same rule binds the other side, about Inflect's card (#3742).** Each
   tenant publishes its own card (`GET /api/a2a/:tenantSlug/agent-card.json`,
   `src/lib/agentic/a2a/own-card.ts`), and a peer pins it as Inflect pins the
   peer's. A key rotation changes the card, and so does the end of a rotation's
   seven-day grace period, when the previous key drops off it. Either change is
   one the PEER re-approves before it sends again: Inflect cannot re-approve on
   a peer's behalf, and a peer that went on trusting a changed card would be
   trusting whoever changed it. The card is deterministic — the same keys give
   the same bytes — so nothing else changes it, and a peer is never asked to
   re-approve a card that did not move.
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
| S | An unregistered agent sends a task. | On `main` (4b): the endpoint `POST /api/a2a/:tenantSlug/peers/:peerId` refuses any request whose credential does not resolve to the live `iflp_` credential of a registered peer of that tenant, or whose peer has no current card pin (`handleInboundA2a` in `src/app-layer/usecases/a2a-inbound.ts`). On `main` (#3742): the per-tenant endpoint the card names, `POST /api/a2a/:tenantSlug`, finds the peer from the SHA-256 of its bearer through a unique index (`findPeerIdByInboundToken`) and then admits it through the same function, in the same order and with the same refusals. A bearer no credential hashes to is refused, with an `AUTHZ_DENIED` row against the tenant. |
| T | A message is altered in transit or replayed. | On `main` (4b): https at the deployment's edge, and an `inflect-a2a-receipt/1` signature over each message by the peer's REGISTERED key, Ed25519 over the canonical JSON of a statement carrying the SHA-256 of the exact body, through the same `receiptSignedMessage` `verifyReceiptSignature` uses (`src/lib/agentic/a2a/receipt.ts`). The statement names this tenant as recipient — by its card URL since #3742, the same for every peer, with the peer named as sender, so a message signed for one tenant verifies at no other and a message from one peer verifies as no other's — and is refused outside a five-minute clock window; a message id seen before from that peer is refused by the unique index the receipt is written under (`PeerAgentMessage`). |
| I | Inflect's own card discloses what a tenant runs. | On `main` (#3742): one card per tenant, served only while the tenant holds a signing key — which is what enabling A2A means — so a tenant that never set A2A up has none. It names the per-tenant endpoint, the identity, the receipt format and the public keys, and nothing else: no agent list (`skills` is always empty), no tool or workflow name, no tenant name. `CARD_MEMBERS` fixes its members, verification refuses any other, and a test asserts the strings of the whole document. Every reason there is no card — an unknown slug, no key, no public origin — is one 404, so the route is no oracle for which tenants exist or use A2A. Signed by the key in force (`signInflectAgentCard`). |
| I | A new credential type widens the edge's carve-out. | On `main`: the edge lets `/api/t/**` with an `iflk_` bearer fall through to the handler, and `matchTenantApiKeyRequest` (`src/lib/auth/guard.ts`) is deliberately narrow because the fall-through also skips the admin-role and MFA gates. On `main` (4b): the A2A endpoint is its own entry in `MACHINE_CALLER_PREFIXES`, outside `/api/t/**`, and its credential has its own `iflp_` prefix, so neither `matchTenantApiKeyRequest` nor `verifyApiKey` ever sees it; the handler, not the edge, decides whether it is real. |
| D | A flood of tasks. | On `main`: `withApiErrorHandling` applies `API_MUTATION_LIMIT` to every POST (`src/lib/security/rate-limit.ts`, `src/lib/security/rate-limit-middleware.ts`), keyed by IP. On `main` (4b): a quota per peer, `PeerAgent.inboundMessagesPerHour` (default 60, a CHECK holds it to 1..1000, set with the register key), counted from the peer's kept receipts, because an IP key cannot tell two peers behind one gateway apart. |
| D | An oversized body. | On `main` (4b): `A2A_MAX_BODY_BYTES` (64 KiB), refused on a declared length and again while the body streams, before it is parsed (the route). |

### I2 — Authentication and admission

Boundaries: TB2, TB6.

| STRIDE | Threat | Control |
|---|---|---|
| S | A peer presents a leaked or another peer's credential. | On `main` (4b): `PeerAgentInboundCredential`, issued per peer by a person, stored as SHA-256 as `TenantApiKey.keyHash` is, revocable (one-way), compared in constant time on every message (`matchPeerInboundCredential`), and always paired with the per-message signature by the peer's registered key, so a leaked bearer alone admits nothing. |
| S | The peer's card changed since it was pinned. | On `main` (2e): `checkPeerAdmission` reads the live card and refuses a peer whose card differs from its pin (pinning rule 6). On `main` (4b): `admitPeerMessage` applies the same rule before every message in both directions, against a copy at most 15 minutes old (`recentAgentCard`, `A2A_CARD_MAX_AGE_MS`), fetching one when none is held and refusing when the fetch fails (owner decision 2026-10-17; R18). |
| E | The peer gains authority of its own. | On `main` (4b): the inbound credential is bound to ONE receiving registered agent, as `TenantApiKey.agentId` binds a key. The run it starts is that agent's, through `startWorkflowRun` and the funnel, with the peer's accountable owner as the principal, resolved by `resolveTenantContext` — the membership check `resolveAgentAuthority` makes — so a departed owner's peer is refused (`OWNER_UNRESOLVED`, and before that `PEER_OWNER_INACTIVE` at admission). The credential carries no scope of its own, so there is nothing to intersect. |
| E | The peer chooses which work runs. | On `main`: workflow definitions are code (`src/lib/agentic/workflow-registry.ts`). On `main` (4b): the credential's `workflowKeys` allowlist; a task naming any other workflow is refused (`WORKFLOW_NOT_ALLOWED`), and a data part may supply only the inputs the workflow declares. |
| E | A stopped agent receives work. | On `main`: `resolveKillState` (`src/lib/agentic/kill-switch.ts`) is read uncached before the model is called on the agent runtime (`src/lib/agentic/flue/execute.ts`) and as step 0 of every tool call; the registration gate refuses an agent that is not ACTIVE when `TenantSecuritySettings.requireRegisteredAgent` is on, which is the default. On `main` (4b): the per-peer kill (`PeerAgentKillSwitch`, `resolvePeerKill`) is read uncached before the credential, and the receiving agent's own kill and breaker are read before its run is created. |
| I | A peer registered by one tenant reaches another. | On `main`: `getTenantCtx` refuses a key whose tenant is not the URL's tenant (`src/app-layer/context.ts`), and every tenant table carries row-level security (`docs/rls-tenant-isolation.md`). On `main` (2e): `PeerAgent` under row-level security with `FORCE`, tested across two tenants under `app_user` (`tests/integration/peer-agents.test.ts`). |
| D | Peers exhaust a tenant's capacity. | On `main`: `assertWithinMonthlyBudget` (`src/lib/agentic/monthly-budget-policy.ts`) and `assertWithinConcurrencyCap` (`src/lib/agentic/run-concurrency-policy.ts`) refuse before the run row exists. Both columns, `agentMonthlyTokenBudget` and `agentMaxConcurrentRuns`, are nullable and NULL means no cap (`TenantSecuritySettings`, `prisma/schema/auth.prisma`). On `main` (4b): the per-peer message quota, and, by owner decision (2026-10-17), inbound A2A refused for a tenant that has not set both caps (`TENANT_CAPS_UNSET`; R13). A person holding `admin.agent_registry` sets both on the agents page: the concurrency cap at `…/admin/agents/concurrency` and the monthly budget at `…/admin/agents/budget` (#3777), each audited with both values. |
| R | Nobody can say which peer started a run. | On `main`: `WorkflowRun.triggeredViaKeyId` and `WorkflowRun.agentId` (`prisma/schema/agentic.prisma`). On `main` (4b): `WorkflowRun.inboundPeerId` and `inboundMessageId`, the peer and the verified, kept message that started the run, written once at creation (trigger), and a `PEER_AGENT_TASK_ADMITTED` audit row. |

### I3 — The task becomes run input

Boundary: TB3.

| STRIDE | Threat | Control |
|---|---|---|
| T | Instructions in the task steer the receiving agent. | On `main`: the run's input is scanned before the run row exists, and both a flag and a block refuse (`guardUntrustedInput` and `assertNoReviewRequired` in `startWorkflowRun`, `src/app-layer/usecases/workflow-runs.ts`). On the agent runtime the model's message is built from the workflow definition's description and remaining steps (`runMessage` in `src/lib/agentic/flue/execute.ts`), not from the run input; the static engine calls no model. Content of unknown origin resolves to `THIRD_PARTY_INGESTED`, and only `SYSTEM` content may carry instruction (`resolveContentProvenance`, `mayCarryInstruction`, `src/lib/agentic/content-provenance.ts`). On `main` (4b): the task's text enters the run input only inside an envelope labelled `THIRD_PARTY_INGESTED` from the source `a2a.peer-task`, with `mayCarryInstruction: false`, and the whole input is scanned by `startWorkflowRun` before the run row exists; a flag or a block refuses (`GUARD_REFUSED`) and no run is created. The Flue run message carries only a definition's declared inputs, fenced and labelled, so the free task text is never the instruction. |
| T | A required input is missing or blank. | On `main`: `assertRequiredInputPresent` (`src/app-layer/usecases/workflow-runs.ts`). |
| I | A file part's URI makes Inflect dial an address the peer chose. | On `main` (4b): every file part is refused (`FILE_PART_REFUSED`, `parseA2aInboundRequest`); nothing a peer names is fetched. |
| D | A very large task. | On `main` (4b): the body cap above, and `A2A_MAX_TEXT_CHARS` (16,000) over the task's text and a flat map of at most 16 short strings for its data, before it is scanned. |

### I4 — Execution inside Inflect

Boundaries: TB4, TB6.

| STRIDE | Threat | Control |
|---|---|---|
| E | The run reaches a tool the receiving agent was not granted. | On `main`: `authorizeToolCall` on every call, deny by default (`src/lib/mcp/authorize.ts`). The peer adds no term to it. |
| E | The run changes Inflect's data. | On `main`: propose, not commit. A write is an `AgentProposal` (`prisma/schema/agentic.prisma`) a person approves, made by `createAgentProposal` with the approver count pinned at the propose seam (`src/app-layer/usecases/agent-proposals.ts`); a proposal's `guardProvenance` defaults to `THIRD_PARTY_INGESTED`. |
| E | A peer-started run performs an external write to another system. | On `main`: an external write follows its connection's rung (`src/lib/integrations/external-write-ladder.ts`). At `AUTOMATIC` no person approves it; the arm requires an approved parameter set in force, each open value within its approved constraint, the target inside its population re-resolved at dispatch where the set has an open target, a nominated prior-state read, and room in the per-connection window (`openAutomaticExternalWrite` in `src/app-layer/usecases/external-write-automatic.ts`). On `main` (4b), by owner decision (2026-10-17): a run started by an inbound A2A task carries `RequestContext.a2aInbound`, restored from the run's write-once columns on every segment by `executeFrom`, and `clampForInboundA2a` (`INBOUND_A2A_MAX_MODE`, `src/lib/integrations/external-write-ladder.ts`) narrows its external writes to `PROPOSE_ONLY`: on a connection at `AUTOMATIC` the write becomes an `EXTERNAL_WRITE` proposal a person approves, and the approved write opens at `PROPOSE_ONLY` (`openApprovedExternalWrite`). See R17. |
| E | Delegation widens reach. | On `main`: depth one, and fan-out capped per turn (`gateDelegation` in `src/lib/agentic/flue/delegation-gate.ts`; `TenantSecuritySettings.agentMaxSubagentsPerTurn`, default 3). A specialist's tools and skills are an intersection of the parent's (`narrowTools`, `narrowSkills` in `src/lib/agentic/flue/subagents/index.ts`), and its answer is scanned (`guardDelegateAnswer` in `src/lib/agentic/flue/tools-adapter.ts`). |
| E | A peer uses Inflect's agent to reach a second peer. | On `main` (4b): a run started by an inbound A2A task is offered no send tool, is refused one at the call, and a journal row whose run a peer started is refused at the send (`resolveGrantedA2aSendTools`, `dispatchA2aSend`, `sendA2aJournalRow`). With no such send possible, no outbound journal row has an inbound task behind it to name. |
| T | Tool results carry instructions planted in tenant data. | On `main`: every result is scanned for injection and for secrets, and a flag parks the run for a person (`runGuardedTool` and `ReviewLatch` in `src/lib/agentic/flue/tools-adapter.ts`). |
| D | A runaway run. | On `main`: the policy card's `maxActionsPerRun` and `maxActionsPerDay` (`AgentPolicyCardVersion`, `prisma/schema/agentic.prisma`), the run caps (`src/lib/agentic/run-caps.ts`) and the behavioural circuit breaker (`src/lib/agentic/circuit-breaker.ts`). |
| I | The run reads another tenant's rows. | On `main`: row-level security bound per transaction (`runInTenantContext` in `src/lib/db-context.ts`; `docs/rls-tenant-isolation.md`), and every repository query filters by `tenantId`. |

### I5 — The answer goes back to the peer

Boundaries: TB1 (the response), TB3.

| STRIDE | Threat | Control |
|---|---|---|
| I | The answer carries more tenant data than the task needed, or a secret. | On `main`: what the run can read is bounded by its grants and its card's data rung, and `guardEgress` (`src/app-layer/ai/guard/index.ts`) scans for secrets and exfiltration markers. On `main` (4b): the answer is the task's state and the run's proposals by id, kind and status — no tenant content — and it passes `guardEgress` before it leaves; a flag or a block withholds its artefact. |
| T | The answer reports a proposed change as made. | On `main` (4b): the answer lists proposals by status and says that a PENDING proposal has changed nothing; a run waiting on a person here is reported `working`. |
| I | A refusal tells the peer how Inflect is configured. | On `main`: funnel refusals name the tool and never the permission key or a hash (`src/lib/mcp/authorize.ts`). On `main` (4b): every inbound refusal returns one generic JSON-RPC error, whatever the reason, and the reason goes to an `AUTHZ_DENIED` row and the `agentic.a2a.message` metric. |
| R | The peer denies receiving the answer, or Inflect denies sending it. | On `main` (4b): the answer is signed with the tenant's own key, its receipt names the task it answers, and both are kept (see "Receipts on both sides"). |

## Outbound: an Inflect agent sends work to a peer

### O0 — Configuring the route to a peer

Boundary: TB7.

| STRIDE | Threat | Control |
|---|---|---|
| E | A peer becomes reachable without review. | On `main`, for every external tool: it is offered only when granted to the agent (`RegisteredAgentTool`, under `admin.agent_tool_exposure`), pinned by a named person (`approveExternalToolManifest`, under `admin.agent_registry`), on an enabled connection above `DISABLED` (`resolveGrantedExternalTools`). It can be granted only to an agent whose declared data axis reaches `EXTERNAL_EGRESS` (`assertGrantWithinDeclaredDataScope` in `src/app-layer/usecases/agent-tool-exposure.ts`) and called only under a policy card that permits that rung, the one `dataScopeForToolCall` assigns every external tool (`src/lib/mcp/tool-data-scope.ts`). On `main` (4b): the send to a peer is the external tool `mcp__<connectionId>__a2a_send_task` of an `a2a-peer` connection, on that path. It is grantable only while the connection names a peer a person has pinned, and offered only while that peer is admitted against a card copy at most 15 minutes old and no kill is in force (`resolveGrantedA2aSendTools`). Its definition is Inflect's own and constant, so no card text reaches the model. |
| E | The write rung is raised quickly. | On `main`: one rung per widening, seven days at each rung above `DISABLED`, and evidence before leaving `DRY_RUN` or `PROPOSE_ONLY` (`refusalForMove`, `MODE_MIN_DAYS`, `MODE_MIN_EVIDENCE` in `src/lib/integrations/external-write-ladder.ts`). Moves are OWNER-only (`admin.tenant_lifecycle` on `src/app/api/t/[tenantSlug]/admin/external-write-policy/[connectionId]/route.ts`). |
| T | The endpoint is repointed while the stored credential is kept. | On `main`: `redirectsStoredCredential` (`src/app-layer/integrations/config-schema.ts`) refuses that update for an `mcp-server` connection's `url`. On `main` (2e): a peer's card URL and signing key cannot be updated at all (`UpdatePeerAgentSchema` in `src/app-layer/usecases/peer-agents.ts` has neither field), so a move is a new registration that starts unpinned, and the card's own endpoint sits inside the pin's endpoint hash. On `main` (4b): the `a2a-peer` connection holds no endpoint at all — a send goes to the `url` of the admitted card — and its `peerId` is an origin field (`peerReference` in `CONFIG_FIELD_RULES`), so repointing it while keeping the stored credential is refused by `redirectsStoredCredential`. On `main` (2d): an endpoint change is a HIGH `ENDPOINT_CHANGED` finding raised by the weekly `integration-passport-sweep` (`planPassportFindings` in `src/lib/agentic/integration-passport-drift.ts`; `docs/integration-passport.md`, P1). |
| R | A configuration change goes unnoticed. | On `main`: each change is audited: `AGENT_TOOL_GRANTED` (`src/app-layer/usecases/agent-tool-exposure.ts`), `MCP_TOOL_MANIFEST_APPROVED` (`src/app-layer/usecases/mcp-tool-manifest.ts`), `EXTERNAL_WRITE_MODE_CHANGED` (`src/app-layer/usecases/external-write-policy.ts`), `EXTERNAL_PRIOR_STATE_READ_SET` and `EXTERNAL_PRIOR_STATE_READ_CLEARED` (`src/app-layer/usecases/external-prior-state-read.ts`), and `INTEGRATION_CONNECTION_OWNER_SET` (`src/app-layer/usecases/integration-passport.ts`). On `main`: the weekly `integration-passport-sweep` compares each `mcp-server` connection's passport with the last one emitted and raises a `Finding` for each change, assigned to the connection's accountable owner or, while it has none, owned by the tenant's OWNER role (`docs/integration-passport.md`). |

### O1 — Assembling the run's tools

Boundary: TB7 into the run.

| STRIDE | Threat | Control |
|---|---|---|
| T | The peer rewrites its card or skill text to steer Inflect's model (tool poisoning, OWASP ASI04). | On `main`, for MCP tools: verbatim description hashing, and refusal until a person re-approves (`src/lib/mcp/tool-manifest.ts`). On `main` (2e): pinning rules 1 to 6 for cards (`src/lib/agentic/peer-agent-card.ts`, `src/app-layer/usecases/peer-agents.ts`). On `main` (4b): the send tool is not offered while the card differs from the pin, the call and the dispatch pass compare it again, each against a copy at most 15 minutes old (owner decision 2026-10-17; R18), and no card text is shown to the model at all. |
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
| E | A send skips the ladder by being declared read-only. | On `main`: `declaresWrite` treats a tool that declares nothing as a write, but a tool declared read-only skips the write path (`src/lib/mcp/tool-write-classification.ts`). On `main` (4b): an A2A send leaves `adapterFor` for the ladder (`dispatchA2aSend`) before the read/write branch is reached, so it is a write whatever any definition declares. |
| T, R | A send happens with no record of what was sent or why. | On `main`: `DRY_RUN` journals the intent and sends nothing (`recordIntent` in `src/app-layer/usecases/external-write-journal.ts`); `PROPOSE_ONLY` makes an `EXTERNAL_WRITE` proposal a person approves; `AUTOMATIC` opens a journal row (`openAutomaticExternalWrite`) that only the dispatch pass sends (`src/app-layer/usecases/external-write-dispatch.ts`). The pass re-checks that the connection is enabled, that the row's rung is still permitted, that the pairing exists, and the drift or the bounds, before it sends. A write is refused when no prior-state read is nominated, and `ExternalWriteJournal.priorStateJson` cannot be null (`prisma/schema/agentic.prisma`). On `main` (4b): an A2A send's prior state is the basis it was authorised on — the peer, the pinned card hash and endpoint hash, the pin's revision, and the conversation it continues (`a2aSendPriorState`) — journalled at every rung; the dispatch pass recomputes it and refuses a row whose basis moved, so a card re-approved between the decision and the send stops the send (R9). |
| T | Each reply to a peer that asks for more input is sent unattended. | On `main` (4b): every message is its own call of the send tool, continuing a task by its `taskId`, and each goes through the ladder on its own. |

### O4 — The wire

Boundary: TB5.

| STRIDE | Threat | Control |
|---|---|---|
| S | DNS rebinding, a private address or a redirect sends the request elsewhere. | On `main`: `wirePost` refuses any scheme but `https:` (`WireSchemeRefusedError` in `src/lib/mcp/wire-transport.ts`) and, outside its test seam, reaches the network only through `safeFetch`. |
| D | A slow or very large reply holds a worker. | On `main`: the deadline covers the body as well as the head, and the body is read with a cap that aborts (`WireTimeoutError`, `WireCapExceededError`); the tools client uses `MCP_CALL_TIMEOUT_MS` (30 seconds) and `MCP_MAX_RESPONSE_BYTES` (1,000,000) in `src/app-layer/integrations/mcp/client.ts`. |
| I | A credential that works elsewhere is sent to the peer. | On `main`: a connection's credential is its own. Tokens minted for a connection are held in memory only (`src/app-layer/integrations/mcp/token.ts`), a stored bearer stays encrypted in that connection's `IntegrationConnection.secretEncrypted`, and an Inflect API key in the arguments is refused (`findInternalSecret` in `src/app-layer/integrations/mcp/egress-scan.ts`). On `main` (4b): the credential a peer issued Inflect is the secret of that peer's own `a2a-peer` connection, and `findInternalSecret` also refuses an `iflp_` peer credential. |
| E | One client speaks both protocols. | On `main`: the legacy-access client keeps a closed method set (`CLIENT_METHODS` in `src/lib/mcp/client/index.ts`). On `main` (4b): the A2A client (`src/lib/agentic/a2a/client.ts`) is the third client over `wirePost`, with its own closed method set (`A2A_CLIENT_METHODS`: `message/send`, and since #3743 `tasks/get`, a read), and `tests/guards/ssrf-egress-coverage.test.ts` holds it to no fetch call of its own. |

### O5 — The peer's reply

Boundary: TB3.

| STRIDE | Threat | Control |
|---|---|---|
| T | The reply carries instructions for Inflect's model. | On `main`: the result is scanned for injection and for secrets before the model sees it, a flag parks the run, and a tool this build does not define resolves to `THIRD_PARTY_INGESTED` (`src/lib/agentic/content-provenance.ts`). |
| S | The reply comes from an agent other than the pinned peer. | On `main` (4b): the reply's receipt is verified against the peer's registered key, as a RESULT naming Inflect's identity (the tenant's card URL since #3742) as recipient and answering the task's message id, over the digest of the exact reply body. An unsigned, wrongly signed or altered reply is discarded, not kept, and the journal row settles `INDETERMINATE`. |
| D | The reply never comes. | On `main`: the deadline (`wirePost` in `src/lib/mcp/wire-transport.ts`), and the `INDETERMINATE` journal outcome for a send that did not report back (`ExternalWriteOutcome` in `prisma/schema/enums.prisma`). |
| R | A task the peer accepted is never known to have finished. | On `main` (#3743): the reconcile pass asks after every `ACCEPTED` send with a signed `tasks/get`, on the same rails as the send. It checks the peer's kill, the card admission and the basis the write was authorised on, and keeps the request and the answer as receipts (`pollAcceptedA2aSend` in `src/app-layer/usecases/a2a-outbound.ts`). Only a signed, verified report settles the row: `completed` promotes it to `APPLIED`; `failed`, `canceled`, `rejected` or an answer that does not verify settles it `INDETERMINATE`; a running task stays `ACCEPTED`, with when it was asked and for how long it has been accepted. A row is asked at most every quarter of its age, between ten minutes and six hours, because every poll is two receipts and counts against the peer's quota. |

### O6 — Follow-up traffic: streams, callbacks and requests for input

Boundaries: TB1, TB5.

| STRIDE | Threat | Control |
|---|---|---|
| S, E | A push notification is a way into Inflect that bypasses the inbound hops. | On `main` (4b): results come back on the send itself, through the one wire, and no callback is accepted: an inbound task carrying a push-notification configuration is refused, and the inbound endpoint is the only way in. |
| I | A peer-supplied push-notification URL makes Inflect dial an address the peer chose. | On `main` (4b): Inflect dials no URL a peer supplied. Sends go only to the endpoint in the admitted card, through `safeFetch`. |
| D | A stream is held open. | On `main`: the wire's deadline covers the whole body read (`wirePost` in `src/lib/mcp/wire-transport.ts`). |

## Receipts on both sides

| Side | Recorded on `main` |
|---|---|
| Inbound | `WorkflowRun` (`triggeredViaKeyId`, `agentId`, `policyCardVersion`, and since 4b `inboundPeerId` and `inboundMessageId`) and the `WorkflowStep` ledger with a guard verdict per step (`prisma/schema/agentic.prisma`), an `AiDecisionLog` row per model call (`prisma/schema/automation.prisma`), and the hash-chained audit trail (`src/app-layer/events/audit.ts`). On `main` (4b): the peer's signed message, verified against its registered key and kept, and Inflect's signed answer, kept (`PeerAgentMessage`) |
| Outbound | `ExternalWriteJournal` (arguments, prior state, rung, outcome, agent, run; `argumentsJson`, `priorStateJson` and `detail` encrypted at rest), the `WorkflowStep` row of kind `TOOL_CALL` with the arguments as dispatched, and the `AgentProposal` at `PROPOSE_ONLY` (all in `prisma/schema/agentic.prisma`); at `AUTOMATIC`, the `AiDecisionLog` row stamped `AUTONOMOUS` that `openAutomaticExternalWrite` writes in place of a proposal. On `main` (4b): Inflect's signed task, kept before it leaves, and the peer's signed result, verified and kept, both keyed to the journal row |
| A mediator's receipt | `AgentActionReceipt` (`prisma/schema/automation.prisma`): Ed25519 verified in-app before the row is trusted (`src/lib/mcp/receipt-verification.ts`), with `toolProvenance = 'unattested'` for a tool this build does not define. On `main` (4b): A2A receipts are verified through the same canonical form (`receiptSignedMessage`) |

Every A2A receipt row keeps the statement, the signature, the exact body, and
the public key it verifies under, bound by the key id (fingerprint) the row
names, so `verifyStoredA2aReceipt` re-derives it from the row alone; rows are
write-once and the purge retains them.

Each tenant signs with its own Ed25519 key (owner decision 2026-10-19),
`TenantA2aSigningKey`: the seed is encrypted under the tenant's DEK through the
Epic B manifest and never leaves the usecase that signs with it, and the public
key and its fingerprint are handed to peers. Generating and rotating it take
`admin.tenant_lifecycle`, the OWNER key that rotates the tenant's DEK, and are
refused to an API key and audited. A rotation retires the key in force, clears
its seed and keeps its public half, so a receipt signed before it still
verifies by the key id it names. A tenant with no key refuses A2A in both
directions with `NO_SIGNING_KEY`; inbound asks only after the peer has proved
who it is, so the refusal tells nobody else whether the tenant has a key.

The write-once triggers on the receipt, the kill and the key admit exactly one
change to their encrypted columns: a key-rotation sweep re-wrapping a
ciphertext. A re-wrap that changed a receipt's plaintext would stop it
verifying against its digest and signature.

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

On `main` (4b): a kill per peer (`PeerAgentKillSwitch`, under
`admin.agent_kill_switch`), re-read uncached at every inbound message, when a run
assembles its tools, at every send call and again by the dispatch pass before a
queued task leaves. It refuses the next message in either direction, is lifted
only by a person with a reason (a CHECK, and an API-key caller is refused), and
the drill exercises its predicate inside a rolled-back transaction as the
`PEER` scope. Retiring the receiving agent revokes the peer's inbound credential
in the retirement cascade (owner decision 2026-10-19), so its next message fails
at the credential check.

## Limits of controls this model relies on

These are properties of controls on `main` that A2A does not change. Each is
bounded by other controls. Where a bound holds only below a rung of the external
write ladder, the row says so and names what bounds the top rung.

| Limit | Bounded by |
|---|---|
| The injection scanner matches patterns. `startWorkflowRun` records that its test proves the wiring, not the scanner's accuracy. | Third-party content is data and never the instruction; a flag parks the run; every write to Inflect's data is a proposal a person approves. Below `AUTOMATIC` an external write sends nothing without a person: `DRY_RUN` sends nothing and `PROPOSE_ONLY` makes it a proposal a person approves. At `AUTOMATIC` it is bounded by the approved parameter set that must be in force, the constraints on its open values, the target population re-resolved at dispatch and the per-connection window, and a run an inbound task started is clamped to `PROPOSE_ONLY` (owner decision 2026-10-17; R17). |
| The egress scan is not a data-loss classifier. `findInternalSecret` refuses ciphertext envelopes and Inflect API keys only, and `guardEgress` adds pattern rules, so personal data in free text can leave in an argument. | The agent and its card must declare `EXTERNAL_EGRESS`; an approved parameter set, where one is in force, fixes or bounds the arguments, and at `AUTOMATIC` one must be in force (`openAutomaticExternalWrite`). Below `AUTOMATIC`, `PROPOSE_ONLY` puts a person in front of every send; at `AUTOMATIC` nobody reviews the send, and the parameter set is the bound. |
| The mutation rate limit is keyed by IP, with every caller anonymous to it. | The per-tenant budget and concurrency caps, which inbound A2A requires both of (owner decision 2026-10-17), and the per-peer quota (R13). |

## Residual risks

This table was the worklist for steps 2e and 4b. R15 (a connection change
raising no finding with an owner) and R16 (a connection with no accountable
owner) were closed by step 2d, which shipped the weekly integration passport and
the connection owner; their numbers are not reused. R1 and R3 were closed by
step 2e (#3673). Step 4b (#3679) closed R2 and R4 to R24 except R19, against an
in-process fake peer, and #3742 closed R19, so no Required control is left. The
controls in R13 (the tenant caps), R17 and R18 were required
on 4b by owner decision (2026-10-17) and are on `main`.

| # | Risk | Why it remains on `main` | Closed by |
|---|---|---|---|
| R1 | A peer has no record of its own: no owner, supplier, tier, endpoint, signing key, card pin or status. | **Closed by 2e (#3673).** `PeerAgent` holds each, under row-level security, tested across two tenants. | 2e: the peer record, with an accountable owner, a supplier and a risk tier (an unscored tier refuses admission), under row-level security, with a two-tenant test (I0 S, I2 I). |
| R2 | A peer's card is neither pinned nor compared. | **Closed by 2e and 4b.** 2e fetches, hashes, approves on the reviewed hash and compares the card (`checkPeerAdmission`); 4b compares it before every message in both directions against a copy at most 15 minutes old (`admitPeerMessage`, `recentAgentCard`). | 2e: the card fetched through `safeFetch` with an aborting byte cap and a deadline, registered as a sink in `tests/guards/ssrf-egress-coverage.test.ts`; hashing, approval on the reviewed hash, and refusal on change (pinning rules 1 to 8; I0 T, R, I, D). 4b: the comparison before every message in both directions (pinning rule 6; I2 S, O1 T), which refuses within 15 minutes of a change, by owner decision (2026-10-17; R18). |
| R3 | The key for the register and pin routes. Using the calling key to approve would let the authority that acts also configure. | **Closed by 2e (#3673).** The owner decided it on 2026-10-18 as this model recommended: `admin.agent_registry` for registering and pinning, and `admin.agent_external_tools` stays the key for the call. | 2e: each route carries a literal `requirePermission('admin.agent_registry')` (I0 E). |
| R4 | The inbound endpoint and its edge handling. | **Closed by 4b.** `POST /api/a2a/:tenantSlug/peers/:peerId`, its own `MACHINE_CALLER_PREFIXES` entry with `matchTenantApiKeyRequest` unchanged; `handleInboundA2a` refuses unless the live `iflp_` credential, the per-message signature by the registered key and the current card pin all hold; a seen message id is refused; the body is capped before it is parsed. | 4b (I1 S, T, I, D). |
| R5 | The inbound credential and its binding to the receiving agent. | **Closed by 4b.** `PeerAgentInboundCredential`: per peer, SHA-256 at rest, revocable and one-way, re-checked on every message, bound to one receiving agent and revoked when that agent is retired; the run's principal is the peer's owner, resolved through the membership check `resolveAgentAuthority` makes. | 4b (I2 S, E). |
| R6 | A peer choosing which workflow runs. | **Closed by 4b.** The credential's `workflowKeys` allowlist. | 4b (I2 E). |
| R7 | Inbound task text reaching a model as anything other than labelled data. | **Closed by 4b.** The text enters the run input only in an envelope labelled `THIRD_PARTY_INGESTED` (source `a2a.peer-task`), scanned before the run exists; the Flue run message carries only declared inputs, fenced and labelled. | 4b (I3 T). |
| R8 | An outbound A2A client. | **Closed by 4b.** The send is the external tool `mcp__<connectionId>__a2a_send_task` of an `a2a-peer` connection, offered only while the peer's pin is current; the A2A client is the third client on `wirePost`, with a closed method set. | 4b (O0 E, O4 E). |
| R9 | Every A2A send treated as a write, and what its prior state is. | **Closed by 4b.** Every send takes the ladder before any read/write branch; its prior state is the pinned card hash, endpoint hash and revision and the conversation it continues, recomputed and compared by the dispatch pass. | 4b (O3 E, T, R). |
| R10 | Addresses a peer supplies, and traffic it starts: file URIs, push-notification URLs and callbacks. | **Closed by 4b.** File parts and push-notification configurations are refused; results come back on the send through the one wire; no callback is accepted. | 4b (I3 I, O6 S, E, I). |
| R11 | A kill per peer. | **Closed by 4b.** `PeerAgentKillSwitch`, re-read uncached on every message in both directions, lifted only by a person with a reason, and drilled as the `PEER` scope. | 4b (I2 E, "Stopping a peer"). |
| R12 | Signed receipts across organisations, and attribution of a run to a peer. | **Closed by 4b.** Every task and result is signed (`inflect-a2a-receipt/1`) — Inflect's side under the tenant's own key, named by its key id and kept after a rotation — verified on receipt and kept with its exact body and the key it verifies under (`PeerAgentMessage`); a run records its peer and the verified message (`WorkflowRun.inboundPeerId`, `inboundMessageId`). | 4b (I5 R, O5 S, "Receipts on both sides", I2 R). |
| R13 | A quota per peer, and tenant caps that default to none. | **Closed by 4b.** A quota per peer, `PeerAgent.inboundMessagesPerHour` (default 60, 1..1000, owner decision 2026-10-19), and inbound A2A refused unless the tenant has set both `agentMonthlyTokenBudget` and `agentMaxConcurrentRuns` (owner decision 2026-10-17). | 4b (I1 D, I2 D). |
| R14 | Chaining: a peer uses Inflect's agent to reach a second peer. | **Closed by 4b.** A run an inbound task started is offered no send, is refused one at the call, and its row is refused at the send. | 4b (I4 E). |
| R17 | A run an inbound task started causes an unattended write to another system. | **Closed by 4b**, by owner decision (2026-10-17): `clampForInboundA2a` holds such a run's external writes at `PROPOSE_ONLY`, so on an `AUTOMATIC` connection its write is a proposal a person approves; an approved write opens at `PROPOSE_ONLY`. | 4b (I4 E). |
| R18 | Between a peer changing its card and the next comparison, its messages are still admitted and sent. | **Accepted at 15 minutes, by owner decision (2026-10-17).** The card is compared before every message against a copy at most 15 minutes old (`A2A_CARD_MAX_AGE_MS`), fetched when none is held, and a failed fetch refuses. A change made inside the window is admitted and sent until the copy expires. | 4b (pinning rule 6). |
| R19 | Inflect's own published card discloses what a tenant runs. | **Closed by #3742.** One signed card per tenant that holds a signing key, naming the per-tenant endpoint, the identity and the keys and nothing else — no agent list, no tool or workflow name, no tenant name. The owner chose a card per tenant over one per agent (2026-10-20), because a second Inflect tenant cannot pin per-pair cards: each side's would need the peer id the other assigns, which exists only after it has pinned this one. | #3742 (I1 I; pinning rule 6 binds the peer to re-approve a changed card). |
| R20 | A very large inbound task. | **Closed by 4b.** A 64 KiB body cap before parsing, and caps on the task's text and data before it is scanned. | 4b (I3 D). |
| R21 | The answer to a peer: what it carries, what it claims, and what a refusal reveals. | **Closed by 4b.** The answer is the task's state and the run's proposals by status, passes `guardEgress` (a flag or a block withholds its artefact), says a pending proposal changed nothing, and every refusal is one generic error with the reason in the audit row. | 4b (I5 I, T). |
| R22 | A peer's endpoint repointed while its stored credential is kept. | **Closed by 2e and 4b.** A peer's card URL and signing key cannot be updated (2e); the `a2a-peer` connection holds no endpoint, and its `peerId` is an origin field, so repointing it keeps no stored credential (4b). | 2e and 4b (O0 T). 2d: an endpoint change is a HIGH passport finding (P1). |
| R23 | Replies to a peer that asks for more input sent as one approved call. | **Closed by 4b.** Every message is its own call of the send tool under the ladder. | 4b (O3 T). |
| R24 | One credential presented to several peers. | **Closed by 4b.** The credential a peer issued is the secret of that peer's own `a2a-peer` connection. | 4b (O4 I). |
