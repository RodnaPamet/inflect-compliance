# 2026-09-28 — the dispatch, and the read that makes a write accountable (#2861)

**Commit:** `<pending> feat(agentic): dispatch an external write under the connection's rung`

## Design

The last piece. The ladder (#2933), the storage (#2969), the surface (#2972), the
`DISABLED` exemption and backfill (#2974), the connection gate (#2976) and the
journal (#2977) were all built so that this could arrive already governed.

**Owner decision, 2026-09-28: a tenant pairs a read tool with each write tool.**
MCP has no generic "read the thing this write will change", so decision 2 — read
prior state first, refuse the write if it cannot be read — needed somebody to say
WHICH read corresponds to which write. An OWNER nominates one of the same
server's read tools; it runs with the write's own arguments immediately before
the write goes out, and its result becomes `priorStateJson`.

Three alternatives were rejected, and the reasons are worth keeping:

- **Let the far end return prior state in the write's result.** No storage, no UI,
  and `deploy/orangehrm-mcp/server.mjs` already does exactly this. But a lost
  response then loses the prior state with it — which is precisely what reading
  first exists to prevent — and it only works for far ends we or the customer
  control.
- **Derive the read from the write by name.** No configuration at all, and
  silently wrong the moment a server's naming differs. A wrong prior state is
  worse than none, because the journal presents it as authoritative.
- **Refuse every write until something better exists.** Honest, and a path that
  always refuses is the shape #2241 deleted from the identity ladder.

## The order in `dispatchWrite` is the design

```
1. is there a pairing?   no  → REFUSE. nothing sent, nothing journalled.
2. run the paired READ with the WRITE's own arguments
3. apply the rung
```

Refusing **before** the read matters: a pairing is what makes the write
accountable, so a call that cannot be accounted for should not reach the far end
at all — not even the read half.

The read gets the write's arguments **verbatim**, because the pairing's whole
claim is "this read describes the object that write is about to change".
Transforming between them would make that claim depend on a mapping nobody
declared. A read whose parameters genuinely differ is one that cannot honestly be
paired, and the setter refusing it is the correct outcome.

## What a dry run now does, and why that is better than it looks

Because a READ is permitted at `DRY_RUN`, the paired read runs there too. So a dry
run captures **real prior state** — it can say "this would change X from A to B"
rather than only recording intended arguments. That is a consequence of the
owner's earlier reachability decision rather than something designed for, and it
is why `priorStateJson` could stay `NOT NULL`.

The model is told plainly:

> DRY RUN — nothing was sent … Do not report this as a completed change.

Without that, the agent reports a change it did not make, and the run's own
conclusion is what a reader takes away — not the rung buried in a connection's
settings.

## `declaresWrite` is one definition, and it is not a security boundary

Three places ask whether a tool is a write: the catalogue an operator reads, the
setter that validates a pairing, and the dispatch. Three copies would be three
chances to disagree, and the one that mattered would be the quiet one — which is
exactly #2957, two seams evaluating the same fact differently.

It is **not** a boundary. `readOnlyHint` comes from the far end; pinning it
(#2941) makes it STABLE, never HONEST. That is why the owner put REACHABILITY on
the rung, which does not consult the hint at all: a lying server can get a "read"
sent at `DRY_RUN`, which it could equally get at `AUTOMATIC`, but it cannot reach
a connection nobody granted it.

**Unknown counts as a write**, and the consequence is real: a server that declares
nothing has every tool classified as a write, so every tool needs a pairing. That
is conservative to the point of being inconvenient, and still the right direction
— the alternative lets any server opt out of the write path by staying silent.

## The route ships WITH the dispatch

The dispatch refuses an unpaired write. Without a route an OWNER could not create
a pairing, so every write tool would refuse permanently and the only way to
configure one would be a hand-written request — defect #3 of the 2026-09-26 chain
exactly.

**The route, not a surface.** Nothing in the product calls it yet — an OWNER
creates a pairing with a hand-written request until #2982 lands. That is a real
gap and it is filed rather than hidden: the honest version of "the route ships
with the dispatch" is that the API exists, not that an operator can reach it.

It is not urgent in the way the original defect was, and the difference is worth
stating. `EXTERNAL_MAX_MODE` is `DRY_RUN`, so no write is dispatched at any rung
this build permits; a write with no pairing sends nothing at all. Nothing is
inert-while-looking-live. The order is #2982, then raise the clamp.

Its gates are inline in each export rather than in named consts, which is the one
place this route departs from its siblings.
`destructive-route-denial-census` reads the text of each `export const DELETE = …`
block, and with the gate one binding away it reported the route as destructive and
ungated. The guard was right about what it could see and wrong about the route —
the worse of the two to leave standing, because a route that merely LOOKS ungated
will be triaged as one by whoever reads the list next. The fix is to put the gate
where a reader of the export finds it, not to declare an exemption for a route
that is gated.

## Two things the existing tests said when this landed

**Three resolution tests broke**, because the shared `ALERTS` fixture declared no
annotations and fail-closed now classifies it as a write. The fixture now declares
`readOnlyHint: true`, which is what a real server that wants its reads callable
does.

**An assertion of mine was vacuous and I caught it on review.** "and NOTHING is
stored by any of those" ran after `beforeEach` cleared the table, so it started
empty and would have passed however the refusals behaved. It now performs the four
refusals itself and then asserts the table is empty.

## Risk assessment and rollback

This is the first change in the series that can send something to a customer's
system — and at `DRY_RUN`, the only rung `EXTERNAL_MAX_MODE` permits, the only
thing sent is the paired READ. The write itself is unreachable: `PROPOSE_ONLY` and
`AUTOMATIC` cannot be stored, and `dispatchWrite` refuses them explicitly rather
than falling through.

So the blast radius is one extra read call per attempted write, on a connection an
OWNER has armed, using a read the same OWNER nominated. A write tool with no
pairing sends nothing at all.

Rollback is reverting the commit: write tools go back to being dispatched as
ordinary reads, which is what they were before the classification existed.
