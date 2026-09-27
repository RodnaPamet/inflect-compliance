# 2026-09-27 — the annotations axis reaches the seam that guards a call

**Commit:** `<pending> fix(mcp): carry declared tool annotations into the funnel`

## Design

#2941 gave MCP tool annotations — `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint` — their own hash on the manifest pin, so a
server could not redeclare a read tool as a write while producing an identical
`manifestHash`. The hashing was correct. One of its two consumers was not.

There are two seams that verify a tool against its pin, and they disagreed about
the same row:

| seam | builds its definition from | annotations |
| --- | --- | --- |
| `resolveGrantedExternalTools` (catalogue) | the live `tools/list` descriptor | **present** — `annotations: descriptor.annotations` |
| `assertToolManifestPinned` (the funnel) | the `McpReadTool` it is about to run | **absent** — the type had no such field |

`McpReadTool` carried no `annotations`, so the funnel's live side was
`hashToolManifest({… annotations: undefined})` — the hash of `null` — for every
tool, always. Against a pin the catalogue had taken over the real hints, that
mismatched unconditionally:

```
descriptionHash   match      ✓
schemaHash        match      ✓
manifestHash      match      ✓
annotationsHash   MISMATCH   ← a constant, not an observation
→ ANNOTATIONS_CHANGED, isSecurityEvent: true, mustRefuse: false
```

**The axis had no working configuration.** Because the live side was a constant,
both possible states of a pin failed, in opposite directions:

| pin's `annotationsHash` | what the funnel did |
| --- | --- |
| `NULL` — every production pin today | `verifyToolManifest` skips the comparison (a null must not be compared, or pre-#2941 pins would all report drift). So the axis never fires, and a genuine flip is **never caught**. |
| non-`NULL` — any approval under #2941's code | live `hash(null)` ≠ the pin, so **every** call to that tool mismatches, permanently and un-clearably: re-approving writes the real hash again. |

A pin can only move from the first row to the second by being approved, so there
is no state in which the axis correctly reports. It is quiet until somebody
re-approves a tool and then wrong about every call — and in neither regime can it
distinguish a far end that genuinely flipped `readOnlyHint: true → false` from one
that changed nothing, because the side it compares against never varies.

And it was silent, because `mustRefuse: false` had been implemented as an early
`return` sitting *above* the recording:

```ts
if (!verdict.mustRefuse) return;          // ← the finding dies here
recordToolManifestDrift({ … });
logger.error('mcp: tool manifest drift …');
```

So the one verdict this axis produces reached no metric, no log, and no operator.
`isSecurityEvent` had exactly one reader in `src/`, and it was the control-test
service — not the funnel.

## How it was found, and why the proving run passed anyway

The 2026-09-26 Entra proving run succeeded end to end: `toolCalls: 5`,
`failedToolCalls: 0`, three tools all declaring `readOnlyHint: true`. That is
consistent, and it was worth checking that it was, rather than assuming the run's
success exonerated the path. The catalogue resolver refuses anything that is not
`APPROVED` — so had the defect been *there*, the tools would have vanished from
the agent's offered set and the run could not have called them. It verifies from
the live descriptor with annotations included, correctly returned `APPROVED`, and
offered the tools. The funnel then mismatched, computed a security event, and
discarded it. Only the quiet seam was wrong, which is why a green run and a
green suite both held.

**Measured against the pins that run actually left on file, which is what
corrected the first version of this note.** I had written that the mismatch fired
on every external call. It has not fired in production even once: all three Entra
pins carry `annotationsHash = NULL` (approved 2026-09-26 15:06, before #2941's
code was deployed), so production sits in the first row of the table above — the
quiet failure, not the loud one. `approveExternalToolManifest` does persist the
column, so those NULLs are historical and the loud failure arrives with the next
re-approval; but "every call reported drift" was a claim about a state the
database was not in, and the table is what is actually true.

One inconsistency found while checking that, and named rather than fixed here:
`recordBaselinePins` writes `descriptionHash`, `schemaHash` and `manifestHash`
and omits `annotationsHash`, so a baseline pin never carries the axis. It changes
no behaviour today — external tools cannot reach that path (the resolver refuses
anything not `APPROVED`), and internal tools declare no annotations, so a stored
`NULL` and a stored `hash(null)` both verify `APPROVED`. It is the same
two-writers-disagreeing shape as the defect above and belongs in its own diff.

## Files

| file | role |
| --- | --- |
| `src/lib/mcp/tools/types.ts` | `McpReadTool.annotations?` — the field whose absence was the defect |
| `src/lib/mcp/tools/external-tools.ts` | the adapter forwards what the server declared |
| `src/app-layer/usecases/external-mcp-tools.ts` | `GrantedExternalTool.def` declares the field it already carried at runtime |
| `src/lib/mcp/authorize.ts` | passes the hints in; records a non-refusing security verdict instead of returning past it |
| `src/lib/observability/integration-metrics.ts` | the counter's description now covers both, since `status` already distinguishes them |
| `tests/unit/external-tool-annotations-reach-the-funnel.test.ts` | 10 assertions, including the discriminating-power property |

## Decisions

- **The fix CLEARS pins rather than invalidating them.** `manifestHash` does not
  fold annotations in (#2941's migration-safety property), and after this change
  the funnel hashes the same annotations the catalogue pinned — so every existing
  external pin starts matching on the axis that had been mismatching. Nothing
  needs re-approval. Internal tools set nothing and hash `null` on both sides,
  exactly as before.

- **`annotations` is forwarded UNCHANGED even when saved parameter sets have
  replaced the advertised `inputSchema`.** That asymmetry is deliberate.
  `inputSchema` is rewritten because it is what the MODEL reads, and with sets in
  force the model's only choice is a label. `annotations` is what the PIN hashes,
  and the pin was taken over what the server said — so narrowing it would
  reintroduce the mismatch, for exactly the tools a tenant has constrained most.

- **Still `mustRefuse: false`.** Refusing a tool whose name, description and
  schema all still match its pin, to enforce a field no dispatch yet reads, is
  the rung #2241 removed from the identity ladder: a gate that costs without
  protecting. What changed is that not refusing no longer means not observing.
  The line that makes it refuse is #2861's dispatch, when something reads the
  hint.

- **One counter, not two.** `recordToolManifestDrift` already carries a `status`
  attribute, which is the whole difference between a refusal and this. Adding a
  second metric would be two places to read for one question; what was wrong was
  the description claiming every count was a refusal.

- **The test asserts DISCRIMINATION, not just correctness.** `unchanged.status
  !== flipped.status` is the property that was missing — both cases returned
  `ANNOTATIONS_CHANGED` before. A detector whose output is identical in both
  worlds is zero evidence wearing a measurement's costume, and a test that only
  checked the flip case would have passed against the broken build.

- **Mutation-proved at the call site.** Dropping `annotations: tool.annotations`
  reddens 1 test; restoring the bare early return reddens 2. The tree was
  restored and md5-verified between the two, because the mechanism tests pass
  under both mutations — they always did, which is how this shipped.

## The same defect one layer up, closed in the same diff

`authorizeToolCall`'s `tool` parameter is a structural type that ENUMERATES the
fields the pin compares, and its own docstring says why: "Naming only what the
gate compares would have left the description out, which is the field the attack
uses." It did not name `annotations`.

That did not break the runtime. Both call sites pass `{ ...tool, … }`, and a
spread copies every own property, so the value arrives at the gate whether the
type mentions it or not. **Which is exactly the problem.** With the field absent
from the contract:

- the compiler cannot verify that any caller supplies it;
- `assertToolManifestPinned` reads `tool.annotations` and gets a real value only
  because of how the callers happen to be written;
- a future caller that builds the object field-by-field drops a pinned axis, and
  **`tsc` stays clean** — measured: removing the declaration leaves the build at
  exit 0 while reddening one test.

So it is declared, completing the enumeration the docstring already argued for.
The test asserts it against the parameter's own braces via `braceBlockAfter`, not
a whole-file needle — `annotations` appears many times in that file, and a
file-wide read would be satisfied by the call site another assertion already
covers.

Worth noting what was checked and found sound: the Flue adapter's `OfferableTool`
is a `Pick` that also omits `annotations`, but it never reaches the gate — the
engine calls `runReadTool(inv, name, args)` by NAME and the registry supplies the
object, so the Pick governs only the offering.

## Risk assessment and rollback

STANDARD. One optional interface field, one forwarded value, one definition
gaining a property, one early return gaining a branch, one metric description.
No schema change, no migration, no route, no new dependency. The only behavioural
change to a call is that a verdict already being computed now reaches a log line
and a counter; no call that previously succeeded can now fail — `mustRefuse` is
untouched, and the axis moves from always-mismatching to matching.

Rollback is reverting the commit. Pins on file remain valid either way: before
the change the funnel ignored the axis noisily, after it the axis agrees.
