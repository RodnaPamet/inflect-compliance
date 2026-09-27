# 2026-09-27 — the rung gates whether an agent may call a connection at all (#2861)

**Commit:** `<pending> feat(agentic): gate external tool resolution on the connection's rung`

## Design

This is the reader the storage was built for. Until now `externalWriteMode` was a
column with an OWNER-gated setter and a surface, and nothing consulted it — the
shape this repo files under "wired is not delivered".

**What the rung means, per the owner's decision of 2026-09-27: reachability.** The
three options on the table were

1. gate on the server's pinned `readOnlyHint`,
2. have a human classify each tool read or write at approval time,
3. have the rung govern *every* call from the connection.

The owner chose (3), the strongest. (1) and (2) both key on `readOnlyHint`, and it
is a hint the FAR END supplies — pinning it makes it stable, not honest, so a
server that declares read-only and writes anyway passes either gate.

**The reading matters, and the obvious one is wrong.** "Governs every call" cannot
mean each rung's WRITE semantics apply to reads: `DRY_RUN` would record a read and
send nothing, `PROPOSE_ONLY` would queue a read for human approval, and reads would
work only at `AUTOMATIC` — putting #2859's proven read capability behind the
highest write authority. So:

```
DISABLED      no call at all
DRY_RUN       reads permitted; writes recorded, not sent
PROPOSE_ONLY  reads permitted; writes queued for a human
AUTOMATIC     reads permitted; writes dispatched
```

## Files

| file | role |
| --- | --- |
| `src/app-layer/usecases/external-mcp-tools.ts` | the gate, first statement of the resolver's connection loop |
| `tests/unit/external-tool-resolution.test.ts` | 11 assertions, including the catalogue asymmetry |

## Decisions

- **The gate is the FIRST statement in the loop**, above `authorizationFor` and
  `listTools`. A connection the agent may not call should cost neither a decrypted
  secret nor an outbound request: minting a token would exercise a credential on
  behalf of an authority that was refused, and `tools/list` would tell a third
  party that an agent had tried. Deny-by-default is cheapest when it is also
  first, and there is a test that the socket is not opened.

- **The CATALOGUE is not gated, and that is the load-bearing asymmetry.**
  `listExternalMcpTools` runs the same connection query forty lines up and is
  deliberately left alone. Gating it would be circular: an operator could not see
  which tools a server offers until they had widened the rung, and widening it is
  the decision the tool list exists to inform. One is what an OPERATOR reads; the
  other is what an AGENT gets. Pinned by a source assertion bounded to each
  function's body, because the natural tidy-up — "make both selects the same" —
  silently gates the catalogue and nothing else would notice.

- **`coerceStoredMode`, never the raw column.** An unrecognised rung, a
  lower-cased one, and a null all become `DISABLED`. The direction is the whole
  point: an old container meeting a rung introduced after it shipped must refuse
  the call rather than permit it.

- **A refused connection contributes nothing and does not throw**, the same shape
  as the existing manifest refusal. Failing the invocation would let one refused
  connection halt an agent's unrelated internal work.

## What the existing tests said when the gate landed

Ten of them broke, immediately, because the shared fixture had no
`externalWriteMode` and an absent value coerces to `DISABLED`. That was the gate
working rather than a problem — and worth recording, because the nine that kept
passing were exactly the ones asserting that nothing is offered. A suite where the
deny-by-default cases pass and the permit cases fail is the signature of a gate
that is closed, which is the state you want to see before you open it.

The fixture now carries `externalWriteMode: 'DRY_RUN'` with a comment saying what
that models: a connection an operator has permitted. A fixture without it models
one nobody has, which is a different test.

## Risk assessment and rollback

This is the first change in the #2861 series that alters what an agent can do, and
it is a REFUSAL being added. The blast radius is every `mcp-server` connection at
`DISABLED` — which in production is none, because #2974's backfill set the one
existing connection to `DRY_RUN` before this shipped. That ordering is the whole
reason the backfill went first.

Rollback is reverting the commit: the column goes back to having no reader, and
every connection is reachable again as it was before.
