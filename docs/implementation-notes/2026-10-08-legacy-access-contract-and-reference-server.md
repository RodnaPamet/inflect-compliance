# 2026-10-08 — Publish the inflect-legacy-access/1 contract and its reference server (Step 1a)

**Commit:** `#3257` — "Publish the inflect-legacy-access/1 contract and its
reference server (Step 1a)".

> **Written after the fact.** Reconstructed on 2026-10-16 from #3257's
> description, its diff and the phases document — not from doing the work. The
> step shipped without a note, which is part of what #3229 stayed open for.

## What it did

One source of truth for the wire contract, a document an operator can build
against, and a fake server that is both the executable reference and the fault
injector every later step's tests run through. Five files, 1,057 insertions, no
deletions.

| File | Role |
| --- | --- |
| `docs/legacy-mcp-access-contract.md` | the operator-facing contract (158 lines) |
| `src/lib/mcp/client/contract.ts` | the schemas (233 lines) |
| `tests/helpers/legacy-mcp-fake-server.ts` | the normative reference implementation (331 lines) |
| `tests/unit/legacy-mcp-contract.test.ts` | the suite that checks the three against each other (332 lines) |
| `docs/_status/doc-classification.json` | registers the contract document |

## The three artefacts are checked against each other

The document names the fake server as the **normative reference
implementation**, and the suite validates that server's output against the
schemas. So prose, reference and schema cannot drift apart silently — they are
checked against one another rather than merely existing near one another.

That is the property that made the server reusable three weeks later: #3592
wrapped this same `createLegacyMcpFakeServer` in `node:http` and served it over
public HTTPS to drive the first production pull. The fixture the unit tests run
against and the fixture the proving run dialled are the same object, which is
only safe because this step made it normative.

## Every dimension is bounded

A legacy MCP server is hosted by the operator, and is a third party in the
security sense even when the customer runs it themselves — the bytes arrive
over the network from software we did not write.

| Dimension | Limit |
| --- | --- |
| Columns per manifest | 200 |
| Column-name length | 128 |
| Snapshot-id length | 200 |
| Rows per page | 1,000 |
| Pages per snapshot | 1,000 |
| One cell | 4,096 |

These are the **schema's** bounds. The document states that the transport
enforces the same numbers *before* parsing, because a schema cannot protect you
from a body already read into memory — a bound stated in only one of those two
places is not a bound. Step 1b holds that half.

## Strict envelopes are the load-bearing part

Zod's default would **strip** an unknown key and hand back a clean object — so a
server sending more than it should would look healthy, and the oversharing
fault would be undetectable. Refusing is what makes it visible.

Rows are the one documented exception: their keys *are* the manifest's column
names, so there is no fixed key set to be strict about, and the check that
matters — no column the mapping did not request — belongs where the manifest is
known, in 1b and 2a. Stating it in the row schema would be a pretence.

## The fault set

The reference server injects, by name: `tornSnapshot`, `oversharing`,
`oversizedPage`, `slowResponse`, `malformedJson`, `serverSentEvents`,
`unsupportedProtocolVersion`, `toolsAdvertised`, and a redirect. Each has a test
showing it firing — which is what makes the server a fault injector rather than
a happy-path stub, and what let every later step test its refusal paths without
inventing its own broken server.
