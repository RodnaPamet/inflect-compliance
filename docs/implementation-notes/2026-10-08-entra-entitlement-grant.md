# 2026-10-08 — Entra entitlement grant (time-bounded access packages)

**Commit:** see the PR for #3297 — `feat(entra): time-bounded access package grants, with the expiry as a refusal`

## Design

The owner's question was "can I wire the UI to Entra MCP server and tell an agent
to grant user X access Y for a limited time". The answer turned out to have two
parts, and the first one was a correction.

**Microsoft's Entra MCP server cannot do it, and not for the reason first given.**
Enumerated live against the tenant rather than read from the docs:

```
42 published scopes, of which one is a genuine write:
  MCP.EntitlementMgmt-SubjectAccess.ReadWrite
    "Read and write self-service entitlement management resources"

tools/list returns THREE tools, and the only executor is:
  microsoft_graph_get   properties: { relativeUrl: string }   required: ['relativeUrl']
```

One parameter. No `method`, no `body` — structurally GET-only. So the write scope
is published but **unexercised by any tool**. An earlier read of two truncated
documentation listings concluded the namespace was read-only, which was wrong;
the correct statement is narrower and shorter-dated. The scope's own wording is
also load-bearing: *"on behalf of the signed-in user"*, i.e. delegated, so even
when a write tool lands it cannot run unattended.

**So the grant is ours to make, and this module makes it.** Owner decision
2026-10-08, choosing "our own MCP server with a grant tool" over waiting or
bolting a grant onto the Entra writer, explicitly for the governance rails on the
external-write path.

## The shape, and why it is not where it looks like it should go

The obvious home was a third `IdentityDirection` beside `leaver` and `joiner`.
That is wrong, and `write-direction.ts` is the reason: a direction there is an
ACCOUNT LIFECYCLE operation gated by the identity write ladder. An
access-package assignment creates no account and disables none. It is an
EXTERNAL WRITE, governed by the parallel rung on
`IntegrationConnection.externalWriteMode`.

The repo had already made this unmistakable, in two places:

- `storedWriteFlag`'s `never` arm makes a third direction a compile error on
  purpose, so taking that door would have been a deliberate act rather than a
  slip.
- `CLAUDE.md` states it directly — *"a mover is not an unimplemented direction —
  it is an unrepresentable one"*.

## The separation `write-direction.ts` says is impossible IS available here

That module's central argument is that the credential cannot hold the two
directions apart: `User.ReadWrite.All` is sufficient to create AND is a member of
the writer's own `WRITE_ROLES`, so any consent sufficient to create is sufficient
to disable, and a client-credentials token asks for `.default` — not a request at
all. The per-connection flag is the only place the separation can live.

Entitlement management is the happier case, and it is worth recording because it
is the opposite of what the joiner's experience predicts:

| permission | what it grants | account lifecycle? |
|---|---|---|
| `EntitlementManagement.ReadWrite.All` | assign access packages | **no** |
| *Access package assignment manager* (role) | the least-privileged form | **no** |

An app consented only for entitlement management cannot disable a user, cannot
create one, and cannot read the directory wholesale. So the operational advice is
a consent scoped to entitlement management ALONE — not a widening of whatever the
leaver already holds. Nothing in code can enforce that, which is why it is
documented in the module header where an operator setting it up will read it.

## Entra expires the assignment, not us

`schedule.expiration.type: 'afterDateTime'` with an `endDateTime` is native. An
earlier design sketch assumed we would need our own revocation scheduler; we do
not, and must not build one. A second expiry mechanism is a second thing that can
be down on the day it matters, and its failure is silent in the dangerous
direction — access live past its end date while our records say it lapsed.

## Decisions

- **An unbounded grant is REFUSED, not defaulted.** `endDateTime` is required and
  `expiryRefusal` refuses its absence. The way products acquire permanent grants
  by accident is exactly an optional expiry omitted from one call. Omission must
  not be able to escalate the operation. Permanent assignment, if ever wanted,
  needs its own verb, approval copy and consent.

