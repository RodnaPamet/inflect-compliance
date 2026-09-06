# 2026-09-06 — the provenance envelope reaches the engine, and `sourceId` stops being a kill-switch

**Commit:** `<sha> fix(agentic): read the provenance envelope in the engine, and type the propose path's trust claim`

Two independent defects in the agent content-provenance work (#2330, items 1 and 2).
Item 3 — the quarantine triage surface — is deferred: it needs a schema index, and
no schema change was made here.

## Design

### Item 1 — the label was real for external clients and absent from the engine

`runReadTool` labels every payload with `buildProvenanceEnvelope(name)` and appends
it as a SECOND MCP content block, so `content[0]` stays the exact JSON every
existing agent and test parses. That is the right wire shape and it worked for an
external MCP client, which reads the whole result.

IC's own workflow engine read `content[0]` and returned:

```ts
function parseToolResult(result) { return JSON.parse(result.content[0]?.text ?? 'null'); }
```

So on every internal READ and PROPOSE step the label was discarded. The tagging was
real for the surface it was built against and absent from the one the product
actually runs — a builder with no reader.

**Chosen: (a), carry it — bounded at the step record, not the sealed context.**
What consumes `parseToolResult` decided the shape:

- `context.outputs[step.label]` — indexed by every workflow definition's
  `args(context)` / `buildItems(context)` / `synthesize(context)`, and sealed into
  the hash-chained `contextJson`;
- `estimateTokens(output)` — the run's token budget;
- `recordStep(...)` — the `WorkflowStep` row and one hash-chained audit entry.

`parseToolResult` now returns `{ output, provenance }`. `output` is `content[0]` and
only `content[0]`, so all three consumers above see exactly what they saw before.
The label rides into `StepRecord` and out to `AuditLog.detailsJson.provenance`.

The wire format now has ONE spelling, in `content-provenance.ts`:
`provenanceContentBlock` (writer, called by the registry) and
`provenanceOfToolResult` (reader, called by the engine). The reader SEARCHES blocks
rather than indexing `content[1]`, so appending another block later cannot silently
unhook the label — and it starts at index 1, because `content[0]` is untrusted
tenant text and a reader that accepted an envelope found there would let an injected
payload hand itself the one label that may carry instruction.

The reader JSON-parses each block ONCE. A first draft split the work between
`parseProvenanceEnvelope` (label) and an `isProvenanceEnvelopeBlock` predicate
(structure), because a label alone cannot say whether the block was an envelope at
all — so a non-envelope block could not be told apart from an envelope reading
untrusted, and the search had to ask twice. Two functions parsing the same text had
to agree forever on what an envelope is. The private `readProvenanceEnvelope`
carries the distinction in its RETURN TYPE instead: `null` is "not an envelope,
keep looking", a `ContentProvenance` is "an envelope decided" — and for a label this
build does not know that decision is the untrusted one.

### Item 2 — `sourceId` was a latent quarantine kill-switch

`guardAgentProposal({ sourceId })` resolved the claim through the allowlist, where
`platform.*` ids are `SYSTEM`, for which `mayCarryInstruction` is true — and the
quarantine rung was `worstIsMalicious && !mayCarryInstruction(provenance)`. One
argument, on the one function that decides whether injected content becomes a
compliance record, and the failure is silent: proposals stop being quarantined and
the queue looks healthy.

Verified latent: `guardAgentProposal` has exactly one caller
(`createAgentProposal`), which passed no `sourceId`, and `ProposeInput` had no such
field to forward.

**Fixed in three moves, and the third is a deletion.**

1. `sourceId` is now `DataOnlySourceId` — the allowlist minus every id whose label
   may carry instruction, DERIVED from the table via a mapped type rather than
   listed a second time, so a new `SYSTEM` row drops out of it with no maintenance.
   A `platform.*` literal at that position is a compile error.

2. A type is not a runtime property, so `resolveProposalProvenance` also refuses an
   instruction-bearing claim and reports the untrusted label. Its predicate is
   `isDataOnlySourceId`, exported from the module that owns the type, so the clamp
   and the type are one rule applied twice rather than two rules that can disagree.
   It clamps rather than throws: the caller's next move on a quarantine is to WRITE
   the row as evidence of the attempt, and a throw would delete that evidence to
   report a programming error the compiler already refused.

3. **The ladder lost its provenance term.** Once (2) landed, `provenance` reaching
   the rung could never be instruction-bearing, so `!mayCarryInstruction(provenance)`
   was always true — an operand no test could reach, in the ladder that decides
   quarantine. That is not defence in depth; it is a line nothing notices when it
   stops meaning what it says, and deleting it was proved a no-op by the suite. The
   rung is now `worstIsMalicious` alone.

What the clamp still protects, after (3), is the REPORTED label rather than the
verdict: `createAgentProposal` writes `guard.provenance` onto the `AiDecisionLog`
row and the audit entry, so an honoured `SYSTEM` claim would leave the durable
record of an agent's proposal saying the platform authored it.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/content-provenance.ts` | `as const satisfies` on the allowlist so ids are literal types; `INSTRUCTION_BEARING_PROVENANCE` named once for the runtime check and the type filter; `ContentSourceId` / `InstructionBearingSourceId` / `DataOnlySourceId` / `isDataOnlySourceId`; `provenanceContentBlock` (writer) + `provenanceOfToolResult` (reader, one JSON parse per block via the private `readProvenanceEnvelope`) |
| `src/lib/mcp/tools/registry.ts` | `runReadTool` emits the envelope through `provenanceContentBlock` — one spelling of the wire format |
| `src/app-layer/usecases/workflow-runs.ts` | `parseToolResult` returns `{ output, provenance }`; `StepRecord.provenance`; the label lands in the step's audit row |
| `src/app-layer/ai/guard/proposal-guard.ts` | `sourceId: DataOnlySourceId \| null`; `resolveProposalProvenance` clamps an instruction-bearing claim via `isDataOnlySourceId`; the ladder's unreachable provenance operand deleted |
| `src/app-layer/usecases/agent-proposals.ts` | Comment only — the guard reads the scan, not the provenance |
| `tests/unit/workflow-step-provenance.test.ts` | Item 1: the label reaches the step record and is the tool's own; `content[0]` untouched; four fail-closed cases; `null` for the steps that call no tool; the block SEARCH; and that reading the label cannot end a run |
| `tests/unit/agent-proposal-provenance-claim.test.ts` | Item 2: every `SYSTEM` id in the allowlist is refused at runtime; a hand-written oracle tying the union to the table; `@ts-expect-error` on the literals; positive controls |
| `tests/unit/agent-output-guard.test.ts` | The case that asserted the hole (a `SYSTEM` sourceId returning `FLAGGED`) is replaced by a pointer to the new file |

## Decisions

- **The provenance is NOT written into the sealed workflow context, deliberately.**
  `computeContextLink` hashes `canonicalJsonStringify({ input, outputs })` and
  `SealedContextSchema` is `.strict()`. Adding a top-level field means either
  bumping `CONTEXT_ENVELOPE_VERSION` — which invalidates every stored link and
  halts every in-flight run — or leaving the field OUT of the digest, where it is
  forgeable by exactly the writer the chain exists to catch. A trust label an
  attacker can flip is worse than no label. Hiding it under a reserved key inside
  `outputs` would be chain-covered but would collide with the step-label namespace
  the type says that map is for. The audit row is durable, hash-chained, never
  deleted, and carries no content — that is the right home.

- **`WorkflowStep` gains no column.** Schema changes were out of scope for this
  change. The audit row carries the label today; a column is a follow-up, and
  `AuditLog` is the store the retention policy already promises to keep.

- **The reader is fail-closed and the writer is not asserted at index 1.** An
  absent, unparseable or unknown-label envelope reads as `THIRD_PARTY_INGESTED`.
  A PROPOSE result legitimately has no envelope, and untrusted is the right answer
  for it. The `content[0]` exclusion is the security-relevant half.

- **A derived union, not a hand-written enum.** The issue offered "an enum of ids
  the propose path may legitimately claim". A copy drifts the moment somebody adds
  a `SYSTEM` row to the allowlist; the mapped type cannot.

- **Both halves of the fix, because they fail differently.** The type makes the bad
  call unwriteable and is checked by `npm run typecheck`; the clamp catches the
  values a type cannot reach (an `as` cast, a string read out of a row) and is
  checked by jest. Neither alone covers the other's class. **`isolatedModules` is
  on, so ts-jest does not typecheck** — a green run of
  `agent-proposal-provenance-claim.test.ts` says nothing about the type half, which
  was confirmed by widening `sourceId` back to `string | null` and watching all 34
  tests pass. The test file says so where somebody reading a green run would
  otherwise be misled.

- **An unreachable operand in a security ladder is a defect, not a backstop.** The
  temptation with (3) above was to keep `!mayCarryInstruction(provenance)` "just in
  case the clamp is removed later". The reviewer's objection is the right one:
  nothing can test it, so nothing tells you when it rots, and its presence invites
  the reader to believe the rung still makes a distinction it no longer makes. The
  removal is also the safe direction — the rung now quarantines a malicious scan
  unconditionally, and restoring an exception takes a deliberate edit.

- **The provenance read sits INSIDE `parseToolResult`'s `try`.** The first draft
  read it above, where a result with no `content` at all threw past the fallback —
  turning a shape the engine used to survive (`{ output: null }`, run continues)
  into a FAILED step and a dead run. `provenanceOfToolResult` was also made total,
  so today the two protections overlap and only removing BOTH is visible to the
  suite; the placement is documented at the function as the rule for the next read
  added there, rather than claimed as something a test holds.
