# 2026-10-19 — A2A messaging with one pinned peer

**Commit:** step 4b of the agentic IAM roadmap (#3679, under #3659)

## Design

Step 2e registered A2A peers and pinned their cards. This step carries tasks in
both directions, built against an in-process fake peer
(`tests/helpers/a2a-fake-peer.ts`). Both directions map onto paths that already
exist, so A2A adds no authority model of its own (`docs/a2a-mapping.md`).

```
INBOUND   peer ──POST /api/a2a/:slug/peers/:peerId──▶ handleInboundA2a
            kill → iflp_ credential → receipt (peer key, exact bytes) → admission (card ≤15 min)
            → quota → record TASK (replay) → tenant caps → parse → workflow allowlist
            → agent ACTIVE / not killed / breaker closed → owner resolves
            → startWorkflowRun(ctx + a2aInbound, input + THIRD_PARTY envelope)   [scanned before the run row]
            → answer: state + proposals, guardEgress, signed RESULT kept, receipt header

OUTBOUND  run ──mcp__<conn>__a2a_send_task──▶ authorizeToolCall ──▶ dispatchA2aSend
            R14 · args · peer kill · fresh rung · admission · prior state (pin + conversation)
            DRY_RUN → intent row   PROPOSE_ONLY → EXTERNAL_WRITE proposal   AUTOMATIC → journal row
          runExternalWriteDispatch ──▶ sendA2aJournalRow (the only sender)
            agent kill · R14 · peer kill · admission · BASIS_MOVED · bounds · key · credential
            → sign TASK, keep it → wirePost → verify RESULT receipt → keep it → settle the row
```

The outbound rung is the `a2a-peer` connection's `externalWriteMode`, set
through the existing external-write policy route. The peer record keeps
admission facts only. The inbound credential binds a peer to one receiving agent
and a workflow allowlist, as `TenantApiKey.agentId` binds a key; the run's
principal is the peer's accountable owner, and its tools are the receiving
agent's grants.

Receipts (`inflect-a2a-receipt/1`) are Ed25519 over the SHA-256 of the
canonical statement (`receiptSignedMessage`, shared with the mediator receipts),
carried in `x-inflect-a2a-receipt`. The statement names sender, recipient, kind,
method or the message it answers, the time, and the digest of the exact body.
Inflect's identity for a pair is `inflect:a2a/<tenantId>/<peerId>`; the peer's is
its card URL. Inflect's side signs with the TENANT'S OWN key
(`TenantA2aSigningKey`, owner decision 2026-10-19), and every kept receipt
names the key id that signed it and carries that public key.

## Files

| File | Role |
|---|---|
| `prisma/schema/agentic.prisma`, migration `20261019050000_a2a_peer_messaging` | `PeerAgentMessage`, `PeerAgentKillSwitch`, `PeerAgentInboundCredential`, `TenantA2aSigningKey`; `PeerAgent.inboundMessagesPerHour`; `WorkflowRun.inboundPeerId` / `inboundMessageId`; CHECKs, write-once triggers (with the re-wrap exception), the retired-agent credential trigger, RLS |
| `src/lib/agentic/a2a/receipt.ts` | Sign, encode, verify a receipt; re-verify a stored one against the key id it names |
| `src/lib/agentic/a2a/signing-key.ts` | Build a key from a seed; mint a seed |
| `src/app-layer/usecases/a2a-signing-key.ts` | The single reader and writer of `TenantA2aSigningKey`: read the public half, generate or rotate (OWNER), resolve the key to sign with |
| `src/lib/agentic/a2a/protocol.ts` | The JSON-RPC subset: parse inbound, build and parse outbound, caps |
| `src/lib/agentic/a2a/card-cache.ts` | The ≤15-minute card copy (R18) |
| `src/lib/agentic/a2a/credential.ts` | `iflp_` tokens, hashed, compared in constant time |
| `src/lib/agentic/a2a/client.ts` | The third client on `wirePost` |
| `src/lib/agentic/a2a/send-tool.ts` | The send tool, its arguments and its prior state |
| `src/app-layer/integrations/providers/a2a-peer-provider.ts` | The `a2a-peer` connection: a peer id and the credential the peer issued |
| `src/app-layer/usecases/a2a-inbound.ts` | The inbound pipeline and its audited refusals |
| `src/app-layer/usecases/a2a-outbound.ts` | Assembly, the call, and the send from the dispatch pass |
| `src/app-layer/usecases/a2a-messages.ts`, `a2a-peer-kill.ts`, `a2a-peer-credentials.ts` | The single writers of the three new tables |
| `src/lib/integrations/external-write-ladder.ts` | `clampForInboundA2a` (R17) |
| `src/lib/mcp/tools/external-tools.ts`, `usecases/external-write-dispatch.ts` | The A2A branch ahead of the read/write split; the dispatch arm |
| `src/app-layer/usecases/workflow-runs.ts` | Writes the inbound origin once; restores `a2aInbound` on resume |
| `src/app-layer/jobs/agent-kill-switch-drill.ts` | The `PEER` drill scope |
| `src/app/api/a2a/[tenantSlug]/peers/[peerId]/route.ts` and four admin routes | The inbound door; kill, credential, message reads, and the signing key |
| `src/app-layer/usecases/agent-retirement-cascade.ts` | Retirement revokes the agent's inbound peer credentials |
| `src/app/t/[tenantSlug]/(app)/agents/peers/` | The peers list with the signing-key panel, and one peer's page (overview and quota, kill switch, inbound credential, messages) |

## Decisions

- **No column on `PeerAgent`.** The rung is the connection's; the workflow
  allowlist and the receiving agent are the credential's; the kill is a sibling
  table. Each lives where its existing analogue lives, so the peer row stays an
  admission record.
- **The A2A branch sits before the read/write split** in `adapterFor`. A peer
  card cannot declare a send read-only, so the tool definition carries no
  annotations and the branch never asks.
- **Nothing is sent at the call.** At every rung the call writes a row and
  returns text. The dispatch pass is the only sender, as for MCP writes, so one
  place re-checks kills, admission and the pin at the last moment.
- **The prior state is the pin.** `a2aSendPriorState` records the pinned card
  hash, endpoint hash and revision and the conversation. The send compares it
  and refuses `BASIS_MOVED` if a person re-approved a different card between
  the approval and the send.
- **An approved write opens at `PROPOSE_ONLY`** in
  `external-write-approval.ts`, also on an `AUTOMATIC` connection. Before, it was
  stamped `AUTOMATIC` and the dispatch pass demanded a parameter set it never
  ran, so R17 would have made a peer-started write a refusal rather than a
  review. This applies to every MCP connection, not only A2A, and the owner
  confirmed it (2026-10-19).
- **The task is recorded before it is parsed**, so a replayed message id is a
  unique-constraint refusal, and a TASK the run then refused still has its
  receipt kept.
- **A reply that fails verification is not kept.** Keeping it would put an
  unattributable body in a write-once evidence table; the journal row settles
  `INDETERMINATE` and the metric counts it.
- **Retained, not cascaded.** `PeerAgentMessage` and `PeerAgentKillSwitch` are
  in `TENANT_PURGE_RETAINED` and reference the peer by plain id, so no cascade
  from a purged table reaches them. The credential is security-ephemeral and
  keeps its foreign keys (`Restrict`).
- **The message body is encrypted at rest** by an explicit manifest entry,
  since the field-name fan-out would have encrypted it anyway; the bodyDigest
  is a hash and marked not sensitive. Bodies are never sanitised: the digest is
  over the exact bytes.
- **Each tenant has its own signing key, in the database** (owner decision
  2026-10-19, replacing an `A2A_SIGNING_PRIVATE_KEY` env var this branch first
  carried). The seed is in the Epic B manifest, so the tenant DEK wraps it and
  both key-rotation sweeps cover it with no code of their own. Generate and
  rotate are `admin.tenant_lifecycle`, the OWNER key that rotates the DEK; the
  agent register key, held by ADMIN and AI_ADMIN, reads the public half. A
  rotation nulls the old seed and keeps its public key. No key refuses both ways
  (`NO_SIGNING_KEY`), asked inbound after the peer's receipt verifies so an
  unauthenticated caller cannot learn whether a tenant has one.
- **A receipt carries its own public key**, bound by the fingerprint it names.
  The receipts are retained across a tenant purge and the key table is not, so a
  receipt that needed the table to verify would stop being evidence the day the
  tenant left.
- **The write-once triggers admit a re-wrap.** The tenant-DEK and master-KEK
  sweeps rewrite every manifest ciphertext with a raw UPDATE, and a trigger that
  refused every update would have made a DEK rotation fail for any tenant with a
  receipt. Each trigger lets ciphertext → `v2:` ciphertext through with every
  other column unchanged; the integration suite runs a real DEK rotation over A2A
  rows to prove it.
- **Retiring an agent revokes its inbound peer credentials** in the cascade's
  transaction (owner decision), through the credential table's own writer, with
  an audit row; a trigger refuses a live credential for a retired agent, the
  retirement migration's `FOR SHARE` pattern.
- **The quota is a column on the peer**, `inboundMessagesPerHour`, default 60,
  1..1000 by CHECK, set with the register key (owner decision). A limit only
  narrows, so it is not the authority column the peer must never have.
- **The peers page** is an `EntityListPage` with the signing-key panel as its
  banner, and one peer is an `EntityDetailLayout` with four tabs; every control
  is offered only to a holder of the key its route takes.
- **The inbound answer reports proposals by status** and says plainly that a
  pending proposal is not done. Feeding a peer's reply into a waiting run, and
  promoting an `ACCEPTED` send to `APPLIED` on a later `tasks/get`, are left out.