- **An Invalid Date is a live path, not a defensive one.** A date from an operator
  form or a tool argument is `new Date(<whatever was typed>)`, and
  `new Date('next friday')` has a `NaN` time. Every comparison against NaN is
  false, so an unchecked one sails through BOTH bounds and reaches Graph as the
  string `"Invalid Date"`.

- **`MAX_GRANT_DAYS = 90`, anchored rather than chosen.** 90 days is this
  product's own `QUARTERLY` cadence (`automation-runner.ts` maps it; `risk-report.ts`
  advances a quarterly due date by three months), which makes it the
  recertification interval. So the bound states something true: **a grant may not
  outlive the review that would catch it.** A 180-day assignment is live through a
  whole cycle without appearing in one as a decision — the exact shape of finding
  an access review exists to produce.

- **The cap REFUSES rather than clamps.** Silently shortening 180 days to 90
  returns success for an operation nobody asked for, and the person who needed 180
  days discovers the difference when access vanishes mid-project. Same reasoning
  as `MAX_POPULATION_ROWS`, which refuses at the cap rather than truncating.

- **The refusal runs before the token exchange.** A grant that must not happen
  must not be observable to the far end at all — not even as a credential round
  trip. Same ordering as `rpc`'s egress scan in the MCP client. The tests assert
  ZERO fetch calls, not zero Graph calls.

- **`adminAdd`, and `userAdd` is deliberately unreachable.** Self-service (the
  subject requesting their own access) is a different operation with a different
  approval story. It must not be reachable by flipping a field.

- **The prior-state read filters on BOTH target and package.** This is the read
  `setPriorStateRead` will pair with the write, and the pairing's own rule decides
  which read it must be: the state the write REPLACES. A membership or
  PIM-eligibility read would be a plausible-looking record of a DIFFERENT fact,
  and the journal presents whatever it captures as authoritative.

- **No `{ complete: true }`-style success is reported for a response with no id.**
  Graph accepting the request and returning nothing followable means the
  assignment may well exist; a caller recording "no id" as "no grant" would be
  wrong in the direction that matters, so it throws and names reconciliation.

- **`graphErrorCode` duplicates `provisioner.ts`'s `bodyOf` rather than importing
  it.** That one is private to the provisioner, and widening its surface for a
  second caller is how a helper becomes a shared dependency nobody owns. Both
  quote the Graph error CODE and not the message, because the message routinely
  embeds the object id this subsystem keeps out of logs.

## Files

| file | role |
|---|---|
| `src/app-layer/integrations/providers/entra-id/entitlement.ts` | the client: `expiryRefusal` (pure), `readAssignments`, `requestTimeBoundedAssignment` |
| `tests/unit/entra-entitlement-grant.test.ts` | the refusals, the zero-request proof, the request body, the prior-state read |

## What this does NOT do

Named because the gap is the next step rather than an oversight:

- **No MCP tool advertises this yet.** `src/lib/mcp/` forbids direct Prisma, so a
  tool goes tool → usecase → this client. That is the next PR.
- **No pairing is registered.** `setPriorStateRead` needs both halves to exist as
  external MCP tools on one connection first (#3300).
- **No operator surface.** #3301, and it still carries the open question of how
  the dispatch reaches our own server: `external-write-dispatch` requires a `url`
  and goes through `safeFetch`, which blocks loopback by design, so the tool must
  sit at a publicly reachable origin. The exposure is narrower than it sounds —
  a tool is offered only if the agent is GRANTED it, a pin is on file, the live
  definition matches that pin, and the connection is enabled — but it is a
  decision to make explicitly rather than inherit.
- **The app-only claim wants confirming against a real tenant.** The Graph
  reference's permissions table and the prose around it do not read consistently
  on application support for `assignmentRequests`. The prose describes app-only
  scenarios explicitly and names the least-privileged role; the table reads
  "Not available" on a neighbouring row. Recorded as a caveat rather than
  smoothed over, because this epic has already been wrong once from reading a
  Microsoft table too confidently.
