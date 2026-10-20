# A2A mapping onto the authority funnel

> **Status: living design** — the peer register and card pinning ship with step
> 2e (#3673), and carrying tasks in both directions with step 4b (#3679), built
> against an in-process fake peer. See "Current state (true today)" for what
> exists and "Roadmap (future direction)" for what is still open.

How an A2A (Agent2Agent) task travels through Inflect without a second
authority model. The threats, boundaries and controls for every hop are in
[`docs/a2a-threat-model.md`](a2a-threat-model.md); this document is the
mapping it calls for, and states the rules 4b built to.

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
  `checkPeerAdmission` in the usecase reads the live card and applies it;
  `admitPeerMessage` applies the same rule before every message in both
  directions, against a copy of the card at most 15 minutes old
  (`src/lib/agentic/a2a/card-cache.ts`, owner decision R18).
- **The card fetch** (`src/lib/agentic/peer-agent-card-fetch.ts`) is https
  only, goes through `safeFetch`, is bounded by a deadline and a 64 KiB cap that
  aborts the transfer, and is a registered sink in
  `tests/guards/ssrf-egress-coverage.test.ts`. A failed read names a reason and
  carries no body.
- **The signal.** `agentic.peer_card.check` counts every card read by outcome;
  `CHANGED` is the one to alert on.

### Inflect's own card, and what Inflect is called

Each tenant publishes one agent card, `GET /api/a2a/:tenantSlug/agent-card.json`
(#3742, `src/lib/agentic/a2a/own-card.ts`), and **the card's URL is the tenant's
A2A identity**: the sender of every receipt it signs and the recipient every
peer must address, the same for every peer, built on `APP_URL` and never on a
request. Inflect names a peer by its card URL, so naming itself the same way is
what lets one Inflect tenant pin another (owner decision 2026-10-20).

- **What it names.** The per-tenant endpoint, the identity, the receipt format,
  the public key in force and, for seven days after a rotation, the previous
  one with the time it stops being named. No agent list, no tool or workflow
  name, no tenant name.
- **Signed** by the key in force, over a domain-separated canonical form, and
  deterministic, so a peer's pin holds until a key changes. A changed card is
  something the PEER re-approves (pinning rule 6 of the threat model).
- **Public by necessity**, rate-limited by IP, and one 404 for every reason
  there is no card: an unknown tenant, no signing key, no `https` `APP_URL`.
- **No public origin, no A2A.** Without an `https` `APP_URL` there is no
  identity, so every message in either direction refuses `NO_PUBLIC_ORIGIN`
  and the send tool is not offered.

### Inbound: a task becomes a run input

There are two ways in, and one admission. `POST /api/a2a/:tenantSlug` is the
endpoint the card names: it finds the peer from the SHA-256 of its bearer,
through a unique index on the credential hash. `POST /api/a2a/:tenantSlug/peers/:peerId`
names the peer in the path, and stays for peers already given it. Both cap the
body at 64 KiB and call `handleInboundA2a`
(`src/app-layer/usecases/a2a-inbound.ts`), which holds the endpoint's whole
authorization because no session stands behind the caller.

1. **Admission before parsing.** Nothing the peer wrote is parsed until the
   peer is identified, its kill is read, its `iflp_` bearer matches the live
   per-peer credential in constant time, its receipt verifies against its
   registered key over the exact body, and it is admitted against the 15-minute
   card copy, and the tenant must hold a signing key of its own. Then the
   peer's own quota (`PeerAgent.inboundMessagesPerHour`, default 60, set with
   the register key and held to 1..1000), the replay check (the
   message is recorded, and a message id seen before is refused), and the
   tenant's two run caps, which must both be set. A refusal tells the peer
   "refused" and nothing else; the reason goes to an `AUTHZ_DENIED` audit row
   and the `agentic.a2a.message` metric.
2. **One receiving agent.** The credential (`PeerAgentInboundCredential`) binds
   the peer to exactly one registered agent and to an allowlist of workflow
   keys, as `TenantApiKey.agentId` binds a key. The run's principal is the
   peer's accountable owner, resolved as a member at the moment of the message.
   The allowlist lives on the credential and not on `PeerAgent`, so the peer
   record keeps no column that decides what runs. Retiring the receiving agent
   revokes the credential in the retirement cascade, so the next message fails
   at the credential check.
3. **Guarded, labelled input.** The task text enters the run input only inside
   an envelope labelled `THIRD_PARTY_INGESTED` (source `a2a.peer-task` in
   `src/lib/agentic/content-provenance.ts`), and `startWorkflowRun` scans the
   whole input with `assertNoReviewRequired` before the run row exists: a flag
   or a block refuses, with no run.
4. **Writes stay where they are.** The run is the receiving agent's, through
   `authorizeToolCall` on every step with the agent's own allowlist, so a peer
   reaches no tool the agent was not granted. A write to Inflect's data is a
   proposal a person approves. A write to another system follows its
   connection's rung, clamped to `PROPOSE_ONLY` (`clampForInboundA2a`, owner
   decision R17). A peer-started run is offered no A2A send (R14). The run
   records `inboundPeerId` and `inboundMessageId`, written once, and the
   context that marks it peer-started is restored on resume.
