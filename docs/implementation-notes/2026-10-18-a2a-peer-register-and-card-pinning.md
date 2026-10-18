# 2026-10-18 — A2A peer register and agent-card pinning (2e)

**Commit:** `feat(agentic): A2A peer register and agent-card pinning (2e)`

## Design

Step 2e of `docs/agentic-iam-roadmap.md` (#3673). A peer is an agent in another
organisation. This step builds the record a peer is admitted against and the
pin on its agent card. It exchanges no task; that is 4b.

```
operator ──register──▶ peer-agents.ts ──fetchAgentCard──▶ peer host (safeFetch, 64 KiB, 10 s)
                           │                                   │
                           │ observedCardHash, no pin ◀────────┘
reviewer ──GET …/card──▶ live card + hashes + verdict + admission
reviewer ──POST …/approve {expectedCardHash}──▶ re-read; refuse on mismatch; pin rev+1
4b (later) ──checkPeerAdmission──▶ evaluatePeerAdmission(status, owner, tier, pin, live)
```

- `src/lib/agentic/peer-agent-card.ts` is pure: it parses a card, hashes it,
  compares it with a pin and decides admission. The hash is
  `a2a-agent-card/v1` over the whole canonical card plus three component hashes
  (text, endpoint, other). The components explain a change; the composite
  decides it.
- `src/lib/agentic/peer-agent-card-fetch.ts` is the one network sink. It is
  https only, reaches `safeFetch` in an explicit branch, and applies one
  deadline and an aborting byte cap. A failure names a reason and carries no
  body.
- `src/app-layer/usecases/peer-agents.ts` is the only writer of `PeerAgent`.
  Every network read happens outside a transaction. The approval moves the pin
  only from the revision it started from (`updateMany … pinRevision`), so two
  concurrent approvals cannot both land.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma`, `enums.prisma` | `PeerAgent`, `PeerAgentStatus` |
| `prisma/migrations/20261018080000_peer_agent/` | table, CHECKs (pin all-or-nothing, https, tier pairing), RETIRED-is-final trigger, RLS, `DELETE` revoked from `app_user` |
| `src/lib/agentic/peer-agent-card.ts` | parse, hash, compare, admit (pure) |
| `src/lib/agentic/peer-agent-card-fetch.ts` | the card read |
| `src/app-layer/usecases/peer-agents.ts` | register, list, get, update, read card, approve, `checkPeerAdmission` |
| `src/app/api/t/[tenantSlug]/admin/agents/peers/**` | four routes, `requirePermission('admin.agent_registry')` |
| `src/lib/security/route-permissions.ts` | an explicit peers rule above the agents catch-all |
| `src/lib/observability/integration-metrics.ts` | `agentic.peer_card.check` |
| `docs/a2a-mapping.md` | the mapping onto the funnel (living) |
| `docs/a2a-threat-model.md` | I0 and I2 rows and residuals R1, R2, R3, R22 moved to "On `main`" |

## Decisions

- **The key is `admin.agent_registry`** (owner, 2026-10-18; residual R3). The
  issue proposed `admin.agent_external_tools`; the threat model recommended
  against letting the key that acts also configure. The rule is stated on its
  own above the catch-all, which already resolves to the same key, because it
  was a decision rather than an inheritance.
- **No trust on first use.** Built-in tools get a baseline pin on first sight
  because Inflect wrote them. A card is another organisation's text, so the
  first read pins nothing and the peer is refused until a person approves.
- **The card's text is shown to the reviewer and stored nowhere.** Approving a
  hash of text you were not shown is not a review, so the card-read response
  carries the card. Nothing persists it, and the audit rows carry hashes only.
- **Text is hashed through `JSON.stringify`.** `createHash().update(text,
  'utf8')` replaces a lone surrogate with U+FFFD, so two different texts hash
  alike. The tool-manifest hasher has that property; this one does not, and a
  test pins it.
- **The composite hash folds in the whole card.** The text, endpoint and other
  components partition the card, but a partition is a claim the code makes
  about itself. With the whole card folded in, a field the partition misses
  still moves the hash the gate compares (`CHANGED` with no moved component).
- **The card URL and the signing key cannot be updated.** A move is a new
  registration that starts unpinned. That closes R22 for the peer record
  without a `redirectsStoredCredential` analogue, because there is no field to
  repoint.
- **Admission reads the live card, never `observedCardHash`.** The observed
  hash is for display. Gating on it would admit a peer whose card changed after
  the last read.
- **Registration survives an unreadable card.** The row is written and the peer
  is refused (`PEER_UNPINNED`) until a read and an approval succeed. Refusing
  the registration would make a partner's outage block the paperwork.
- **No UI in this step.** The pilot peer is registered and pinned by an
  operator through the API. A page belongs with the traffic it governs (4b),
  and the routes are registered as API-only surface in
  `tests/guards/agentic-route-inbound-links.test.ts` with that reason.
- **Retention class is Business record**, as step 0e set it in the roadmap.
