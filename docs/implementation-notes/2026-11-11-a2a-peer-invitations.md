# 2026-11-11 — A2A peer invitations

**Commit:** see the pull request for #3752 ("one invitation instead of setting everything up twice").

## Design

Connecting two workspaces took eight manual acts, four on each side:
- register the other side;
- paste its key;
- approve its card;
- issue it a token, and store the token it issued as an outbound connection.

The owner called that needlessly complex. Their two decisions:
- a person in A still approves B's card, with one click;
- the key is read from the card (#5050).

```
A: createPeerInvitation ──► code = <A card URL>#iflinv_…   (hash stored, shown once)
B: previewPeerInvitation    reads A's card (writes nothing)
B: acceptPeerInvitation     register A (key from card) → approve pin (reviewed hash)
                            → issue A a token → POST signed acceptance to A
A: acceptPeerInvitationAtInviter
                            verify code/expiry, fetch B's card, verify signature by its key,
                            re-read the inviter → register B UNPINNED → issue B a token
                            → store B's token as A's outbound connection → claim ACCEPTED
                            → notify owner → answer { token }
B:                          store A's token as B's outbound connection
A: approvePeerAgentCard     a person reads B's card and pins it
```

Every write is an existing usecase (`registerPeerAgent`, `approvePeerAgentCard`,
`issuePeerInboundCredential`, `upsertIntegrationConnection`). The invitation adds
only the code, the machine route and the table.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma`, migration `20261111220000_peer_invitations` | `PeerInvitation`. The trigger makes it one-way and freezes the grant. RLS, no `DELETE` for `app_user` |
| `src/lib/agentic/a2a/invitation.ts` | The code, the accept URL, the signed acceptance body (pure) |
| `src/app-layer/usecases/peer-invitations.ts` | The only writer: create, list, revoke, preview, accept, the inviter's handler |
| `src/app/api/t/[tenantSlug]/admin/agents/peers/invitations/**` | Admin routes, under the peers rule's `admin.agent_registry` |
| `src/app/api/a2a/[tenantSlug]/invitations/route.ts` | The machine route: triaged `PROTOCOL_CREDENTIAL`, with a capped body |
| `agents/peers/PeerInvitationForms.tsx` | Invite, the one-time code panel, and accept |

## Decisions

- **The acceptor proves its card by signing.** The inviter verifies the
  acceptance against the key the acceptor's own card names, and that card must
  verify under that key (`cardSigningKey`). So the code is a capability to
  *propose* a connection, never to name an arbitrary card.
- **Nothing is pinned by a machine.** The inviter registers the acceptor
  unpinned, which is the 2026-10-18 rule, unchanged. One click by a person
  remains, as the owner chose.
- **The inviter acts as the person who invited, re-read on arrival.** This is
  the same principle as #4400's manual passes, but this one refuses: no
  scheduled run makes the connection anyway, so there is nothing to fall back
  to.
- **The claim comes last, conditional on PENDING.** If a racing second
  acceptance loses, it revokes the token it issued.
- **`ALREADY_CONNECTED` on the accepting side.** Re-accepting would have
  revoked a working token before the inviter could refuse. Reconnecting is a
  deliberate revoke first.
- **Names carry the card's address.** Every Inflect card is named "Inflect",
  and connection names are unique per provider. So both the peer and its
  connection are labelled `host/slug`.
- **The connections store no rung.** A null rung reads as DISABLED through
  `coerceStoredMode`, so sending stays off until an owner widens it.
