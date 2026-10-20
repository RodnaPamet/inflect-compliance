# 0003 — A2A host consumers: a second kind of inbound principal

**Status:** accepted · **Date:** 2026-10-20 · **Issue:** #3861 · **Roadmap:** #3859

> **Status: historical record** — a decision taken on 2026-10-20 and the
> reasoning behind it, pinned to that date. Classified `historical` as ADR 0001
> is: an ADR records what was decided and why, and is not revised as the
> implementation lands. Where it describes work still to come, #3861 and the
> threat model (R25–R28) are current; where it and the code disagree, the code
> wins and the pull request that finds it says so here.

**Decision:** admit a host that calls Inflect as a **client** through a new
`HostConsumer` principal with its own OAuth2 client-credentials endpoint.
**Peers are untouched.** Option (a) of the three below.

The owner recorded this on #3860 before this document existed, together with the
AI-residency decision. This ADR implements that decision and does not make it.

## Context

SAP Joule calls external A2A agents as a client. It publishes no agent card,
holds no Ed25519 key, cannot sign `inflect-a2a-receipt/1`, and authenticates
only through a BTP destination using `NoAuthentication` or
`OAuth2ClientCredentials`. That is not a gap in Joule — it is what an A2A *host*
is, and SAP's own Apache-2.0 toolkit documents it.

Inflect's inbound surface was built for the other shape: a **peer**, which is
another agent with its own card, its own key and a mutual pin.

### Where today's admission refuses a Joule-shaped request

Four walls, in the order a request meets them. All line numbers are
`src/app-layer/usecases/a2a-inbound.ts` at `b92525148` unless stated.

| # | Site | Why Joule fails it |
| --- | --- | --- |
| 1 | **`:232`** `return refusal('BAD_CREDENTIAL', null, 401)` | The bearer is looked up with `findPeerIdByInboundToken`. An OAuth access token hashes to no `PeerAgentInboundCredential`, so there is no peer to attribute the call to at all. This is the first wall and the one Joule always hits. |
| 2 | **`:254`** `if (!peer) return refuse('UNKNOWN_PEER', null, 401)` | Reached only when a `peerId` is supplied on the route. There is no `PeerAgent` row for Joule, and creating one would require a card URL and signing key it does not have. |
| 3 | **`:259`** `if (!credential) return refuse('BAD_CREDENTIAL', null, 401)` | `matchPeerInboundCredential` re-checks the bearer against that peer's live credentials. An OAuth token is not an `iflp_` credential. |
| 4 | **`:273`** `if (!verdict.ok) return refuse(verdict.reason, null, 401)` | `verifyA2aReceiptHeader` requires a signed `inflect-a2a-receipt/1` over the body digest. Joule sends no such header and holds no key to make one. |
| 5 | **`:282`** → `src/lib/agentic/peer-agent-card.ts:243` `PEER_UNPINNED` | `admitPeerMessage` refuses unless a person has read and pinned the peer's live card. Joule publishes no card to pin. |

Five rather than the four the issue names: `BAD_CREDENTIAL` appears twice, at
`:232` and `:259`, and they are different checks — *which principal is this*
versus *is this credential still live for that principal*.

## Options

**(a) A new `HostConsumer` principal and model, with an OAuth2
client-credentials token endpoint. Peers untouched.** — **CHOSEN.**

**(b) A `PeerAgent` "kind" that waives the receipt and the pin.** Rejected. Less
new code, and the waiver sits inside the path that carries the strongest
guarantees, where a mistake is worst. A conditional that waives a peer's receipt
is the shape that erodes: every later change to the peer path has to remember
the exception, and the exception is invisible from the peer-facing tests. The
class of defect this repo keeps finding — a guard whose subject quietly widened
— is exactly this shape.

**(c) Do nothing.** Rejected by the owner's decision. It would end the A2A
route: Joule cannot authenticate any other way, leaving only the MCP route at
7–10 weeks with the heavier policy gate.

## The threat-model decisions this revisits

Three separate answers, because they are **not equally strong** and presenting
them as one would be the dishonest part. This mirrors the owner's record on
#3860, which is the authority.

### 1 · No trust on first use — NOT waived, re-sited

A host consumer does not exist until a person creates it, and creating it names
exactly one receiving `RegisteredAgent` and a `workflowKeys` allowlist. A token
alone admits nothing: the consumer must already exist with its grants chosen.
Trust is still established out of band by a human — by configuration rather than
by reading and pinning a card. **What is lost is the card read, not the
first-use check.**

### 2 · Receipts as evidence — WEAKENED, with no equivalent replacement

An Ed25519 receipt proves authorship by a key the holder cannot repudiate. An
OAuth bearer proves only possession of a secret at a moment. **Non-repudiation
on this path is weaker and nothing here restores it.**

What is put in its place, which is *not* the same thing: a **write-once row per
inbound request**, carrying the exact request body bytes, the OAuth client id
and the token's `jti`, mirroring `PeerAgentMessage`'s write-once trigger
including the exception that admits the DEK re-wrap sweep.

