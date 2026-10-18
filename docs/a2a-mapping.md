# A2A mapping onto the authority funnel

> **Status: living design** — the peer register and card pinning ship with step
> 2e (#3673); carrying tasks is step 4b (#3679). See "Current state (true today)"
> for what exists and "Roadmap (future direction)" for what 4b builds.

How an A2A (Agent2Agent) task travels through Inflect without a second
authority model. The threats, boundaries and controls for every hop are in
[`docs/a2a-threat-model.md`](a2a-threat-model.md); this document is the
mapping it calls for, and states the rules 4b builds to.

## The rule: A2A adds no second authority model

A peer is a registered principal for **identity and attribution, never for
authority**. Nothing about A2A grants a tool, a permission key, an API scope or
an autonomy rung, to a peer or to anything a peer causes. Every A2A task maps
onto a path that already exists and is decided where that path is decided
today:

| Direction | Becomes | Decided by |
| --- | --- | --- |
| Inbound task (a peer asks Inflect) | a run input for ONE registered Inflect agent, guarded and labelled third-party | the receiving agent's chain: credential → registration gate → `resolveAgentAuthority` → `authorizeToolCall` on every call → a proposal a person approves for every write to Inflect's data |
| Outbound task (an Inflect agent asks a peer) | an external tool call | the agent's grant, the pin a person accepted, the connection's rung on the external write ladder, the approved parameter set, the prior-state read and the journal |

The peer's own record holds admission facts only: who it is, who answers for
it, its supplier and risk tier, the key its messages must be signed with, the
card a person accepted, and whether it is active (`PeerAgent` in
`prisma/schema/agentic.prisma`). It has no authority column, and adding one
would be the second authority model this document exists to rule out.

## Current state (true today)

- **The peer register.** `PeerAgent`, one row per peer per tenant, under
  row-level security with `FORCE`, a tenant-leading index, and no `DELETE` for
  `app_user`: a peer is RETIRED (one-way, held by a trigger), never deleted.
  The only writer is `src/app-layer/usecases/peer-agents.ts`.
- **The routes.** `/api/t/:slug/admin/agents/peers` (list, register),
  `…/peers/:peerId` (read; change name, owner, tier or status),
  `…/peers/:peerId/card` (read the live card for review) and
  `…/peers/:peerId/card/approve`. Each carries a literal
  `requirePermission('admin.agent_registry')`. **That key is the owner's
  decision (2026-10-18) on the threat model's residual R3**: registering and
  pinning are configuration, which sits with the register;
  `admin.agent_external_tools` stays the key for an agent's call leaving the
  tenant, so the authority that acts never configures whom it talks to.
- **Card pinning, with no trust on first use.** Registration reads the card and
  records what it saw (`observedCardHash`); it pins nothing. A person reads the
  live card through the review route, which returns the card itself, and
  approves the hash they reviewed. The approval reads the card again and is
  refused (409) when it no longer matches. The pin carries the approver, the
  time, a revision and the hash it replaced, and the approval is audited with
  hashes and never with card text.
- **The hash** (`src/lib/agentic/peer-agent-card.ts`) is version-prefixed
  (`a2a-agent-card/v1`) and covers the whole card as served. Three component
  hashes say what moved: the text a model reads (the card's name and
  description; each skill's name, description and examples, hashed as exact
  code units), the endpoint and its authentication, and everything else.
- **Admission.** `evaluatePeerAdmission` is deny by default. A peer is admitted
  only when it is ACTIVE, its owner is an ACTIVE member, its tier is scored, it
  has a pin, its live card could be read, and that card matches the pin.
  `checkPeerAdmission` in the usecase reads the live card and applies it; it is
  the gate 4b calls before every message. No traffic exists for it to gate yet.
- **The card fetch** (`src/lib/agentic/peer-agent-card-fetch.ts`) is https
  only, goes through `safeFetch`, is bounded by a deadline and a 64 KiB cap that
  aborts the transfer, and is a registered sink in
  `tests/guards/ssrf-egress-coverage.test.ts`. A failed read names a reason and
  carries no body.
- **The signal.** `agentic.peer_card.check` counts every card read by outcome;
  `CHANGED` is the one to alert on.

## Roadmap (future direction)

Everything below is step 4b. It is written here so 4b builds to it, and each
point is the funnel or the ladder applied to A2A, not a new mechanism.

### Inbound: a task becomes a run input

1. **Admission before parsing.** The inbound endpoint resolves the peer from its
   own per-peer credential, then calls `checkPeerAdmission` before the body is
   parsed, against a copy of the card at most 15 minutes old (owner decision
   R18). A refusal tells the peer only that re-approval is required; the reason
   goes to the audit row.
2. **One receiving agent.** The credential is bound to exactly one registered
   agent, as `TenantApiKey.agentId` binds a key, and resolves through
   `resolveAgentAuthority` with the peer's accountable owner as the principal.
   The peer chooses which workflow runs only from an allowlist on its record.
3. **Guarded, labelled input.** The task text is a run input: it passes
   `assertNoReviewRequired` before the run exists, and it carries the
   third-party provenance label (`src/lib/agentic/content-provenance.ts`), so a
   model reads it as data.
4. **Writes stay where they are.** A write to Inflect's data is a proposal a
   person approves. A write to another system follows its connection's rung, and
   a run a peer started never dispatches above `PROPOSE_ONLY` (owner decision
   R17). It may not send an outbound A2A task.

### Outbound: a task is an external tool call

1. **The send is a tool.** It is offered to a run only while the peer's pin is
   current, under a grant, through `authorizeToolCall`, like any external tool.
2. **Every send is a write.** It follows the connection's rung on the external
   write ladder whatever the peer declares, with a prior-state read that names
   the pinned card hash and the task's context, and a journal row before it
   leaves.
3. **The card is checked before each send**, against the same 15-minute copy.

### Receipts on both sides

Every inbound message is verified against the peer's registered Ed25519 key
(`PeerAgent.signingPublicKey`) and kept with its signature; every answer and
every outbound message is signed by Inflect and kept. Either side can then show
what the other sent.

### A kill per peer

`PeerAgent.status` SUSPENDED already refuses admission. 4b adds a per-peer kill
that is re-read on every message in both directions, lifted only by a person
with a reason, and drilled like the agent kill switch.
