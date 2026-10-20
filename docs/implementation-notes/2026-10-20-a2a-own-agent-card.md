# 2026-10-20 — Inflect's own A2A agent card, and the identity it carries (#3742)

**Commit:** see the pull request for #3742.

## Design

Threat-model R19 was the last Required control: an operator handed each peer
Inflect's endpoint, its identity and its public key out of band, and nothing
published them as a signed, pinnable card.

```
GET  /api/a2a/{slug}/agent-card.json   public, rate-limited, one 404 for every "no card"
          │  names
          ├─ url ──────────────► POST /api/a2a/{slug}          per-tenant endpoint (new)
          ├─ x-inflect.identity ═ the card's own URL           what the tenant signs as, for every peer
          ├─ x-inflect.signingKeys: CURRENT (+ PREVIOUS for 7 days after a rotation)
          └─ x-inflect-signature: Ed25519 by the CURRENT key

POST /api/a2a/{slug}/peers/{peerId}    per-peer endpoint, kept for peers already given it
```

Both inbound routes call `handleInboundA2a`. The per-tenant one passes no peer
id; the usecase finds the peer from the SHA-256 of the bearer through a new
unique index `(tenantId, keyHash)`, and from there runs the per-peer route's
order unchanged: peer, kill, live credential in constant time, origin, receipt,
signing key, card admission, quota, replay, caps, parse.

The identity changed from `inflect:a2a/{tenantId}/{peerId}` to the card URL,
`{APP_URL}/api/a2a/{slug}/agent-card.json`, in both directions and for every
peer. `ownA2aIdentity` builds it for the outbound send and the operator's
hand-over; the inbound usecase builds it from the tenant row it already holds.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/a2a/own-card.ts` | Pure: build, sign, verify the card; the paths; the identity; the origin parser |
| `src/lib/agentic/a2a/origin.ts` | `inflectA2aOrigin()` — `APP_URL` as a bare https origin, else null |
| `src/lib/agentic/a2a/body.ts` | The capped body reader, shared by both inbound routes |
| `src/app-layer/usecases/a2a-agent-card.ts` | `getTenantA2aAgentCard`, `ownA2aIdentity` |
| `src/app-layer/usecases/a2a-inbound.ts` | Optional `peerId`; `NO_PUBLIC_ORIGIN`; card-URL identity |
| `src/app-layer/usecases/a2a-outbound.ts` | Signs as the card URL; no send offered or made without an origin |
| `src/app-layer/usecases/a2a-peer-credentials.ts` | `findPeerIdByInboundToken`; the hand-over names the card URL and the per-tenant endpoint |
| `src/app-layer/usecases/a2a-signing-key.ts` | `lastRetiredTenantA2aKey`, for the grace-period key |
| `src/app/api/a2a/[tenantSlug]/route.ts` | The per-tenant inbound endpoint |
| `src/app/api/a2a/[tenantSlug]/agent-card.json/route.ts` | The card |
| `prisma/migrations/20261020050000_a2a_inbound_credential_hash_unique/` | The unique index |

## Decisions

- **One card per tenant, not per agent** (owner, 2026-10-20). The pilot's peer
  is a second Inflect tenant, and two Inflect tenants cannot pin per-pair cards
  of each other: each card URL would need the peer id the other side assigns,
  which exists only once that side has registered this one, by that URL. The
  card therefore names no agent; `skills` is always empty.
- **The identity is the card URL** (owner, 2026-10-20). Inflect names a peer by
  its card URL. Naming itself `inflect:a2a/{tenantId}/{peerId}` was asymmetric,
  so a second Inflect tenant refused every receipt. Pair-binding is not lost: a
  receipt names both parties, sender and recipient, so a message signed for one
  tenant verifies at no other, and a message from one peer verifies as no other's.
- **The origin comes from `APP_URL` and nothing else**, and must be a bare
  https origin. The identity is signed into every receipt, so a value derived
  from the request — which a proxy turns into its bind address, and a direct
  caller into anything — would be signing something no peer can reach. Without
  one, A2A refuses `NO_PUBLIC_ORIGIN` both ways rather than guess.
- **The hash lookup includes revoked credentials.** It only names the peer;
  `matchPeerInboundCredential` then refuses a revoked one exactly as on the
  per-peer route. Including them means a revoked token is refused as its own
  peer's `BAD_CREDENTIAL`, which the operator can read on that peer's trail,
  rather than as a stranger's. A bearer no credential hashes to has no peer, so
  its `AUTHZ_DENIED` row is the tenant's.
- **The card is deterministic.** Ed25519 signing is deterministic and the card
  holds no timestamp of its own, so the same keys give the same bytes and a
  peer's pin holds until a key changes. Only a rotation, or the end of its
  seven-day grace period, changes the card, and each is a change the peer
  re-approves (pinning rule 6, now written for both sides).
- **The previous key is named for seven days after a rotation**, with the time
  it stops. It lets a peer that pinned the card before the rotation verify
  answers to tasks it sent under the old key. Past the window the card names
  only the new key. `A2A_PREVIOUS_KEY_GRACE_MS` is a source constant.
- **One 404 for every "no card".** Unknown slug, deleted tenant, no signing key
  and no origin are indistinguishable, so the public route is no oracle for
  which tenants exist or have set up A2A.
- **The per-peer route stays** (owner, 2026-10-20), for peers already given it.
  `/api/a2a` now has a per-method sweep in
  `tests/guards/machine-caller-paths-self-authenticate.test.ts`: a POST must be
  `handleInboundA2a`, a GET must be the card behind its rate limit, and any
  other method fails.