Why that is acceptable **here** — the argument is blast radius, not equivalence:

- writes are clamped to `PROPOSE_ONLY` (`clampForInboundA2a`, R17), so the worst
  outcome of a forged call is a proposal a person still approves;
- no outbound A2A send from a run it started (R14);
- the `workflowKeys` allowlist bounds what can be invoked (R6);
- a per-consumer kill switch read **uncached** (R11) and an hourly quota (R13);
- the host is the customer's **own** tenant, not a third party.

**This must not be described as equivalent** in the threat model, the mapping
document, or any external claim. R12 stays closed for peers and is **explicitly
not closed** for host consumers; the threat model gains a new entry saying so.

### 3 · Card minimisation (R19) — RELAXED, for host consumers only

The published card names no agent and `skills` is typed `readonly never[]`
(`own-card.ts:142`). A host consumer needs skills to know when to call us, so
#3862 adds a **host-consumer card variant** listing one skill per enabled
`workflowKey`, each from a short **reviewed** description written for the
purpose — never generated from tool names, which would leak exactly what R19
withholds. No tool name, no tenant name, no other agent, no workflow not enabled
for a host consumer. **The peer card stays byte-identical.**

## The structural problem this ADR exists to settle

The two narrowings that make option (a) acceptable — the R17 clamp and the R14
no-send — do not ride on the principal. They ride on one context field:

    a2aInbound?: { readonly peerId: string; readonly messageId: string }   // types.ts:94

`clampForInboundA2a(mode, Boolean(ctx.a2aInbound))` is the only thing standing
between an inbound caller and an `AUTOMATIC` connection's unattended write.

Two facts make this the risky part of J1:

1. **`WorkflowRun.inboundPeerId` and `inboundMessageId` are plain ids, not
   foreign keys** (`agentic.prisma:535,538` — "A plain id, for the reason
   above"). So a host-consumer id *could* be written into a column named and
   documented as the `PeerAgent`. It would not fail at insert. It would make the
   schema's own docblock false and any join to `PeerAgent` silently empty.
2. **`restoreA2aInbound` rebuilds the flag only when BOTH columns are non-null**
   (`workflow-runs.ts:966-971`), falling back to `ctx.a2aInbound`, which is
   absent on a rebuilt context. A resume by a person, or a queued Flue segment,
   therefore **loses the narrowing** for any principal whose ids are not in
   those two columns.

So the failure mode is not "the clamp is missing". It is **"the clamp is present
on the first segment and gone on the second"** — a run that starts as
`PROPOSE_ONLY` and resumes able to write. That is the one direction that
matters, and it is invisible to a test that only checks the start.

**Decision:** widen the flag to a discriminated union over the principal, with
**both arms narrowing identically**, and give the host consumer **its own
columns** (`inboundHostConsumerId`, `inboundHostMessageId`) under the same
write-once trigger. `restoreA2aInbound` restores whichever pair is present.
Reusing `inboundPeerId` is rejected: the cost is a permanently false docblock
and a silent join, to save one nullable column.

**Required test, which the issue's list does not include:** a host-consumer run
is clamped on its first segment **and still clamped after a person's resume and
after a queued Flue segment**. Added to the test list; it is the assertion that
distinguishes this design from the one that looks identical at the start.

## The permission key — `admin.agent_registry`

**Owner decision, 2026-10-20.** Creating a host consumer and issuing, rotating
or revoking its credentials is gated on `admin.agent_registry`.

R3 separated *whom an agent talks to* (`admin.agent_registry`, for registering
and pinning) from *external-tool configuration* (`admin.agent_external_tools`,
the key for the call), because the authority that acts should not also
configure. A host consumer is **whom may call us** — register-shaped rather than
call-shaped — so this is the key R3's own logic points at, and it needs no new
permission seeded, documented and tested across the role matrix.

**The reservation, accepted knowingly:** this bundles *admit an outside system
into this tenant* with *manage our own agent register*, so anyone who can do the
second can now do the first. The alternative considered was a dedicated
`admin.a2a_host_consumers`, with precedent — `admin.agent_kill_switch` and
`admin.agent_tool_exposure` both took their own key rather than folding into the
register. If the bundling is ever felt, splitting the key is a contained change:
the routes carry a literal `requirePermission(...)`, so the split is mechanical
and the tests name the key.

`admin.agent_external_tools` was not a candidate — R3 keeps it for the call.
`admin.agent_tool_exposure` was rejected because it governs what an agent may
REACH, not who may invoke it, and conflating those is how a key's name stops
describing it.

## Consequences

- Behind the env flag `A2A_HOST_CONSUMERS` (opt-in, `'1'`/`'true'` only, in
  `src/env.ts`) **and** a per-tenant setting, both default off.
- A host-consumer token is recognised **before** the peer path and never falls
  through to it, so no peer check can be reached by a host-consumer token and no
  host-consumer check can weaken a peer.
- The threat model gains host-consumer entries, including one recording that R12
  is not closed on this path.
- If an assurance claim ever needs true non-repudiation here, **this decision is
  the thing to revisit** — not the implementation.