5. **The answer.** The task's state and the run's proposals by status, after
   `guardEgress`; a pending proposal is reported as pending, never as done.
   `tasks/get` reaches only a run this peer started.

### Outbound: a task is an external tool call

1. **The send is a tool.** An `a2a-peer` connection
   (`src/app-layer/integrations/providers/a2a-peer-provider.ts`) names one peer
   and holds, as its secret, the credential that peer issued. Its tool
   `mcp__<connectionId>__a2a_send_task` is granted like any external tool, and
   is offered to a run only while the connection is above `DISABLED`, no kill is
   in force on the peer, and the peer is admitted.
2. **Every send is a write.** The rung is the connection's, on the external
   write ladder, whatever the peer declares: `DRY_RUN` journals the intent and
   sends nothing, `PROPOSE_ONLY` makes an `EXTERNAL_WRITE` proposal a person
   approves, and `AUTOMATIC` opens a journal row inside an approved parameter
   set. The prior state is the pinned card hash, endpoint hash and revision and
   the conversation the task continues. Nothing is sent from the call: the
   dispatch pass is the only sender, and before it sends it re-reads both kills,
   admission and whether the pin it recorded still holds.
3. **One wire.** `sendA2aMessage` (`src/lib/agentic/a2a/client.ts`) is the third
   client on `wirePost`, with a closed method set and the secret egress scan.

### Receipts on both sides

Every task and every result carries an `inflect-a2a-receipt/1` receipt in the
`x-inflect-a2a-receipt` header: an Ed25519 signature over the canonical
statement, which names the sender, the recipient, the kind, the message ids and
the digest of the exact body (`src/lib/agentic/a2a/receipt.ts`). Inbound
messages are verified against `PeerAgent.signingPublicKey`. Each tenant signs
with its own Ed25519 key, `TenantA2aSigningKey`, whose seed is encrypted under
the tenant's DEK; an OWNER generates and rotates it (`admin.tenant_lifecycle`),
and a tenant with no key refuses A2A in both directions with `NO_SIGNING_KEY`.
A rotation keeps the retired key's public half, and every receipt names the key
id (fingerprint) that signed it. Every message, sent or received, is kept with
its signature, its body and the public key it verifies under as a write-once
`PeerAgentMessage` row, from which `verifyStoredA2aReceipt` re-derives the
receipt. A reply whose receipt does not verify is discarded, and its journal
row settles `INDETERMINATE`.

### The peers page

`/agents/peers`, reached from the agents Views menu, lists each peer with its
pin, card state and quota, and shows the tenant's signing key: its public key
and key id, and generate or rotate for an OWNER. A peer's own page carries its
kill switch, its inbound credential (issued with the token shown once, and
revoked), its quota, and every message with whether its receipt verifies. Each
action is gated as its route is.

### A kill per peer

`PeerAgentKillSwitch` is a sibling of the agent kill, not a column on the peer.
It is re-read uncached on every message in both directions, lifted only by a
person with a reason (an API key cannot lift it), audited both ways, and
exercised by the scheduled drill as the `PEER` scope. `PeerAgent.status`
SUSPENDED refuses admission as before.

### Who writes what

| Table | Only writer |
| --- | --- |
| `PeerAgentMessage` | `src/app-layer/usecases/a2a-messages.ts` |
| `PeerAgentKillSwitch` | `src/app-layer/usecases/a2a-peer-kill.ts` |
| `PeerAgentInboundCredential` | `src/app-layer/usecases/a2a-peer-credentials.ts` |
| `TenantA2aSigningKey` | `src/app-layer/usecases/a2a-signing-key.ts` |

Held by `tests/guards/agent-harness-single-write-seam.test.ts`.


## Roadmap (future direction)

- **A real peer.** Step 4b was built and tested against an in-process fake
  peer. The pilot with a real vendor's agent stays open on #3752, and it is the
  first time a task crosses an organisation boundary.
- **A card per agent.** The published card is one per tenant (#3742) and names
  no agent. A card per agent a tenant enables for A2A, listing that agent's
  skills, waits until a real peer asks for one, since every name it adds is
  something the tenant discloses.
