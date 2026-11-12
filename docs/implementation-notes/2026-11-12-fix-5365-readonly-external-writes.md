# 2026-11-12 — A read-only run is offered no external write (#5365)

## Design

`offerToolSet` (`src/lib/agentic/engine-tools/offer-tools.ts`) is the one seam
every engine's tool set passes through, and it already receives the
definition's `readOnly`. It withheld only the PROPOSE list. External tools —
an MCP server's tools and the A2A send tools — are appended to the READ
candidate list by `allReadTools`, so a read-only run (a Test run of an agent
profile, an Ask run, a Flue workflow with no PROPOSE step) was still offered
every write-classified external tool and every A2A send. Their dispatch opens a
`PROPOSE_ONLY` proposal, a `DRY_RUN` journal row, or at `AUTOMATIC` a journal
row the `external-write-dispatch` pass sends with no approval.

Two layers now:

1. **The offer.** Under `readOnly`, an external candidate whose
   `externalConnection.declaresWrite` is true is withheld and listed as
   `READ_ONLY_WORKFLOW`. `adapterFor` sets that fact from the same
   `declaresWrite(def.annotations)` the dispatch branches on, and `true` for
   every A2A send. External reads stay offered.
2. **The backstop.** Every `run` closure a read-only offer hands out is bound
   to an invocation whose context carries `readOnlyRun: true`. `dispatchWrite`
   (external tools) and `dispatchA2aSend` refuse that context first — before
   the pairing lookup, the prior-state read, the peer's kill switch or any row —
   with a message ending in the module's `Nothing was sent.` sentinel.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/types.ts` | `RequestContext.readOnlyRun` — narrows only, like `a2aInbound` |
| `src/lib/agentic/engine-tools/offer-tools.ts` | withholds external writes under `readOnly`; binds the closures to the flagged context |
| `src/lib/mcp/tools/external-tools.ts` | `dispatchWrite` refuses a read-only run at every rung |
| `src/app-layer/usecases/a2a-outbound.ts` | `dispatchA2aSend` refuses a read-only run (metric outcome `READ_ONLY_RUN_REFUSED`) |
| `CLAUDE.md` | the "not read-only on Flue" paragraph states both layers |

## Decisions

- **The flag is set in `offerToolSet`, not in `executeFrom`.** It is the one
  place every engine (Flue, the Tool Runner) passes the definition's
  `readOnly`, so the closures and the offer cannot disagree, and it covers a
  caller that builds a tool set outside a workflow run. `executeFrom` would also
  be a sound seam; it was left alone because other branches are changing it.
- **`DRY_RUN` is refused too.** A dry run sends nothing, but it writes a
  journal row on the run's behalf, and a run that declares it writes nothing
  has no intent to record.
- **The refusal precedes the prior-state read.** That read goes to the far end;
  with no write to describe it is a call the run has no reason to make.
- **External reads are untouched**, so `access-posture` still reaches the
  directory; only `declaresWrite` decides, and an unclassified tool already
  counts as a write there.
